#!/usr/bin/env node
/**
 * Regenerates dev/backlog/TESTING_GAPS.md from the two coverage-summary.json
 * files produced by `npm run test:coverage` (extension host) and
 * `npm run test:ui:coverage` (React dashboard). Wired as a `post<script>`
 * npm hook on both, so the backlog doc always reflects the latest run of
 * whichever side was just measured; the other side keeps showing its most
 * recent measurement (with its own "as of" timestamp) until it's re-run.
 *
 * Goal: a token-friendly, ranked doc that a fresh agent can read instead of
 * running coverage and parsing raw output itself.
 *
 * Usage: node scripts/generate-testing-gaps.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const EXTENSION_SUMMARY = path.join(root, "coverage", "extension", "coverage-summary.json");
const EXTENSION_HTML = "coverage/extension/index.html";
const UI_SUMMARY = path.join(root, "src", "ui", "webview-react", "coverage", "coverage-summary.json");
const UI_HTML = "src/ui/webview-react/coverage/index.html";
const OUTPUT_PATH = path.join(root, "dev", "backlog", "TESTING_GAPS.md");

const MAX_ROWS = 30;
const MIN_STATEMENTS = 15;

// Pure type/interface files have no meaningful runtime behavior to test.
// TS interfaces compile away entirely, but v8-to-istanbul's AST walker still
// counts method signatures as "statements", so these always show as 0%
// despite having nothing to test. This codebase uses `I<Name>.ts` Hungarian
// notation for interface-only files (ICliProvider.ts, ILogParser.ts, ...).
const EXCLUDE_NAME = /Types\.ts$|Settings\.ts$|\/interfaces\/|\/I[A-Z][A-Za-z]*\.ts$/;
// Build artifacts / vendored or copied assets, not first-party logic to unit test here.
const EXCLUDE_PATH = /\/out\/(templates|schemas|runtime-deps)\//;

function toRepoRelative(absPath) {
  return path.relative(root, absPath).split(path.sep).join("/");
}

function loadRows(summaryPath) {
  if (!fs.existsSync(summaryPath)) return null;
  const data = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  const asOf = fs.statSync(summaryPath).mtime.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const total = data.total.statements.pct;

  const rows = [];
  for (const [absFile, s] of Object.entries(data)) {
    if (absFile === "total") continue;
    if (absFile.includes("node_modules")) continue;
    let rel = toRepoRelative(absFile);
    if (EXCLUDE_PATH.test("/" + rel)) continue;
    // out/scripts/*.js are verbatim copies of src/scripts/*.js (not tsc
    // output) — point at the editable source instead of the build artifact.
    rel = rel.replace(/^out\/scripts\//, "src/scripts/");
    if (EXCLUDE_NAME.test(rel)) continue;
    // coverage-summary.json is a snapshot from whenever coverage last ran;
    // a stale/renamed/deleted build artifact from an earlier build can still
    // be referenced in it until the next full run. Skip anything that no
    // longer exists on disk rather than reporting a gap that can't be fixed.
    if (!fs.existsSync(path.join(root, rel))) continue;

    const total = s.statements.total;
    const covered = s.statements.covered;
    const uncovered = total - covered;
    if (total < MIN_STATEMENTS || uncovered === 0) continue;

    rows.push({ rel, pct: s.statements.pct, total, uncovered });
  }

  rows.sort((a, b) => b.uncovered - a.uncovered || a.pct - b.pct);
  return { asOf, totalPct: total, rows };
}

function renderSection(title, htmlReport, runCommand, section) {
  if (!section) {
    return `## ${title}\n\n_Not yet measured — run \`${runCommand}\` to populate this section._\n`;
  }

  const { asOf, totalPct, rows } = section;
  const shown = rows.slice(0, MAX_ROWS);
  const remaining = rows.length - shown.length;

  const lines = [
    `## ${title} — ${totalPct}% statements covered (as of ${asOf})`,
    "",
    `Ranked by uncovered statement count (biggest win first). Full report: \`${htmlReport}\`.`,
    "",
    "| File | Coverage | Uncovered / Total |",
    "| --- | ---: | ---: |",
  ];

  for (const r of shown) {
    lines.push(`| \`${r.rel}\` | ${r.pct}% | ${r.uncovered} / ${r.total} |`);
  }

  if (remaining > 0) {
    lines.push("", `_${remaining} more file(s) below 100% not shown — see the HTML report._`);
  }

  return lines.join("\n") + "\n";
}

const extension = loadRows(EXTENSION_SUMMARY);
const ui = loadRows(UI_SUMMARY);

const doc = `# Testing Gaps

_Auto-generated — do not edit by hand. Regenerated automatically by \`npm run test:coverage\` (extension host) and \`npm run test:ui:coverage\` (webview dashboard)._

Hand this file to a fresh agent to start closing coverage gaps without needing to run or parse coverage output first.

---

${renderSection("Extension host", EXTENSION_HTML, "npm run test:coverage", extension)}
---

${renderSection("Webview dashboard (React)", UI_HTML, "npm run test:ui:coverage", ui)}`;

fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
fs.writeFileSync(OUTPUT_PATH, doc);
console.log(`Wrote ${toRepoRelative(OUTPUT_PATH)}`);
