#!/usr/bin/env node
/**
 * Repeated flow-control string-literal finder.
 *
 * copilot-instructions.md's "No hardcoded strings for flow control" rule says:
 * a string used with `==`/`!=`/`switch`/`case` should be a constant or enum in
 * DashboardConstants.ts or CtrlYokeTypes.ts. ESLint can't enforce this as a
 * per-file rule the way `no-restricted-syntax` does, because the thing that
 * makes a literal a violation — the same tag string appearing at more than one
 * flow-control site — is a whole-repo fact, not something visible from one
 * file's AST. (Same reason find-dead-methods.mjs is a standalone script and
 * not an ESLint rule: cross-file analysis doesn't fit ESLint's per-file model.)
 * A literal used for flow control exactly once is fine to leave inline — it's
 * duplication across sites that should collapse onto a shared constant.
 *
 * Deliberately scoped to just the two constructs the written rule names:
 *   - `x === "literal"` / `x !== "literal"` (and the loose `==`/`!=` forms)
 *   - `case "literal":` inside a `switch`
 * This is what keeps JSX text and JSX attribute strings ("perfectly acceptable
 * and fine" per the rule's own html-section carve-out) out of the report for
 * free: neither construct appears in ordinary JSX markup.
 *
 * Known false-positive shape (heuristic, not a source of truth, same caveat as
 * find-dead-methods.mjs): two lexically identical literals used in unrelated
 * switches/comparisons (e.g. two independent concepts that both happen to use
 * "error") will be grouped together even though they don't share meaning.
 * Each reported group still needs a human to check before consolidating onto
 * one constant.
 *
 * Excluded on purpose:
 *   - `typeof x === "string"` and friends — the literal is a JS primitive-type
 *     tag, not an application-defined one, so a constant would add nothing.
 *   - Literals shorter than 2 characters (`""`, `" "`, single delimiter chars)
 *     — almost always parsing/formatting checks, not enum-style tags.
 *   - Anything that isn't identifier/kebab-shaped (letters/digits/`_`/`-`
 *     only). Prose error messages and free-text comparisons repeat by
 *     coincidence, not because they're the same application tag, and
 *     swamped the report before this filter existed (395 groups, mostly
 *     English sentence fragments).
 *   - A fixed blocklist of external-API constants (Node `err.code` values,
 *     `process.platform` values, HTTP methods). These are dictated by an
 *     API outside this codebase, not an internal enum this project owns, so
 *     "single-source it" doesn't apply the way it does for e.g. tab-kind
 *     tags — see EXTERNAL_API_CONSTANTS below to extend the list.
 *
 * Usage: node scripts/find-hardcoded-strings.mjs [--json]
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SRC_ROOT = path.join(ROOT, "src");

const MIN_LITERAL_LENGTH = 2;
const SKIP_DIR_NAMES = new Set(["node_modules", "coverage", "static"]);

/** Only flag literals shaped like a tag/enum member, not prose or paths. */
const TAG_SHAPE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * External-API-mandated string constants: Node `err.code` values,
 * `process.platform` values, HTTP methods. Extend this list rather than
 * relaxing TAG_SHAPE if a new category of external-contract noise shows up.
 */
const EXTERNAL_API_CONSTANTS = new Set([
  // Node/libuv error codes (err.code)
  "ENOENT",
  "EACCES",
  "EPERM",
  "EEXIST",
  "ENOTDIR",
  "EISDIR",
  "EMFILE",
  "ENFILE",
  "ENOSPC",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "EADDRINUSE",
  "EBUSY",
  "ENOTEMPTY",
  "ELOOP",
  "ENAMETOOLONG",
  "EINVAL",
  "EAGAIN",
  "EXDEV",
  "UNKNOWN",
  // process.platform
  "win32",
  "darwin",
  "linux",
  // HTTP methods
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

const EQUALITY_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      walkFiles(path.join(dir, entry.name), out);
      continue;
    }
    if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function toRelative(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

function collectFromFile(filePath, occurrences) {
  const text = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.ES2022,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  function record(value, node, kind) {
    if (value.length < MIN_LITERAL_LENGTH) return;
    if (!TAG_SHAPE.test(value)) return;
    if (EXTERNAL_API_CONSTANTS.has(value)) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile)
    );
    const list = occurrences.get(value) ?? [];
    list.push({ location: `${toRelative(filePath)}:${line + 1}`, kind });
    occurrences.set(value, list);
  }

  function visit(node) {
    if (
      ts.isBinaryExpression(node) &&
      EQUALITY_OPERATORS.has(node.operatorToken.kind)
    ) {
      const isTypeofCheck =
        ts.isTypeOfExpression(node.left) || ts.isTypeOfExpression(node.right);
      if (!isTypeofCheck) {
        if (ts.isStringLiteralLike(node.left)) {
          record(node.left.text, node.left, "==/!=");
        }
        if (ts.isStringLiteralLike(node.right)) {
          record(node.right.text, node.right, "==/!=");
        }
      }
    } else if (
      ts.isCaseClause(node) &&
      ts.isStringLiteralLike(node.expression)
    ) {
      record(node.expression.text, node.expression, "switch/case");
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

function main() {
  const jsonOutput = process.argv.includes("--json");
  const files = walkFiles(SRC_ROOT);
  const occurrences = new Map();
  for (const file of files) {
    collectFromFile(file, occurrences);
  }

  const duplicates = [...occurrences.entries()]
    .filter(([, locs]) => locs.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

  if (jsonOutput) {
    console.log(
      JSON.stringify(
        duplicates.map(([value, locs]) => ({
          value,
          count: locs.length,
          locations: locs,
        })),
        null,
        2
      )
    );
    return;
  }

  console.log(
    `Scanned ${files.length} files under src/, ${occurrences.size} distinct string ` +
      `literals used in ==, !=, or switch/case.\n`
  );

  if (duplicates.length === 0) {
    console.log("No repeated flow-control string literals found.\n");
    return;
  }

  console.log(
    `${duplicates.length} literal(s) repeated across more than one flow-control site:\n`
  );
  for (const [value, locs] of duplicates) {
    console.log(`  "${value}"  (${locs.length}x)`);
    for (const loc of locs) {
      console.log(`      ${loc.location}  [${loc.kind}]`);
    }
  }
  console.log(
    "\nEach repeated literal is a candidate for a shared constant/enum in " +
      "DashboardConstants.ts or CtrlYokeTypes.ts (per copilot-instructions.md " +
      '"No hardcoded strings for flow control"). This is a heuristic report, not ' +
      "a source of truth: some repeats may be lexically identical but semantically " +
      'unrelated (two unrelated switches that both happen to use "error") — verify ' +
      "each group before consolidating onto one constant.\n"
  );
}

main();
