#!/usr/bin/env node
/**
 * Regenerates dev/backlog/LOG_INVENTORY.md by statically scanning the
 * codebase for Log.* (src/utils/Log.ts — extension host / CLI / MCP server)
 * and WebviewLog.* (src/ui/webview-react/utils/logger.ts — React dashboard)
 * call sites, plus raw console.* usage (eslint's `no-console` rule already
 * fails `npm run lint` on new console.* in the ts/tsx source tree outside an
 * explicit exemption list in eslint.config.mjs — this section is a periodic
 * census, including the .js hook scripts/MCP-adjacent files eslint doesn't
 * cover, not an enforcement mechanism).
 *
 * Companion doc to dev/backlog/LOG_CLEANUP_PLAN.md: this file answers "where
 * are we logging and at what level today", the plan doc answers "what should
 * change". Re-run manually after a triage pass to see the updated counts —
 * unlike TESTING_GAPS.md there is no coverage tool driving this, so it is not
 * wired to a npm post-hook.
 *
 * Usage: node scripts/generate-log-inventory.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const OUTPUT_PATH = path.join(root, "dev", "backlog", "LOG_INVENTORY.md");
const MAX_ROWS = 40;

const BACKEND_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "appendLine",
];
const WEBVIEW_LEVELS = ["debug", "info", "warn", "error"];
const CONSOLE_LEVELS = ["log", "debug", "info", "warn", "error", "trace"];

const BACKEND_CALL_RE = /\bLog\.(trace|debug|info|warn|error|appendLine)\(/g;
const WEBVIEW_CALL_RE = /\bWebviewLog\.(debug|info|warn|error)\(/g;
const CONSOLE_CALL_RE = /\bconsole\.(log|debug|info|warn|error|trace)\(/g;

const EXCLUDE_RE = /\/test\/|\.test\.tsx?$|\.spec\.tsx?$/;
// Vendored/build artifacts, not first-party source — same spirit as the
// EXCLUDE_PATH in generate-testing-gaps.mjs.
const CONSOLE_EXCLUDE_RE = /\/coverage\//;

function toRepoRelative(absPath) {
  return path.relative(root, absPath).split(path.sep).join("/");
}

function walk(dir, out, extRe) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out, extRe);
    } else if (extRe.test(entry.name)) {
      out.push(full);
    }
  }
}

function scan(files, callRe, levels, excludeRe = EXCLUDE_RE) {
  /** @type {Map<string, Record<string, number>>} */
  const perFile = new Map();
  const totals = Object.fromEntries(levels.map((l) => [l, 0]));

  for (const abs of files) {
    const rel = toRepoRelative(abs);
    if (excludeRe.test("/" + rel)) continue;

    const text = fs.readFileSync(abs, "utf8");
    callRe.lastIndex = 0;
    let match;
    let counts = null;
    while ((match = callRe.exec(text))) {
      counts ??= Object.fromEntries(levels.map((l) => [l, 0]));
      const level = match[1];
      counts[level] = (counts[level] ?? 0) + 1;
      totals[level] = (totals[level] ?? 0) + 1;
    }
    if (counts) {
      perFile.set(rel, counts);
    }
  }

  return { perFile, totals };
}

function renderTable(perFile, levels) {
  const rows = [...perFile.entries()]
    .map(([rel, counts]) => ({
      rel,
      counts,
      total: levels.reduce((sum, l) => sum + (counts[l] ?? 0), 0),
    }))
    .sort((a, b) => b.total - a.total || a.rel.localeCompare(b.rel));

  const shown = rows.slice(0, MAX_ROWS);
  const remaining = rows.length - shown.length;

  const header = ["File", ...levels.map((l) => l), "Total"];
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
  ];
  for (const r of shown) {
    const cells = levels.map((l) => r.counts[l] || "");
    lines.push(`| \`${r.rel}\` | ${cells.join(" | ")} | ${r.total} |`);
  }

  if (remaining > 0) {
    lines.push(
      "",
      `_${remaining} more file(s) not shown — re-run the script and inspect its output, or grep directly._`
    );
  }

  return { table: lines.join("\n"), fileCount: rows.length };
}

