// One-off migration for the pre-release schema changes that shipped without a
// compatibility shim:
//
//   - dev/implemented/SCHEMA_UI_NAME_ALIGNMENT_PLAN.md (settings key renames,
//     passthrough → none, onError stop → stopWorkflow, off/never → none,
//     defaults.worktree shape)
//   - dev/implemented/SCRIPT_COMPARISON_REDESIGN_PLAN.md (returns → expected +
//     operator, compareSource auto removed)
//   - a few older leftovers that still make files fail the current schemas
//     (empty worktree.base written by the old UI, mcpAvailability, ui.stepColors)
//
//   settings  — ~/.ctrlyoke/settings.json and <workspace>/.ctrlyoke/settings.json
//   history   — every run's / draft's workflow.ctrlyoke.json under the run-history roots
//   workflow  — authored workflow files (.ctrlyoke.yaml/.yml/.json, .prompt.md frontmatter)
//
// Dry run by default; pass --write to modify files. Delete this script once every
// workspace has been migrated.
//
// Usage:
//   node dev/scripts/migrate-schema-ui-alignment.mjs settings [file...] [--write]
//   node dev/scripts/migrate-schema-ui-alignment.mjs history  [dir...]  [--write] [--prune]
//   node dev/scripts/migrate-schema-ui-alignment.mjs workflow <file|dir...> [--write]
//   node dev/scripts/migrate-schema-ui-alignment.mjs all [--write] [--prune]
//
// Options:
//   --workspace <dir>  Workspace root used for default paths (default: cwd).
//   --write            Apply changes (otherwise only report them).
//   --prune            History only: delete runs whose working copy still fails the
//                      workflow schema after migration (e.g. the removed copilot-chat
//                      harness). A lineage whose every run fails is deleted whole; a
//                      lineage's latest run is never deleted on its own.
//   --no-validate      Skip the post-migration schema validation report (and --prune).
//   --verbose          List schema errors for every still-invalid history file
//                      (history prints only a count by default).
//
// Defaults when no paths are given:
//   settings: ~/.ctrlyoke/settings.json, <workspace>/.ctrlyoke/settings.json
//   history:  <state home>/projects (state home = $CTRLYOKE_HOME or ~/.ctrlyoke),
//             <workspace>/.ctrlyoke/.runs (workspace-mode history), and
//             <workspace>/.ctrlyoke-dev-home/projects (dev-host isolated state)
//   workflow: <workspace>
//   all:      all three of the above
//
// Script comparisons are rewritten to reproduce what the pre-redesign evaluator
// actually did (see `migrateComparison`). Where that evaluator guessed — stdout
// text matched exactly-or-as-substring, numbers compared with >=, stdout also
// required exit 0 — the result is flagged REVIEW so you can tighten it by hand.
//
// JSON files are edited in place with jsonc-parser so formatting and comments
// survive. YAML edits are applied line-by-line inside the owning mapping block,
// then verified by re-parsing; a file whose edit does not reproduce the expected
// object is reported for manual fixing instead of written.
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  statSync,
  rmSync,
} from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import * as jsonc from "jsonc-parser";
import * as yaml from "js-yaml";
import Ajv from "ajv";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Workflow rules — applied recursively to a workflow (or settings `defaults`)
// ---------------------------------------------------------------------------

const CONDITION_KEYS = new Set(["endCondition", "preCondition"]);

function migrateWorkflowNode(node, path, edits) {
  if (Array.isArray(node)) {
    node.forEach((item, index) =>
      migrateWorkflowNode(item, [...path, index], edits)
    );
    return;
  }
  if (!isPlainObject(node)) return;

  migrateComparison(
    node,
    path,
    CONDITION_KEYS.has(path[path.length - 1]) ? "condition" : "step",
    edits
  );

  for (const [key, value] of Object.entries(node)) {
    const keyPath = [...path, key];

    // Alignment H1: toolPermissions.mode passthrough → none
    if (
      key === "toolPermissions" &&
      isPlainObject(value) &&
      value.mode === "passthrough"
    ) {
      setValue(
        value,
        "mode",
        "none",
        [...keyPath, "mode"],
        edits,
        `${formatPath(keyPath)}.mode passthrough → none`
      );
    }

    // Alignment H3: errorBehavior.onError stop → stopWorkflow
    if (
      key === "errorBehavior" &&
      isPlainObject(value) &&
      value.onError === "stop"
    ) {
      setValue(
        value,
        "onError",
        "stopWorkflow",
        [...keyPath, "onError"],
        edits,
        `${formatPath(keyPath)}.onError stop → stopWorkflow`
      );
    }

    if (key === "worktree" && isPlainObject(value)) {
      // Alignment H2b: the "none" worktree mode no longer exists
      if (value.mode === "none") {
        setValue(
          node,
          key,
          false,
          keyPath,
          edits,
          `${formatPath(keyPath)} { mode: none } → false`
        );
        continue;
      }
      // Older UI wrote base: "" for "no base ref"; the schema requires minLength 1.
      if (value.base === "") {
        removeKey(
          value,
          "base",
          [...keyPath, "base"],
          edits,
          `remove empty ${formatPath(keyPath)}.base`
        );
      }
    }

    migrateWorkflowNode(node[key], keyPath, edits);
  }
}

