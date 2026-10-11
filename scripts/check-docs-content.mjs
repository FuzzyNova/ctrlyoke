#!/usr/bin/env node
// Guardrails for the hand-written public docs (docs/**/*.md), run by `check:docs`.
//
// 1. Workflow examples: every fenced yaml/json block whose root is a workflow
//    (a `steps`, `prompt`, `finalStep`, or `type: script` root key) is validated
//    with the same parser the extension uses. Schema warnings fail too, because
//    an unknown key in a docs example teaches users a field that does nothing.
//    Put `<!-- no-validate -->` on the line before a fence to opt a deliberate
//    fragment or counter-example out.
// 2. Internal leakage: hand-written pages must not link internal `dev/` plans,
//    cite `ClassName.method()` internals, or mention the removed copilot-chat
//    harness.
// 3. Commands: `reference/commands.md` has a row for every contributed command
//    (palette commands as `ctrlyoke: Title` in backticks, menu-only ones by
//    plain title), every keybinding on its command's row, and no palette
//    command that package.json doesn't contribute.
// 4. CLI: `cli/ctrlyoke.md` has a `ctrlyoke <command>` heading for every
//    command (a subcommand may share its parent's), mentions every option in
//    that section or in the shared `run` options, and names no `--flag` the
//    CLI doesn't have. The command tree is read from the built CLI's `--help`.
//    The other CLI pages (`CLI_FLAG_PAGES`) get the unknown-flag check only.
//
// Generated pages are skipped: their generators run their own checks.
// Requires `npm run compile-tests` (the parser and CLI are loaded from out/).

import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS_DIR = resolve(ROOT_DIR, "docs");

/** Pages written by scripts/generate-*-docs.mjs. */
export const GENERATED_PAGES = new Set([
  "reference/workflow-schema.md",
  "reference/settings.md",
  "reference/run-files.md",
  "harnesses/compatibility.md",
]);

const SKIPPED_DIRS = new Set([".vitepress", "public", "node_modules"]);

export const NO_VALIDATE_MARKER = "<!-- no-validate -->";

const WORKFLOW_ROOT_KEYS = ["steps", "prompt", "finalStep"];

export const INTERNAL_LEAK_PATTERNS = [
  {
    pattern: /\bdev\/(?:active|backlog|bugs|implemented|reference|research)\//,
    reason: "links an internal dev/ document",
  },
  {
    pattern: /\b[A-Z][A-Za-z0-9]+\.[a-z][A-Za-z0-9]*\(\)/,
    reason: "cites an internal ClassName.method()",
  },
  {
    pattern: /\bcopilot-chat\b/,
    reason: "mentions the removed copilot-chat harness",
  },
];

/**
 * Fenced code blocks in a markdown page.
 * @returns {{ lang: string, body: string, line: number, optOut: boolean }[]}
 */