const tsFiles = [];
walk(path.join(root, "src"), tsFiles, /\.tsx?$/);
const jsFiles = [];
walk(path.join(root, "src"), jsFiles, /\.js$/);

const backend = scan(tsFiles, BACKEND_CALL_RE, BACKEND_LEVELS);
const webview = scan(
  tsFiles.filter((f) => toRepoRelative(f).startsWith("src/ui/webview-react/")),
  WEBVIEW_CALL_RE,
  WEBVIEW_LEVELS
);
// console.* spans both ts/tsx (mostly eslint-exempted files — see
// eslint.config.mjs) and the .js hook scripts/MCP-adjacent files eslint's
// `--ext ts,tsx` lint script never touches at all.
const consoleUsage = scan(
  [...tsFiles, ...jsFiles],
  CONSOLE_CALL_RE,
  CONSOLE_LEVELS,
  CONSOLE_EXCLUDE_RE
);

const backendTable = renderTable(backend.perFile, BACKEND_LEVELS);
const webviewTable = renderTable(webview.perFile, WEBVIEW_LEVELS);
const consoleTable = renderTable(consoleUsage.perFile, CONSOLE_LEVELS);

const backendTotal = BACKEND_LEVELS.reduce((s, l) => s + backend.totals[l], 0);
const webviewTotal = WEBVIEW_LEVELS.reduce((s, l) => s + webview.totals[l], 0);
const consoleTotal = CONSOLE_LEVELS.reduce(
  (s, l) => s + consoleUsage.totals[l],
  0
);

const doc = `# Log Inventory

_Auto-generated by \`node scripts/generate-log-inventory.mjs\` — do not edit by hand. Re-run manually after making logging changes to refresh the counts; not wired to a test/build hook._

Companion to \`dev/backlog/LOG_CLEANUP_PLAN.md\`. This file is the "where are we today" census of every \`Log.*\` (\`src/utils/Log.ts\` — extension host, CLI, MCP server) and \`WebviewLog.*\` (\`src/ui/webview-react/utils/logger.ts\` — React dashboard) call site, grouped by file and counted by level. The plan doc is where triage decisions and the target level scheme live — this file only tells you where to look.

Excludes \`src/test/**\` and \`*.test.tsx?\`/\`*.spec.tsx?\` files (test assertions/mocks around logging, not real log output).

---

## Backend (\`Log.*\`) — ${backendTotal} call sites across ${backend.perFile.size} file(s)

Totals by level: ${BACKEND_LEVELS.map((l) => `${l}=${backend.totals[l]}`).join(", ")}

Ranked by call count (highest first).

${backendTable.table}

---

## Webview dashboard (\`WebviewLog.*\`) — ${webviewTotal} call sites across ${webview.perFile.size} file(s)

Totals by level: ${WEBVIEW_LEVELS.map((l) => `${l}=${webview.totals[l]}`).join(", ")}

Ranked by call count (highest first).

${webviewTable.table}

---

## Raw \`console.*\` usage — ${consoleTotal} call sites across ${consoleUsage.perFile.size} file(s)

Totals by level: ${CONSOLE_LEVELS.map((l) => `${l}=${consoleUsage.totals[l]}`).join(", ")}

\`npm run lint\` already fails on new \`console.*\` in the ts/tsx source tree (\`no-console\`
in \`eslint.config.mjs\`) outside its explicit exemption list — standalone processes with no
Log/WebviewLog access (CLI terminal output, the MCP server), modules shared with those processes,
the loggers' own bootstrap/fallback paths, and tests. This section is a periodic census, not an
enforcement mechanism, and additionally covers the \`.js\` hook scripts / MCP-adjacent files that
\`eslint src --ext ts,tsx\` never lints at all. Excludes \`**/coverage/**\` (vendored build output).
Static regex scan — a handful of matches may be inside doc comments (example code in a JSDoc
block) rather than real calls; check the line before acting on a single-digit count.

Ranked by call count (highest first).

${consoleTable.table}
`;

fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
fs.writeFileSync(OUTPUT_PATH, doc);
console.log(`Wrote ${toRepoRelative(OUTPUT_PATH)}`);