// Pre-redesign stage-2 boolean synonyms (SCRIPT_BOOLEAN_OUTPUT_VALUES at 069ceadf^).
const BOOLEAN_SYNONYMS = {
  true: ["true", "1", "yes", "pass", "passed"],
  false: ["false", "0", "no", "fail", "failed"],
};

/**
 * Script comparison redesign: `returns` → `expected` + explicit `operator`, and
 * `compareSource: auto` removed. The mapping reproduces the old evaluator
 * (EndConditionEvaluator.evaluateSuccess/checkResult at 069ceadf^):
 *
 *   - Conditions defaulted to `auto`; script steps to `exitCode` with returns "0".
 *   - No `returns` → pass on exit 0 (unchanged: the new default).
 *   - `auto` + "true"/"false" → exit code. "true" is now the default (dropped);
 *     "false" becomes `operator: ne`, `expected: "0"`.
 *   - `auto` + anything else → stdout.
 *   - `exitCode` + N → `expected: N`.
 *   - stdout/stderr + text → the old waterfall matched exact-or-substring,
 *     lowercased: `contains` + `ignoreCase: true` (REVIEW: maybe `eq`).
 *   - stdout/stderr + number → the old waterfall used parseFloat(actual) >= N:
 *     `gte` (REVIEW: the new comparator needs the whole output to be numeric).
 *     Text that merely starts with a number ("0 failing") also hit that numeric
 *     stage, but was plainly meant as text, so it takes the `contains` path.
 *   - stdout/stderr + "true"/"false" → the boolean synonym list, as a
 *     case-insensitive `matches` regex (`ignoreCase` does not apply to regexes).
 *   - stdout (and auto → stdout) also required exit 0; that has no equivalent
 *     now (REVIEW).
 */
function migrateComparison(obj, path, kind, edits) {
  if (typeof obj.script !== "string") return;
  const hasReturns = "returns" in obj;
  if (!hasReturns && obj.compareSource !== "auto") return;

  const where = formatPath(path) || "(root)";
  if ("expected" in obj || "operator" in obj) {
    // Half-migrated by hand: keep the new fields, drop the stale ones.
    if (hasReturns) {
      removeKey(
        obj,
        "returns",
        [...path, "returns"],
        edits,
        `${where}: remove stale returns (expected/operator already set)`
      );
    }
    if (obj.compareSource === "auto") {
      removeKey(
        obj,
        "compareSource",
        [...path, "compareSource"],
        edits,
        `${where}: remove compareSource auto`
      );
    }
    return;
  }

  const raw = hasReturns ? String(obj.returns).trim() : undefined;
  const lower = raw?.toLowerCase();
  const isBoolean = lower === "true" || lower === "false";
  let source = obj.compareSource ?? (kind === "step" ? "exitCode" : "auto");
  const target = {};
  const review = [];
  if (source === "auto" && raw === "0") {
    // `returns: "0"` under auto meant "stdout contains/>= 0 and exit 0", which
    // authors wrote to mean "exits 0" (e.g. `script: npm test`). A literal
    // `stdout gte 0` would now fail on any non-numeric output.
    source = "exitCode";
    review.push(
      'auto "0" read stdout (>= 0 or contains "0") and required exit 0; migrated to plain exit code 0'
    );
  } else if (source === "auto" && raw !== undefined) {
    source = isBoolean ? "exitCode" : "stdout";
  }

  if (raw !== undefined) {
    if (source === "exitCode") {
      if (lower === "false") {
        target.operator = "ne";
        target.expected = "0";
      } else if (lower !== "true" && raw !== "0") {
        // "true" and "0" both mean exit 0, which is the default with no expected.
        target.expected = raw;
      }
      if (obj.compareSource === "exitCode") target.compareSource = "exitCode";
    } else {
      target.compareSource = source;
      if (isBoolean) {
        target.operator = "matches";
        target.expected = caseInsensitiveWordPattern(BOOLEAN_SYNONYMS[lower]);
      } else if (raw !== "" && Number.isFinite(Number(raw))) {
        target.operator = "gte";
        target.expected = raw;
        review.push(
          `old ${source} "${raw}" passed when the output's leading number was >= ${raw}; ` +
            "gte now needs the whole output to be a number — use eq/contains if that is what you meant"
        );
      } else {
        target.operator = "contains";
        target.expected = raw;
        target.ignoreCase = true;
        review.push(
          `old ${source} "${raw}" matched exactly or as a substring, case-insensitively; tighten to eq if you meant equality`
        );
      }
      if (source === "stdout") {
        review.push(
          "old stdout comparisons also required exit code 0; that check no longer exists"
        );
      }
    }
  }
  if (target.expected === undefined) delete target.compareSource;

  const summary =
    raw === undefined
      ? `${where}: remove compareSource auto (pass on exit 0)`
      : `${where}: returns "${raw}" → ${describeComparison(target)}`;
  if (hasReturns) {
    removeKey(obj, "returns", [...path, "returns"], edits, summary, review);
  }
  for (const key of ["compareSource", "operator", "expected", "ignoreCase"]) {
    if (target[key] === undefined) {
      if (key in obj) {
        removeKey(obj, key, [...path, key], edits, hasReturns ? null : summary);
      }
    } else if (obj[key] !== target[key]) {
      setValue(obj, key, target[key], [...path, key], edits, null);
    }
  }
}

