import assert from "node:assert/strict";
import test from "node:test";

import {
  NO_VALIDATE_MARKER,
  documentedCliFlags,
  extractFencedBlocks,
  findCliDrift,
  findCommandDrift,
  findInternalLeaks,
  findInvalidExamples,
  findUnknownModels,
  formatKeybinding,
  isWorkflowExample,
  parseCliHelp,
  readCliTree,
} from "./check-docs-content.mjs";

const FENCE = "```";
const KINDS = { yaml: "workflowYaml", json: "workflowJson" };

function page(...lines) {
  return lines.join("\n");
}

/** A validator that records what it saw and reports one issue per call. */
function recordingValidator() {
  const calls = [];
  const validate = (text, kind) => {
    calls.push({ text, kind });
    return { issues: [{ instancePath: "/x", message: "bad" }] };
  };
  return { calls, validate };
}

const allModelsKnown = () => true;

test("extractFencedBlocks reads language, body, line and opt-out", () => {
  const blocks = extractFencedBlocks(
    page(
      "# Title",
      "",
      NO_VALIDATE_MARKER,
      "",
      `${FENCE}yaml`,
      "steps: []",
      FENCE,
      `${FENCE}json`,
      "{}",
      FENCE
    )
  );
  assert.deepEqual(
    blocks.map(({ lang, body, line, optOut }) => ({
      lang,
      body,
      line,
      optOut,
    })),
    [
      { lang: "yaml", body: "steps: []", line: 5, optOut: true },
      { lang: "json", body: "{}", line: 8, optOut: false },
    ]
  );
});

test("isWorkflowExample accepts whole workflows and rejects fragments", () => {
  assert.equal(isWorkflowExample({ steps: [] }), true);
  assert.equal(isWorkflowExample({ prompt: "hi" }), true);
  assert.equal(isWorkflowExample({ finalStep: { prompt: "hi" } }), true);
  assert.equal(isWorkflowExample({ type: "script", script: "ls" }), true);
  assert.equal(isWorkflowExample({ endCondition: { script: "ls" } }), false);
  assert.equal(isWorkflowExample([{ prompt: "hi" }]), false);
  assert.equal(isWorkflowExample("steps"), false);
});

test("findInvalidExamples validates only workflow blocks that are not opted out", () => {
  const { calls, validate } = recordingValidator();
  const { problems, checked } = findInvalidExamples(
    page(
      `${FENCE}yaml`,
      "steps:",
      "  - prompt: hi",
      FENCE,
      `${FENCE}yaml`,
      "endCondition:",
      "  script: npm test",
      FENCE,
      NO_VALIDATE_MARKER,
      `${FENCE}json`,
      '{ "steps": [] }',
      FENCE,
      `${FENCE}bash`,
      "steps: []",
      FENCE,
      `${FENCE}yaml`,
      "steps: [unclosed",
      FENCE
    ),
    validate,
    KINDS,
    allModelsKnown
  );
  assert.equal(checked, 1);
  assert.deepEqual(calls, [
    { text: "steps:\n  - prompt: hi", kind: KINDS.yaml },
  ]);
  assert.deepEqual(problems, [{ line: 1, message: "/x: bad" }]);
});

test("findInvalidExamples reports unknown models at the block line", () => {
  const { problems } = findInvalidExamples(
    page(
      "intro",
      `${FENCE}yaml`,
      "harness: codex-cli",
      "model: not-a-model",
      "steps: []",
      FENCE
    ),
    () => ({ issues: [] }),
    KINDS,
    (_harness, model) => model !== "not-a-model"
  );
  assert.deepEqual(problems, [
    { line: 2, message: "/: model 'not-a-model' is not a codex-cli model" },
  ]);
});

test("findUnknownModels resolves each step's harness and skips unknowable ones", () => {
  const seen = [];
  const unknown = findUnknownModels(
    {
      harness: "claude-cli",
      model: "sonnet",
      steps: [
        { model: "gpt-9" },
        { harness: "opencode-cli", model: "any/thing" },
        { parallel: [{ model: "bogus" }, { prompt: "no model" }] },
      ],
      finalStep: { harness: "codex-cli", model: "bogus" },
    },
    (harness, model) => {
      seen.push(`${harness}:${model}`);
      if (harness === "opencode-cli") return undefined;
      return model === "sonnet";
    }
  );
  assert.deepEqual(seen, [
    "claude-cli:sonnet",
    "claude-cli:gpt-9",
    "opencode-cli:any/thing",
    "claude-cli:bogus",
    "codex-cli:bogus",
  ]);
  assert.deepEqual(unknown, [
    "/steps/0: model 'gpt-9' is not a claude-cli model",
    "/steps/2/parallel/0: model 'bogus' is not a claude-cli model",
    "/finalStep: model 'bogus' is not a codex-cli model",
  ]);
});

test("findUnknownModels skips models when no harness is named", () => {
  assert.deepEqual(
    findUnknownModels({ model: "anything", steps: [] }, () => false),
    []
  );
});

test("findInternalLeaks flags dev links, internal methods and copilot-chat outside code", () => {
  const problems = findInternalLeaks(
    page(
      "See dev/implemented/SOME_PLAN.md for details.",
      "Handled by WorkflowExecutor.runStep() internally.",
      "The copilot-chat harness is gone.",
      `${FENCE}text`,
      "dev/backlog/IGNORED.md inside a code block",
      FENCE,
      "Plain prose about steps."
    )
  );
  assert.deepEqual(problems, [
    { line: 1, message: "links an internal dev/ document" },
    { line: 2, message: "cites an internal ClassName.method()" },
    { line: 3, message: "mentions the removed copilot-chat harness" },
  ]);
});

