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
//
// Generated pages are skipped: their generators run their own checks.
// Requires `npm run compile-tests` (the parser is loaded from out/).

import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";

const require = createRequire(import.meta.url);
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

function main() {
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
  main();
}