function describeComparison(target) {
  if (target.expected === undefined) return "exit code 0 (default)";
  const source = target.compareSource ?? "exitCode";
  const operator = target.operator ?? "eq";
  return `${source} ${operator} ${JSON.stringify(target.expected)}${target.ignoreCase ? " (ignoreCase)" : ""}`;
}

/** `^([Tt][Rr][Uu][Ee]|1|...)$` — regexes cannot take ignoreCase. */
function caseInsensitiveWordPattern(words) {
  const alternatives = words.map((word) =>
    [...word]
      .map((char) =>
        /[a-z]/.test(char) ? `[${char.toUpperCase()}${char}]` : char
      )
      .join("")
  );
  return `^(${alternatives.join("|")})$`;
}

// ---------------------------------------------------------------------------
// Settings rules
// ---------------------------------------------------------------------------

function migrateSettings(settings, edits) {
  if (!isPlainObject(settings)) return;

  // Alignment key renames (H10, H7, H12, M11)
  renameKey(
    settings,
    ["permissions"],
    "allowedExternalFileRoots",
    "trustedExternalRoots",
    edits
  );
  renameKey(
    settings,
    ["execution"],
    "strictContextResolution",
    "contextResolutionFailure",
    edits
  );
  renameKey(settings, ["server"], "enabled", "autoStart", edits);
  renameKey(settings, ["commit"], "prompt", "systemPrompt", edits);

  // Alignment H5: ui.hideCost → ui.showCostEstimates (inverted)
  const ui = settings.ui;
  if (isPlainObject(ui) && "hideCost" in ui) {
    const hideCost = ui.hideCost;
    if (!("showCostEstimates" in ui) && typeof hideCost === "boolean") {
      setValue(
        ui,
        "showCostEstimates",
        !hideCost,
        ["ui", "showCostEstimates"],
        edits,
        `ui.hideCost ${hideCost} → ui.showCostEstimates ${!hideCost}`
      );
    }
    removeKey(ui, "hideCost", ["ui", "hideCost"], edits, "remove ui.hideCost");
  }

  // Alignment H8: "off"/"never" → "none"
  replaceValue(settings, ["ui", "stepColorMode"], "off", "none", edits);
  replaceValue(settings, ["notifications", "toastLevel"], "off", "none", edits);
  replaceValue(
    settings,
    ["notifications", "events", "workflowComplete"],
    "never",
    "none",
    edits
  );
  replaceValue(
    settings,
    ["notifications", "events", "promptComplete"],
    "never",
    "none",
    edits
  );

  // Older: mcpAvailability auto/disabled → ctrlyokeMcpMode native/skill (260da25f)
  if ("mcpAvailability" in settings) {
    const legacy = settings.mcpAvailability;
    const mapped =
      legacy === "disabled"
        ? "skill"
        : legacy === "auto"
          ? "native"
          : undefined;
    if (!("ctrlyokeMcpMode" in settings) && mapped) {
      setValue(
        settings,
        "ctrlyokeMcpMode",
        mapped,
        ["ctrlyokeMcpMode"],
        edits,
        `mcpAvailability ${legacy} → ctrlyokeMcpMode ${mapped}`
      );
    }
    removeKey(
      settings,
      "mcpAvailability",
      ["mcpAvailability"],
      edits,
      "remove mcpAvailability"
    );
  }

  // Older: ui.stepColors → ui.harnessColors (+ stepColorMode) (ee3350d3)
  if (isPlainObject(ui) && isPlainObject(ui.stepColors)) {
    const legacy = ui.stepColors;
    if (!("harnessColors" in ui)) {
      const harnessColors = {};
      if (isPlainObject(legacy.byHarness))
        harnessColors.byHarness = legacy.byHarness;
      if (typeof legacy.script === "string")
        harnessColors.script = legacy.script;
      setValue(
        ui,
        "harnessColors",
        harnessColors,
        ["ui", "harnessColors"],
        edits,
        "ui.stepColors → ui.harnessColors"
      );
      if (legacy.enabled === true && !("stepColorMode" in ui)) {
        setValue(
          ui,
          "stepColorMode",
          "harness",
          ["ui", "stepColorMode"],
          edits,
          "ui.stepColors.enabled → ui.stepColorMode harness"
        );
      }
    }
    removeKey(
      ui,
      "stepColors",
      ["ui", "stepColors"],
      edits,
      "remove ui.stepColors"
    );
  }

  const defaults = settings.defaults;
  if (!isPlainObject(defaults)) return;

  // Alignment H2b: defaults.worktree now uses the workflow worktreeConfig shape.
  const worktree = defaults.worktree;
  if (isPlainObject(worktree)) {
    const mode = worktree.mode ?? "none";
    if (mode === "none") {
      setValue(
        defaults,
        "worktree",
        false,
        ["defaults", "worktree"],
        edits,
        "defaults.worktree { mode: none } → false"
      );
    } else {
      if (!("mode" in worktree)) {
        setValue(
          worktree,
          "mode",
          mode,
          ["defaults", "worktree", "mode"],
          edits,
          `defaults.worktree.mode → ${mode}`
        );
      }
      const disallowed =
        mode === "managed"
          ? ["branch"]
          : mode === "named"
            ? ["keep", "merge"]
            : [];
      for (const key of disallowed) {
        if (key in worktree) {
          removeKey(
            worktree,
            key,
            ["defaults", "worktree", key],
            edits,
            `remove defaults.worktree.${key} (not valid for mode ${mode})`
          );
        }
      }
    }
  }

  // Workflow rules inside defaults (toolPermissions, errorBehavior, conditions).
  migrateWorkflowNode(defaults, ["defaults"], edits);
}