const CONTRIBUTES = {
  commands: [
    { command: "ctrlyoke.run", title: "Run", category: "ctrlyoke" },
    {
      command: "ctrlyoke.clear",
      title: "New Blank Workflow",
      category: "ctrlyoke",
    },
    {
      command: "ctrlyoke.addFile",
      title: "Add File to ctrlyoke",
      category: "ctrlyoke",
    },
    { command: "ctrlyoke.dev", title: "Developer Tools", category: "ctrlyoke" },
  ],
  menus: {
    commandPalette: [
      { command: "ctrlyoke.addFile", when: "false" },
      { command: "ctrlyoke.dev", when: "ctrlyoke.devMode" },
    ],
  },
  keybindings: [
    { command: "ctrlyoke.clear", key: "ctrl+shift+n", mac: "cmd+shift+n" },
  ],
};

test("formatKeybinding capitalizes each key", () => {
  assert.equal(formatKeybinding("ctrl+shift+n"), "Ctrl+Shift+N");
});

test("findCommandDrift accepts a page that matches package.json", () => {
  const markdown = page(
    "| `ctrlyoke: Run` | Run it |",
    "| `ctrlyoke: New Blank Workflow` | Clear | `Ctrl+Shift+N` / `Cmd+Shift+N` |",
    "| Add File to ctrlyoke | Explorer |"
  );
  assert.deepEqual(findCommandDrift(markdown, CONTRIBUTES), []);
});

test("findCommandDrift reports missing rows, shortcuts and phantom commands", () => {
  const markdown = page(
    "| `ctrlyoke: New Blank Workflow` | Clear |",
    "| `ctrlyoke: Does Not Exist` | Nothing |"
  );
  assert.deepEqual(findCommandDrift(markdown, CONTRIBUTES), [
    "ctrlyoke.run (`ctrlyoke: Run`) has no row in the command tables",
    "ctrlyoke.addFile (Add File to ctrlyoke) has no row in the menu-item tables",
    "ctrlyoke.clear shortcut Ctrl+Shift+N / Cmd+Shift+N is missing from its row",
    "line 2: `ctrlyoke: Does Not Exist` is not a contributed palette command",
  ]);
});

const ROOT_HELP = page(
  "Usage: ctrlyoke [options] [command]",
  "",
  "Options:",
  "  -V, --version   output the version number",
  "  -h, --help      display help for command",
  "",
  "Commands:",
  "  run [options] [file]   Execute a workflow",
  "  secret                 Manage named secrets",
  "  help [command]         display help for command"
);

const HELP_BY_PATH = {
  "": ROOT_HELP,
  run: page(
    "Options:",
    "  -H, --harness <harness>  Harness override",
    "                           wrapped description line --not-a-flag",
    "  --no-color               Disable colour",
    "  -h, --help               display help for command"
  ),
  secret: page("Commands:", "  rm [options] <NAME>  Remove a secret"),
  "secret rm": page("Options:", "  -y, --yes  Skip the prompt"),
};

test("parseCliHelp reads subcommands and long flags, skipping help and wrapped text", () => {
  assert.deepEqual(parseCliHelp(ROOT_HELP), {
    commands: ["run", "secret"],
    options: [],
  });
  assert.deepEqual(parseCliHelp(HELP_BY_PATH.run), {
    commands: [],
    options: ["--harness", "--no-color"],
  });
});

test("readCliTree walks every subcommand", async () => {
  const tree = await readCliTree(async (path) => HELP_BY_PATH[path.join(" ")]);
  assert.deepEqual(Object.fromEntries(tree), {
    run: ["--harness", "--no-color"],
    secret: [],
    "secret rm": ["--yes"],
  });
});

const CLI_TREE = new Map([
  ["run", ["--harness", "--no-color"]],
  ["rerun", ["--harness", "--from"]],
  ["secret", []],
  ["secret rm", ["--yes"]],
]);

test("findCliDrift accepts shared run options and parent sections", () => {
  const markdown = page(
    "# `ctrlyoke`",
    "## `ctrlyoke run`",
    "| `-H, --harness <harness>` | Harness |",
    "| `--no-color` | Plain output |",
    "## `ctrlyoke rerun`",
    "`--from` picks the source run.",
    "## `ctrlyoke secret`",
    "`secret rm` asks first unless you pass `--yes`."
  );
  assert.deepEqual(findCliDrift(markdown, CLI_TREE), []);
});

test("findCliDrift reports missing headings, undocumented options and phantom flags", () => {
  const markdown = page(
    "## `ctrlyoke run`",
    "| `--harness` | Harness |",
    "| `--allow-all-tools` | Removed long ago |",
    "",
    FENCE + "bash",
    "ctrlyoke run --resume abc",
    "copilot --not-ours",
    FENCE
  );
  assert.deepEqual(findCliDrift(markdown, CLI_TREE), [
    "`ctrlyoke run` option --no-color is not documented",
    "`ctrlyoke rerun` has no heading",
    "`ctrlyoke secret rm` has no heading",
    "--allow-all-tools is not an option of any ctrlyoke command",
    "--resume is not an option of any ctrlyoke command",
  ]);
});

test("documentedCliFlags ignores other tools' flags in shell examples", () => {
  const flags = documentedCliFlags(
    page(
      FENCE + "bash",
      "npm install --global ctrlyoke",
      "ctrlyoke run --json",
      "$ npx ctrlyoke validate --strict",
      FENCE
    )
  );
  assert.deepEqual([...flags], ["--json", "--strict"]);
});