export function extractFencedBlocks(markdown) {
  const lines = markdown.split(/\r?\n/);
  const blocks = [];
  for (let index = 0; index < lines.length; index++) {
    const open = /^(\s*)(`{3,}|~{3,})\s*([\w-]*)/.exec(lines[index]);
    if (!open) continue;
    const [, indent, fence, lang] = open;
    const bodyLines = [];
    let end = index + 1;
    while (end < lines.length && !lines[end].trimStart().startsWith(fence)) {
      bodyLines.push(lines[end].slice(indent.length));
      end++;
    }
    let previous = index - 1;
    while (previous >= 0 && lines[previous].trim() === "") previous--;
    blocks.push({
      lang: lang.toLowerCase(),
      body: bodyLines.join("\n"),
      line: index + 1,
      optOut: previous >= 0 && lines[previous].trim() === NO_VALIDATE_MARKER,
    });
    index = end;
  }
  return blocks;
}

/** Whether a parsed example is a whole workflow rather than a fragment. */
export function isWorkflowExample(parsed) {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  return (
    WORKFLOW_ROOT_KEYS.some((key) => key in parsed) || parsed.type === "script"
  );
}

/** Lines of a page outside fenced code, with their 1-based line numbers. */
function proseLines(markdown) {
  const result = [];
  let fence;
  markdown.split(/\r?\n/).forEach((text, index) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(text);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (text.trimStart().startsWith(fence)) fence = undefined;
      return;
    }
    if (!fence) result.push({ text, line: index + 1 });
  });
  return result;
}

/** @returns {{ line: number, message: string }[]} */
export function findInternalLeaks(markdown) {
  const problems = [];
  for (const { text, line } of proseLines(markdown)) {
    for (const { pattern, reason } of INTERNAL_LEAK_PATTERNS) {
      if (pattern.test(text)) problems.push({ line, message: reason });
    }
  }
  return problems;
}

/**
 * `model` values in a workflow example that its harness does not know. The
 * harness is the step's own, else the workflow's; with neither, the example
 * runs on the user's default harness and the model can't be checked.
 * @param {(harness: string, model: string) => boolean | undefined} isKnownModel
 *   `undefined` when the harness's model list is dynamic and can't be checked.
 * @returns {string[]}
 */
export function findUnknownModels(workflow, isKnownModel) {
  const unknown = [];
  const check = (item, inheritedHarness, where) => {
    if (typeof item !== "object" || item === null) return;
    const harness =
      typeof item.harness === "string" ? item.harness : inheritedHarness;
    if (typeof item.model === "string" && harness) {
      if (isKnownModel(harness, item.model) === false) {
        unknown.push(
          `${where}: model '${item.model}' is not a ${harness} model`
        );
      }
    }
    return harness;
  };
  const rootHarness = check(workflow, undefined, "/");
  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  steps.forEach((step, index) => {
    if (Array.isArray(step?.parallel)) {
      step.parallel.forEach((member, memberIndex) =>
        check(member, rootHarness, `/steps/${index}/parallel/${memberIndex}`)
      );
    } else {
      check(step, rootHarness, `/steps/${index}`);
    }
  });
  check(workflow.finalStep, rootHarness, "/finalStep");
  return unknown;
}

/**
 * @param {(text: string, kind: string) => { issues: { instancePath: string, message: string }[] }} validate
 * @param {{ yaml: string, json: string }} kinds
 * @param {(harness: string, model: string) => boolean | undefined} isKnownModel
 * @returns {{ problems: { line: number, message: string }[], checked: number }}
 */
export function findInvalidExamples(markdown, validate, kinds, isKnownModel) {
  const problems = [];
  let checked = 0;
  for (const block of extractFencedBlocks(markdown)) {
    if (block.optOut) continue;
    const kind =
      block.lang === "yaml" || block.lang === "yml"
        ? kinds.yaml
        : block.lang === "json"
          ? kinds.json
          : undefined;
    if (!kind) continue;
    let parsed;
    try {
      parsed =
        kind === kinds.json ? JSON.parse(block.body) : loadYaml(block.body);
    } catch {
      continue; // Not parseable on its own: a fragment, not a workflow.
    }
    if (!isWorkflowExample(parsed)) continue;
    checked++;
    for (const issue of validate(block.body, kind).issues) {
      problems.push({
        line: block.line,
        message: `${issue.instancePath || "/"}: ${issue.message}`,
      });
    }
    for (const message of findUnknownModels(parsed, isKnownModel)) {
      problems.push({ line: block.line, message });
    }
  }
  return { problems, checked };
}

export const COMMANDS_PAGE = "reference/commands.md";

/** Palette `when` clauses that keep a command out of the user-facing reference. */
const UNDOCUMENTED_PALETTE_WHEN = new Set(["ctrlyoke.devMode"]);

/** `ctrl+shift+n` → `Ctrl+Shift+N`, as the commands page writes shortcuts. */
export function formatKeybinding(key) {
  return key
    .split("+")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("+");
}

/**
 * Two-way drift between `reference/commands.md` and `package.json`
 * `contributes`: every user-facing command and shortcut is documented, and
 * every documented palette command exists.
 * @returns {string[]}
 */
export function findCommandDrift(markdown, contributes) {
  const problems = [];
  const paletteWhen = new Map(
    (contributes.menus?.commandPalette ?? []).map((entry) => [
      entry.command,
      entry.when,
    ])
  );
  const lines = markdown.split(/\r?\n/);
  const paletteTitles = new Set();

  for (const command of contributes.commands ?? []) {
    const when = paletteWhen.get(command.command);
    if (UNDOCUMENTED_PALETTE_WHEN.has(when)) continue;
    const menuOnly = when === "false";
    const label = menuOnly
      ? command.title
      : `\`${command.category ? `${command.category}: ` : ""}${command.title}\``;
    if (!menuOnly) paletteTitles.add(label);
    const pattern = new RegExp(`^\\|\\s*${escapeRegExp(label)}\\s*\\|`);
    if (!lines.some((line) => pattern.test(line))) {
      problems.push(
        `${command.command} (${label}) has no row in the ${menuOnly ? "menu-item" : "command"} tables`
      );
    }
  }

  for (const binding of contributes.keybindings ?? []) {
    const command = (contributes.commands ?? []).find(
      (candidate) => candidate.command === binding.command
    );
    if (!command) continue;
    const row = lines.find((line) => line.includes(command.title));
    const keys = [binding.key, binding.mac]
      .filter(Boolean)
      .map(formatKeybinding);
    if (!row || !keys.every((key) => row.includes(key))) {
      problems.push(
        `${binding.command} shortcut ${keys.join(" / ")} is missing from its row`
      );
    }
  }

  lines.forEach((line, index) => {
    const cell = /^\|\s*(`ctrlyoke: [^`]+`)\s*\|/.exec(line);
    if (cell && !paletteTitles.has(cell[1])) {
      problems.push(
        `line ${index + 1}: ${cell[1]} is not a contributed palette command`
      );
    }
  });
  return problems;
}

export const CLI_PAGE = "cli/ctrlyoke.md";

/**
 * Other pages whose code spans name ctrlyoke flags. `cli/ctrlyoke-mcp.md` is
 * a different binary, and harness pages quote the harnesses' own flags.
 */
const CLI_FLAG_PAGES = new Set([
  "cli/index.md",
  "cli/ci.md",
  "cli/server.md",
  "troubleshooting/common-errors.md",
]);

/** The command whose options table documents the shared execution options. */
const SHARED_OPTIONS_COMMAND = "run";

/** Flags every command has; the page needn't list them per command. */
const IMPLICIT_FLAGS = new Set(["--help", "--version"]);

/**
 * Subcommand names and long option flags from one commander `--help` output.
 * @returns {{ commands: string[], options: string[] }}
 */
export function parseCliHelp(text) {
  const commands = [];
  const options = [];
  let section;
  for (const line of text.split(/\r?\n/)) {
    if (/^Commands:/.test(line)) section = "commands";
    else if (/^Options:/.test(line)) section = "options";
    else if (/^\S/.test(line)) section = undefined;
    else if (section === "commands") {
      const name = /^ {2}([a-z][\w-]*)/.exec(line)?.[1];
      if (name && name !== "help") commands.push(name);
    } else if (section === "options") {
      const flags = /^ {2}(-\S.*?)(?: {2}|$)/.exec(line)?.[1];
      for (const match of flags?.matchAll(/--[a-z][\w-]*/g) ?? []) {
        if (!IMPLICIT_FLAGS.has(match[0])) options.push(match[0]);
      }
    }
  }
  return { commands, options };
}

/**
 * Walk the CLI's command tree through `--help`.
 * @param {(path: string[]) => Promise<string>} readHelp
 * @returns {Promise<Map<string, string[]>>} command path ("history show") → long flags
 */
export async function readCliTree(readHelp) {
  const tree = new Map();
  const visit = async (path) => {
    const { commands, options } = parseCliHelp(await readHelp(path));
    if (path.length > 0) tree.set(path.join(" "), options);
    await Promise.all(commands.map((name) => visit([...path, name])));
  };
  await visit([]);
  return tree;
}

/** Text under each `ctrlyoke <command>` heading, keyed by command path. */
function cliSections(markdown) {
  const sections = new Map();
  let current;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^#{1,6} `ctrlyoke(?: ([^`]+))?`\s*$/.exec(line);
    if (heading) current = heading[1];
    if (current !== undefined) {
      sections.set(current, `${sections.get(current) ?? ""}${line}\n`);
    }
  }
  return sections;
}

const SHELL_FENCE_LANGS = new Set([
  "bash",
  "sh",
  "shell",
  "console",
  "powershell",
]);

const LONG_FLAG = /--[a-z][\w-]*/g;

/**
 * Every long flag the page presents as a ctrlyoke flag: in inline code in
 * prose, and on `ctrlyoke` command lines in shell examples.
 * @returns {Set<string>}
 */
export function documentedCliFlags(markdown) {
  const flags = new Set();
  const add = (text) => {
    for (const match of text.matchAll(LONG_FLAG)) flags.add(match[0]);
  };
  for (const { text } of proseLines(markdown)) {
    for (const span of text.matchAll(/`([^`]+)`/g)) add(span[1]);
  }
  for (const block of extractFencedBlocks(markdown)) {
    if (!SHELL_FENCE_LANGS.has(block.lang)) continue;
    for (const line of block.body.split("\n")) {
      if (/^\s*(?:\$\s+)?(?:npx\s+)?ctrlyoke\s/.test(line)) add(line);
    }
  }
  return flags;
}

/**
 * Drift between the CLI reference page and the CLI's real command tree.
 * @param {Map<string, string[]>} tree from {@link readCliTree}
 * @returns {string[]}
 */
export function findCliDrift(markdown, tree) {
  const problems = [];
  const sections = cliSections(markdown);
  const shared = sections.get(SHARED_OPTIONS_COMMAND) ?? "";
  for (const [command, options] of tree) {
    const words = command.split(" ");
    let section;
    for (let length = words.length; length > 0 && !section; length--) {
      section = sections.get(words.slice(0, length).join(" "));
    }
    // A pure group such as `history` has no options of its own; its
    // subcommands are checked individually.
    const isGroup =
      options.length === 0 &&
      [...tree.keys()].some((other) => other.startsWith(`${command} `));
    if (section === undefined) {
      if (!isGroup) problems.push(`\`ctrlyoke ${command}\` has no heading`);
      continue;
    }
    for (const option of options) {
      if (!section.includes(option) && !shared.includes(option)) {
        problems.push(
          `\`ctrlyoke ${command}\` option ${option} is not documented`
        );
      }
    }
  }
  return [...problems, ...findUnknownCliFlags(markdown, tree)];
}

/**
 * Flags a page presents as ctrlyoke flags that no command has.
 * @param {Map<string, string[]>} tree from {@link readCliTree}
 * @returns {string[]}
 */
export function findUnknownCliFlags(markdown, tree) {
  const known = new Set([...tree.values()].flat());
  return [...documentedCliFlags(markdown)]
    .filter((flag) => !known.has(flag) && !IMPLICIT_FLAGS.has(flag))
    .map((flag) => `${flag} is not an option of any ctrlyoke command`);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function listPages(dir) {
  const pages = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) pages.push(...listPages(full));
    else if (entry.name.endsWith(".md")) pages.push(full);
  }
  return pages;
}

async function main() {
  const { PromptFileParser } = require(
    resolve(ROOT_DIR, "out/core/PromptFileParser.js")
  );
  const { CTRLYOKE_FILE_KINDS, HARNESS_IDS } = require(
    resolve(ROOT_DIR, "out/types/DashboardConstants.js")
  );
  const models = require(resolve(ROOT_DIR, "out/utils/ModelConstants.js"));
  // OpenCode, Qwen and Antigravity model lists are discovered from the
  // installed CLI or the user's provider config, so they can't be checked here.
  const modelCheckers = {
    [HARNESS_IDS.COPILOT_CLI]: (model) => models.isKnownCopilotModel(model),
    [HARNESS_IDS.CLAUDE_CLI]: (model) =>
      models.getClaudeModelName(model) !== undefined,
    [HARNESS_IDS.CODEX_CLI]: (model) => models.CODEX_CLI_MODELS.includes(model),
  };
  const isKnownModel = (harness, model) =>
    model === models.MODEL_NONE ? true : modelCheckers[harness]?.(model);
  const parser = new PromptFileParser();
  const validate = (text, kind) => parser.validateWorkflowText(text, kind);
  const kinds = {
    yaml: CTRLYOKE_FILE_KINDS.WORKFLOW_YAML,
    json: CTRLYOKE_FILE_KINDS.WORKFLOW_JSON,
  };
  const cliPath = resolve(ROOT_DIR, "out/cli.js");
  const cliTree = await readCliTree(async (path) => {
    // Wide columns keep each option's flags on one line.
    const { stdout } = await execFileAsync(
      process.execPath,
      [cliPath, ...path, "--help"],
      { cwd: ROOT_DIR, env: { ...process.env, COLUMNS: "200", NO_COLOR: "1" } }
    );
    return stdout;
  });

  const failures = [];
  let examples = 0;
  for (const page of listPages(DOCS_DIR)) {
    const name = relative(DOCS_DIR, page).split(sep).join("/");
    if (GENERATED_PAGES.has(name)) continue;
    const markdown = readFileSync(page, "utf8");
    const { problems, checked } = findInvalidExamples(
      markdown,
      validate,
      kinds,
      isKnownModel
    );
    examples += checked;
    for (const problem of [...findInternalLeaks(markdown), ...problems]) {
      failures.push(`docs/${name}:${problem.line}: ${problem.message}`);
    }
    if (name === COMMANDS_PAGE) {
      const { contributes } = JSON.parse(
        readFileSync(resolve(ROOT_DIR, "package.json"), "utf8")
      );
      for (const message of findCommandDrift(markdown, contributes)) {
        failures.push(`docs/${name}: ${message}`);
      }
    }
    const cliMessages =
      name === CLI_PAGE
        ? findCliDrift(markdown, cliTree)
        : CLI_FLAG_PAGES.has(name)
          ? findUnknownCliFlags(markdown, cliTree)
          : [];
    for (const message of cliMessages) {
      failures.push(`docs/${name}: ${message}`);
    }
  }

  if (failures.length > 0) {
    console.error(
      `[check-docs-content] ${failures.length} problem(s) in hand-written docs:`
    );
    for (const failure of failures) console.error(`  ${failure}`);
    console.error(
      `Fix the page, or put ${NO_VALIDATE_MARKER} on the line before a deliberate fragment.`
    );
    process.exit(1);
  }
  console.log(
    `[check-docs-content] hand-written docs OK (${examples} workflow examples validated)`
  );
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