// ---------------------------------------------------------------------------
// Edit helpers — mutate the in-memory object and record a path edit
// ---------------------------------------------------------------------------

function setValue(parent, key, value, path, edits, description, review = []) {
  const before = parent[key];
  parent[key] = value;
  edits.push({ op: "set", path, value, before, description, review });
}

function removeKey(parent, key, path, edits, description, review = []) {
  const before = parent[key];
  delete parent[key];
  edits.push({ op: "remove", path, before, description, review });
}

function getAt(root, path) {
  let node = root;
  for (const segment of path) {
    if (!isPlainObject(node) && !Array.isArray(node)) return undefined;
    node = node[segment];
  }
  return node;
}

function renameKey(root, parentPath, oldKey, newKey, edits) {
  const parent = getAt(root, parentPath);
  if (!isPlainObject(parent) || !(oldKey in parent)) return;
  const dotted = parentPath.join(".");
  if (newKey in parent) {
    const same = deepEqual(parent[oldKey], parent[newKey]);
    removeKey(
      parent,
      oldKey,
      [...parentPath, oldKey],
      edits,
      `remove ${dotted}.${oldKey} (${dotted}.${newKey} already set${same ? "" : " — values differed, kept the new key"})`
    );
    return;
  }
  const value = parent[oldKey];
  removeKey(
    parent,
    oldKey,
    [...parentPath, oldKey],
    edits,
    `rename ${dotted}.${oldKey} → ${dotted}.${newKey}`
  );
  setValue(parent, newKey, value, [...parentPath, newKey], edits, null);
}

function replaceValue(root, path, from, to, edits) {
  const parent = getAt(root, path.slice(0, -1));
  const key = path[path.length - 1];
  if (isPlainObject(parent) && parent[key] === from) {
    setValue(parent, key, to, path, edits, `${path.join(".")} ${from} → ${to}`);
  }
}

// ---------------------------------------------------------------------------
// JSON writer
// ---------------------------------------------------------------------------

function detectFormatting(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indentMatch = text.match(/^([ \t]+)\S/m);
  const indent = indentMatch ? indentMatch[1] : "  ";
  return indent.startsWith("\t")
    ? { insertSpaces: false, tabSize: 1, eol }
    : { insertSpaces: true, tabSize: indent.length, eol };
}

/** Apply path edits to JSON/JSONC text, preserving formatting and comments. */
function applyJsonEdits(text, edits) {
  const formattingOptions = detectFormatting(text);
  let result = text;
  for (const edit of edits) {
    const value = edit.op === "remove" ? undefined : edit.value;
    result = jsonc.applyEdits(
      result,
      jsonc.modify(result, edit.path, value, { formattingOptions })
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// YAML writer — edits applied inside the owning block mapping, line by line
// ---------------------------------------------------------------------------

const YAML_KEY_LINE =
  /^([ \t]*)(-[ \t]+)?(["']?)([A-Za-z_$][\w$.-]*)\3[ \t]*:(?:[ \t]+(.*?))?[ \t]*$/;

function parseKeyLine(line) {
  const match = line.match(YAML_KEY_LINE);
  if (!match) return null;
  const [, indent, dash = "", , key, rest = ""] = match;
  return { key, rest, col: indent.length + dash.length, dash: dash !== "" };
}

function indentOf(line) {
  return line.match(/^[ \t]*/)[0].length;
}

function isBlankOrComment(line) {
  return /^[ \t]*(#.*)?$/.test(line);
}

/** Does the text after `key:` on a line hold `before`? */
function lineValueMatches(rest, before) {
  if (isPlainObject(before) || Array.isArray(before)) {
    if (rest === "" || rest.startsWith("#")) return true;
  }
  try {
    return deepEqual(yaml.load(`v: ${rest}`)?.v ?? null, before ?? null);
  } catch {
    return false;
  }
}

function formatYamlScalar(value) {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  if (typeof value !== "string") return null;
  if (/^[A-Za-z_][\w./-]*$/.test(value)) {
    try {
      if (yaml.load(value) === value) return value;
    } catch {
      // fall through to quoting
    }
  }
  return JSON.stringify(value);
}

function groupEditsByParent(edits) {
  const groups = new Map();
  for (const edit of edits) {
    const key = JSON.stringify(edit.path.slice(0, -1));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(edit);
  }
  return [...groups.values()];
}

function applyYamlEdits(text, edits) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let lines = text.split(/\r?\n/);
  for (const group of groupEditsByParent(edits)) {
    lines = applyYamlGroup(lines, group) ?? applyYamlFlowFallback(lines, group);
    if (!lines) return null;
  }
  return lines.join(eol);
}

/**
 * Edit one mapping: find a line of an existing key being changed (removed keys
 * first — they are the most specific), collect that mapping's sibling entries,
 * then remove/replace/insert entries and rebuild the lines.
 */
function applyYamlGroup(lines, group) {
  const candidates = [
    ...group.filter((edit) => edit.op === "remove"),
    ...group.filter((edit) => edit.op === "set" && edit.before !== undefined),
  ];
  let anchorLine = -1;
  let col = -1;
  for (const edit of candidates) {
    const key = edit.path[edit.path.length - 1];
    anchorLine = lines.findIndex((line) => {
      const parsed = parseKeyLine(line);
      return parsed?.key === key && lineValueMatches(parsed.rest, edit.before);
    });
    if (anchorLine >= 0) {
      col = parseKeyLine(lines[anchorLine]).col;
      break;
    }
  }
  if (anchorLine < 0) return null;

  // Block bounds: siblings share the key column; deeper lines are children.
  let start = anchorLine;
  if (!parseKeyLine(lines[anchorLine]).dash) {
    for (let i = anchorLine - 1; i >= 0; i--) {
      if (isBlankOrComment(lines[i])) continue;
      const parsed = parseKeyLine(lines[i]);
      if (parsed && parsed.col === col) {
        start = i;
        if (parsed.dash) break;
        continue;
      }
      if (indentOf(lines[i]) > col) continue;
      break;
    }
  }
  let end = anchorLine;
  for (let i = anchorLine + 1; i < lines.length; i++) {
    if (isBlankOrComment(lines[i])) continue;
    const parsed = parseKeyLine(lines[i]);
    if (
      indentOf(lines[i]) > col ||
      (parsed && parsed.col === col && !parsed.dash)
    ) {
      end = i;
      continue;
    }
    break;
  }

  const entries = [];
  for (let i = start; i <= end; i++) {
    const parsed = parseKeyLine(lines[i]);
    if (parsed && parsed.col === col && (i === start || !parsed.dash)) {
      entries.push({
        key: parsed.key,
        rest: parsed.rest,
        prefixLength: col,
        lines: [lines[i]],
      });
    } else if (entries.length > 0) {
      entries[entries.length - 1].lines.push(lines[i]);
    } else {
      return null;
    }
  }
  const dashPrefix = parseKeyLine(lines[start]).dash
    ? lines[start].slice(0, col)
    : null;
  const plainPrefix = " ".repeat(col);

  const anchorKey = parseKeyLine(lines[anchorLine]).key;
  let insertAt = entries.findIndex((entry) => entry.key === anchorKey) + 1;
  for (const edit of group) {
    const key = edit.path[edit.path.length - 1];
    const index = entries.findIndex((entry) => entry.key === key);
    if (edit.op === "remove") {
      if (index < 0) return null;
      entries.splice(index, 1);
      if (index < insertAt) insertAt--;
      continue;
    }
    const scalar = formatYamlScalar(edit.value);
    if (scalar === null) return null;
    if (index >= 0) {
      const old = entries[index];
      const comment = old.rest.match(/[ \t]+#[^"']*$/)?.[0] ?? "";
      const keptTail = old.lines.slice(1).filter(isBlankOrComment);
      entries[index] = {
        key,
        rest: scalar,
        prefixLength: col,
        lines: [`${plainPrefix}${key}: ${scalar}${comment}`, ...keptTail],
      };
    } else {
      entries.splice(insertAt, 0, {
        key,
        rest: scalar,
        prefixLength: col,
        lines: [`${plainPrefix}${key}: ${scalar}`],
      });
      insertAt++;
    }
  }
  if (entries.length === 0) return null;

  const rebuilt = entries.flatMap((entry, index) => {
    const [first, ...rest] = entry.lines;
    const prefix =
      index === 0 && dashPrefix !== null ? dashPrefix : plainPrefix;
    return [prefix + first.slice(entry.prefixLength), ...rest];
  });
  return [...lines.slice(0, start), ...rebuilt, ...lines.slice(end + 1)];
}

/** Flow mappings (`errorBehavior: { onError: stop }`): scalar renames only. */
function applyYamlFlowFallback(lines, group) {
  if (
    !group.every(
      (edit) =>
        edit.op === "set" &&
        typeof edit.before === "string" &&
        typeof edit.value === "string"
    )
  ) {
    return null;
  }
  let text = lines.join("\n");
  for (const edit of group) {
    const key = edit.path[edit.path.length - 1];
    const pattern = new RegExp(
      `((?:^|[\\s{,])["']?${escapeRegExp(String(key))}["']?\\s*:\\s*)(["']?)${escapeRegExp(edit.before)}\\2(?=\\s*(?:$|[,}#]))`,
      "m"
    );
    if (!pattern.test(text)) return null;
    text = text.replace(
      pattern,
      (_match, prefix, quote) => `${prefix}${quote}${edit.value}${quote}`
    );
  }
  return text.split("\n");
}

const FRONTMATTER = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/;

// ---------------------------------------------------------------------------
// File processing
// ---------------------------------------------------------------------------

const KIND_SETTINGS = "settings";
const KIND_WORKFLOW = "workflow";

function processFile(file, kind, options, report) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    report.errors.push(`${file}: cannot read (${error.message})`);
    return;
  }

  const format = file.endsWith(".prompt.md")
    ? "markdown"
    : /\.ya?ml$/i.test(file)
      ? "yaml"
      : "json";

  let data;
  let frontmatter;
  try {
    if (format === "json") {
      const parseErrors = [];
      data = jsonc.parse(text, parseErrors, { allowTrailingComma: true });
      if (parseErrors.length > 0) {
        throw new Error(`JSON parse error at offset ${parseErrors[0].offset}`);
      }
    } else if (format === "yaml") {
      data = yaml.load(text);
    } else {
      frontmatter = text.match(FRONTMATTER);
      if (!frontmatter) {
        report.scanned++;
        return;
      }
      data = yaml.load(frontmatter[2]);
    }
  } catch (error) {
    report.errors.push(`${file}: cannot parse (${error.message})`);
    return;
  }
  report.scanned++;

  const migrated = structuredClone(data ?? {});
  const edits = [];
  if (kind === KIND_SETTINGS) {
    migrateSettings(migrated, edits);
  } else {
    migrateWorkflowNode(migrated, [], edits);
  }

  if (edits.length > 0) {
    let newText;
    if (format === "json") {
      newText = applyJsonEdits(text, edits);
    } else if (format === "yaml") {
      newText = applyYamlEdits(text, edits);
    } else {
      const body = applyYamlEdits(frontmatter[2], edits);
      newText =
        body === null
          ? null
          : text.replace(
              FRONTMATTER,
              () => `${frontmatter[1]}${body}${frontmatter[3]}`
            );
    }

    const verified =
      newText !== null && deepEqual(reparse(newText, format), migrated);
    const descriptions = edits.map((edit) => edit.description).filter(Boolean);
    if (!verified) {
      report.errors.push(
        `${file}: needs a manual fix — could not apply safely:\n      ${descriptions.join("\n      ")}`
      );
    } else {
      report.changed.push({ file, descriptions });
      const reviewed = edits.filter((edit) => edit.review.length > 0);
      if (reviewed.length > 0) report.review.push({ file, edits: reviewed });
      if (options.write) writeFileSync(file, newText, "utf8");
    }
  }

  if (options.validate && format !== "markdown") {
    const validator =
      kind === KIND_SETTINGS ? validators().settings : validators().workflow;
    // `_runtime` is machine-written history; old runs carry retired runtime keys
    // (e.g. finalStep.responseTexts) that nothing reads, so it is not a
    // migration concern.
    const subject =
      kind === KIND_SETTINGS
        ? migrated
        : stripRuntime(structuredClone(migrated));
    if (!validator(subject)) {
      // Deepest paths first: a failed oneOf also reports every branch's mismatch
      // at the parent, which buries the real cause.
      const errors = [...(validator.errors ?? [])].sort(
        (x, y) =>
          y.instancePath.split("/").length - x.instancePath.split("/").length
      );
      report.invalid.push({ file, errors });
    }
  }
}

function stripRuntime(node) {
  if (Array.isArray(node)) node.forEach(stripRuntime);
  else if (isPlainObject(node)) {
    delete node._runtime;
    Object.values(node).forEach(stripRuntime);
  }
  return node;
}

function reparse(text, format) {
  try {
    if (format === "json") {
      return jsonc.parse(text, [], { allowTrailingComma: true });
    }
    if (format === "yaml") return yaml.load(text);
    const match = text.match(FRONTMATTER);
    return match ? yaml.load(match[2]) : undefined;
  } catch {
    return undefined;
  }
}

let cachedValidators;
function validators() {
  if (!cachedValidators) {
    const workflowSchema = JSON.parse(
      readFileSync(join(REPO_ROOT, "schemas", "workflow-schema.json"), "utf8")
    );
    const settingsSchema = JSON.parse(
      readFileSync(join(REPO_ROOT, "schemas", "settings-schema.json"), "utf8")
    );
    const ajv = new Ajv({
      allowUnionTypes: true,
      allErrors: true,
      strict: false,
      validateFormats: false,
    });
    ajv.addSchema(workflowSchema, "workflow-schema.json");
    cachedValidators = {
      workflow: ajv.getSchema("workflow-schema.json"),
      settings: ajv.compile(settingsSchema),
    };
  }
  return cachedValidators;
}

// ---------------------------------------------------------------------------
// History pruning
// ---------------------------------------------------------------------------

const RUN_DIR = /^(run-.+|draft)$/;

/**
 * Delete run directories whose working copy still fails the schema. A lineage
 * whose every run fails goes whole (its workflow.json would only point at
 * deleted runs); otherwise failing runs go individually, except the lineage's
 * latestRunRef, which is kept so the descriptor never dangles.
 */
function pruneHistory(invalid, options) {
  const byLineage = new Map();
  for (const { file } of invalid) {
    const runDir = dirname(file);
    if (!RUN_DIR.test(basename(runDir))) continue;
    const lineage = dirname(runDir);
    if (!byLineage.has(lineage)) byLineage.set(lineage, new Set());
    byLineage.get(lineage).add(basename(runDir));
  }

  const removals = [];
  const kept = [];
  for (const [lineage, failing] of byLineage) {
    const runs = readdirSync(lineage, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && RUN_DIR.test(entry.name))
      .map((entry) => entry.name);
    if (runs.every((run) => failing.has(run))) {
      removals.push({
        path: lineage,
        label: `lineage (${runs.length} run(s))`,
      });
      continue;
    }
    let latest;
    try {
      latest = JSON.parse(
        readFileSync(join(lineage, "workflow.json"), "utf8")
      ).latestRunRef;
    } catch {
      latest = undefined;
    }
    for (const run of failing) {
      if (run === latest) kept.push(join(lineage, run));
      else removals.push({ path: join(lineage, run), label: "run" });
    }
  }

  console.log(
    `\n== prune (${removals.length} ${options.write ? "deleted" : "to delete"}) ==`
  );
  for (const { path, label } of removals) {
    console.log(
      `  ${options.write ? "deleted" : "would delete"} ${label} ${path}`
    );
    if (options.write) rmSync(path, { recursive: true, force: true });
  }
  for (const path of kept) {
    console.log(`  KEPT latest run of a mixed lineage (fix by hand): ${path}`);
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "out",
  "dist",
  "coverage",
  ".vscode-test",
]);
const WORKFLOW_FILE = /(\.ctrlyoke\.(ya?ml|json)|\.prompt\.md)$/i;
const HISTORY_FILE = "workflow.ctrlyoke.json";

function walk(root, matches, skipDirs, found = []) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) walk(full, matches, skipDirs, found);
    } else if (entry.isFile() && matches(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

function stateHome() {
  return process.env.CTRLYOKE_HOME
    ? resolve(process.env.CTRLYOKE_HOME)
    : join(homedir(), ".ctrlyoke");
}

function settingsTargets(paths, workspace) {
  const targets =
    paths.length > 0
      ? paths.map((p) => resolve(p))
      : [
          join(homedir(), ".ctrlyoke", "settings.json"),
          join(workspace, ".ctrlyoke", "settings.json"),
        ];
  return [...new Set(targets)].filter((file) => existsSync(file));
}

function historyTargets(paths, workspace) {
  const roots =
    paths.length > 0
      ? paths.map((p) => resolve(p))
      : [
          join(stateHome(), "projects"),
          join(workspace, ".ctrlyoke", ".runs"),
          join(workspace, ".ctrlyoke-dev-home", "projects"),
        ];
  const files = [];
  for (const root of new Set(roots)) {
    if (!existsSync(root)) continue;
    console.log(`  scanning history root ${root}`);
    walk(root, (name) => name === HISTORY_FILE, new Set(), files);
  }
  return files;
}

function workflowTargets(paths, workspace) {
  const roots = paths.length > 0 ? paths.map((p) => resolve(p)) : [workspace];
  const files = [];
  for (const root of roots) {
    if (!existsSync(root)) {
      console.warn(`  skipping missing path ${root}`);
      continue;
    }
    if (statSync(root).isFile()) {
      files.push(root);
      continue;
    }
    // Run history is handled by the history command; skip it here.
    walk(
      root,
      (name) => WORKFLOW_FILE.test(name),
      new Set([...SKIP_DIRS, ".runs", ".ctrlyoke-dev-home", "temp"]),
      files
    );
  }
  return files;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    write: false,
    prune: false,
    validate: true,
    verbose: false,
    workspace: process.cwd(),
    paths: [],
  };
  const [command, ...rest] = argv;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--write") options.write = true;
    else if (arg === "--prune") options.prune = true;
    else if (arg === "--no-validate") options.validate = false;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--workspace")
      options.workspace = resolve(rest[++i] ?? ".");
    else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`);
    else options.paths.push(arg);
  }
  if (options.prune && !options.validate) {
    throw new Error("--prune needs validation; drop --no-validate.");
  }
  return { command, options };
}

function runSection(
  title,
  files,
  kind,
  options,
  { detailInvalid = true } = {}
) {
  const report = {
    scanned: 0,
    changed: [],
    errors: [],
    invalid: [],
    review: [],
  };
  console.log(`\n== ${title} ==`);
  for (const file of files) processFile(file, kind, options, report);

  for (const { file, descriptions } of report.changed) {
    console.log(`  ${options.write ? "updated" : "would update"} ${file}`);
    for (const description of descriptions) console.log(`      ${description}`);
  }
  for (const error of report.errors) console.log(`  ERROR ${error}`);
  if (report.review.length > 0) {
    console.log(
      `  REVIEW (${report.review.length} file(s)) — migrated to the old behavior; confirm intent:`
    );
    for (const { file, edits } of report.review) {
      console.log(`    ${file}`);
      for (const edit of edits) {
        console.log(`      ${edit.description}`);
        for (const note of edit.review) console.log(`        → ${note}`);
      }
    }
  }
  if (report.invalid.length > 0 && !(detailInvalid || options.verbose)) {
    console.log(
      `  ${report.invalid.length} file(s) still fail the current schema after migration (pass --verbose to list them, --prune to delete them).`
    );
  } else if (report.invalid.length > 0) {
    console.log(
      `  ${report.invalid.length} file(s) still fail the current schema after migration (not auto-fixable; review manually):`
    );
    for (const { file, errors } of report.invalid) {
      console.log(`    ${file}`);
      for (const error of errors.slice(0, 3)) {
        const params =
          error.params && Object.keys(error.params).length > 0
            ? ` ${JSON.stringify(error.params)}`
            : "";
        console.log(
          `      ${error.instancePath || "/"} ${error.message}${params}`
        );
      }
      if (errors.length > 3) console.log(`      … ${errors.length - 3} more`);
    }
  }
  console.log(
    `  ${report.scanned} scanned, ${report.changed.length} ${options.write ? "updated" : "to update"}, ${report.errors.length} error(s), ${report.review.length} to review, ${report.invalid.length} still invalid`
  );
  return report;
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const sections = {
    settings: () =>
      runSection(
        "settings",
        settingsTargets(options.paths, options.workspace),
        KIND_SETTINGS,
        options
      ),
    history: () => {
      const report = runSection(
        "run history",
        historyTargets(options.paths, options.workspace),
        KIND_WORKFLOW,
        options,
        { detailInvalid: false }
      );
      if (options.prune) pruneHistory(report.invalid, options);
      return report;
    },
    workflow: () =>
      runSection(
        "workflow files",
        workflowTargets(options.paths, options.workspace),
        KIND_WORKFLOW,
        options
      ),
  };

  let selected;
  if (command === "all") {
    if (options.paths.length > 0) {
      throw new Error(
        "'all' uses default paths only; use a specific command to pass paths."
      );
    }
    selected = ["settings", "history", "workflow"];
  } else if (command in sections) {
    if (command === "workflow" && options.paths.length === 0) {
      console.log(`No path given; scanning workspace ${options.workspace}`);
    }
    selected = [command];
  } else {
    console.log(
      readFileSync(fileURLToPath(import.meta.url), "utf8").split("\nimport ")[0]
    );
    process.exit(command ? 1 : 0);
  }

  console.log(
    options.write ? "Mode: WRITE" : "Mode: dry run (pass --write to apply)"
  );
  const reports = selected.map((name) => sections[name]());
  if (!options.write && reports.some((report) => report.changed.length > 0)) {
    console.log("\nDry run only — re-run with --write to apply.");
  }
  process.exit(reports.some((report) => report.errors.length > 0) ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Render a JSON path as `steps[2].errorBehavior`. */
function formatPath(path) {
  return path.reduce(
    (text, segment) =>
      typeof segment === "number"
        ? `${text}[${segment}]`
        : text
          ? `${text}.${segment}`
          : segment,
    ""
  );
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return (
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => deepEqual(item, b[i]))
    );
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return (
      keysA.length === keysB.length &&
      keysA.every((key) => key in b && deepEqual(a[key], b[key]))
    );
  }
  if (a instanceof Date && b instanceof Date)
    return a.getTime() === b.getTime();
  return false;
}

main();
