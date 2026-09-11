#!/usr/bin/env node
/**
 * Runs every `npm test` suite and ends the run with one combined summary.
 *
 * Two things used to make a single `npm test` run unreadable, and working
 * around either one cost a second full run of a ~6 minute suite. The suites
 * were chained with `&&`, so the first failure hid the other two entirely --
 * you fixed the extension tests, re-ran, and only then met the UI failures.
 * And each suite ends in its own reporter's format (Mocha's "N passing",
 * Vitest's "Tests ...", node:test's TAP "# fail"), thousands of lines apart,
 * with no combined verdict -- so tailing the output only ever told you about
 * the *last* suite, and the usual next move was to re-run and grep.
 *
 * So: every suite runs (pass `--bail` to stop at the first failure), and the
 * run always ends with a fixed-width block anchored on `TEST SUMMARY:`, giving
 * each suite's verdict, its counts, and the name of every failing test. Tail
 * ~40 lines or grep that anchor and one run is enough.
 *
 * Suite output is streamed through untouched as it arrives, so nothing is
 * hidden or buffered up to the end; the capture exists only to build the
 * summary. Counts and failing names are parsed best-effort -- the *verdict* is
 * always the child's exit code, so a reporter changing its wording can cost
 * detail in the summary but can never turn a failure into a pass.
 *
 * Usage:
 *   node scripts/run-test-suites.mjs [--bail]
 */

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const IS_WINDOWS = process.platform === "win32";

/** The line every summary is anchored on, for tailing and grepping. */
export const SUMMARY_ANCHOR = "TEST SUMMARY:";

const RULE = "=".repeat(72);
const DETAIL_COLUMN_WIDTH = 36;
const MAX_LISTED_FAILURES = 25;
const MAX_CAPTURED_LINES = 50_000;

export const SUITE_STATUS = {
  PASS: "pass",
  FAIL: "fail",
  /** Not run, because an earlier suite failed under `--bail`. */
  SKIP: "skip",
};

/** Full CSI escape sequences, so colour and cursor moves never reach a parser. */
const ANSI_PATTERN = /\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text) {
  return text.replace(ANSI_PATTERN, "");
}

function lastMatch(lines, pattern) {
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = pattern.exec(lines[index]);
    if (match) return match;
  }
  return undefined;
}

/** Mocha's spec reporter epilogue: "4050 passing (5m)" / "2 failing". */
export function describeMochaRun(lines) {
  const passing = lastMatch(lines, /^\s*(\d+) passing\b/);
  if (!passing) return undefined;
  const failing = lastMatch(lines, /^\s*(\d+) failing\b/);
  const pending = lastMatch(lines, /^\s*(\d+) pending\b/);
  const parts = [`${passing[1]} passing`];
  if (pending) parts.push(`${pending[1]} pending`);
  parts.push(`${failing ? failing[1] : 0} failing`);
  return parts.join(", ");
}

/** Vitest's epilogue: "Test Files  232 passed (232)" / "Tests  2649 passed (2649)". */
export function describeVitestRun(lines) {
  const tests = lastMatch(lines, /^\s*Tests\s+(\S.*?)\s*$/);
  if (!tests) return undefined;
  // The trailing "(2649)" just restates the total the counts already add up
  // to, and the file count is more useful in the space it takes.
  const counts = tests[1].replace(/\s*\(\d+\)\s*$/, "");
  const files = lastMatch(lines, /^\s*Test Files\s+(\S.*?)\s*$/);
  const fileCount = files ? /\((\d+)\)\s*$/.exec(files[1])?.[1] : undefined;
  if (!fileCount) return counts;
  return `${counts} in ${fileCount} file${fileCount === "1" ? "" : "s"}`;
}

/** node:test's TAP epilogue: "# pass 20" / "# fail 0". */
export function describeNodeTestRun(lines) {
  const pass = lastMatch(lines, /^# pass (\d+)/);
  if (!pass) return undefined;
  const fail = lastMatch(lines, /^# fail (\d+)/);
  return `${pass[1]} pass, ${fail ? fail[1] : 0} fail`;
}

/**
 * Mocha numbers each failure and puts the test title on the next line, ending
 * in a colon: "  1) WorkflowExecutor" / "       resumes a run:".
 *
 * Only the epilogue list is read. The spec reporter names every failure twice
 * -- once inline as it walks the tree ("1) resumes a run", the bare title) and
 * once in the epilogue (suite and title, on separate lines) -- and the two
 * forms are different strings, so deduping cannot merge them. Reading both
 * would report one broken test as two.
 */
export function mochaFailures(lines) {
  const epilogue = lines.findLastIndex((line) =>
    /^\s*\d+ failing\b/.test(line)
  );
  const found = [];
  // -1 (no epilogue, e.g. the run died early) scans everything, which is the
  // right fallback: inline markers are all there is to go on.
  for (let index = epilogue + 1; index < lines.length; index++) {
    if (!/^\s*\d+\)\s+\S/.test(lines[index])) continue;
    const head = lines[index].trim().replace(/^\d+\)\s*/, "");
    const next = (lines[index + 1] ?? "").trim();
    found.push(next.endsWith(":") ? `${head} > ${next.slice(0, -1)}` : head);
  }
  return found;
}

/**
 * Vitest has the same double-naming as Mocha: a failure appears inline under
 * its file ("× keeps the row under the cursor 5ms" -- bare title, plus a
 * duration that makes it unstable) and again in the "Failed Tests" section
 * fully qualified by file and suite. Prefer the qualified form; the inline
 * markers are the fallback for a run that died before that section.
 */
export function vitestFailures(lines) {
  const qualified = [];
  const inline = [];
  for (const line of lines) {
    const failed = /^\s*FAIL\s+(\S.*?)\s*$/.exec(line);
    if (failed) {
      qualified.push(failed[1]);
      continue;
    }
    const marker = /^\s*×\s+(\S.*?)\s*$/.exec(line);
    if (marker) inline.push(marker[1]);
  }
  return qualified.length > 0 ? qualified : inline;
}

export function nodeTestFailures(lines) {
  const found = [];
  for (const line of lines) {
    const match = /^not ok \d+ - (\S.*?)\s*$/.exec(line);
    if (match) found.push(match[1]);
  }
  return found;
}

/**
 * The suites `npm test` covers, in the order they run. Each one stays a plain
 * npm script so it can still be run on its own -- the summary names that
 * script for every failure, which is the whole point of keeping them separate.
 */
export const TEST_SUITES = [
  {
    key: "extension",
    script: "test:extension",
    describe: describeMochaRun,
    failures: mochaFailures,
  },
  {
    key: "ui",
    script: "test:ui",
    describe: describeVitestRun,
    failures: vitestFailures,
  },
  {
    key: "packaging",
    script: "test:packaging",
    describe: describeNodeTestRun,
    failures: nodeTestFailures,
  },
];

export function formatDuration(ms) {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m ${String(seconds).padStart(2, "0")}s`
    : `${seconds}s`;
}

function statusLabel(status) {
  if (status === SUITE_STATUS.PASS) return "PASS";
  return status === SUITE_STATUS.FAIL ? "FAIL" : "SKIP";
}

export function renderSummary(results) {
  const failed = results.filter(
    (result) => result.status === SUITE_STATUS.FAIL
  );
  const skipped = results.filter(
    (result) => result.status === SUITE_STATUS.SKIP
  );
  const headline =
    failed.length === 0 && skipped.length === 0
      ? `${SUMMARY_ANCHOR} ALL ${results.length} SUITES PASSED`
      : `${SUMMARY_ANCHOR} ${failed.length} OF ${results.length} SUITES FAILED`;

  const keyWidth = Math.max(...results.map((result) => result.key.length));
  const lines = ["", RULE, ` ${headline}`, RULE];

  for (const result of results) {
    const detail =
      result.status === SUITE_STATUS.SKIP
        ? "not run (--bail)"
        : (result.detail ?? "no counts parsed -- see output above");
    const duration =
      result.status === SUITE_STATUS.SKIP
        ? ""
        : formatDuration(result.durationMs);
    lines.push(
      (
        `  ${statusLabel(result.status)}  ${result.key.padEnd(keyWidth)}  ` +
        `${detail.padEnd(DETAIL_COLUMN_WIDTH)}  ${duration}`
      ).trimEnd()
    );
  }

  for (const result of failed) {
    const names = [...new Set(result.failures ?? [])];
    lines.push(RULE, `  ${result.key} -- failing:`);
    if (names.length === 0) {
      lines.push("    (no test names parsed -- scroll up for this suite)");
    }
    for (const name of names.slice(0, MAX_LISTED_FAILURES)) {
      lines.push(`    ${name}`);
    }
    if (names.length > MAX_LISTED_FAILURES) {
      lines.push(`    ... and ${names.length - MAX_LISTED_FAILURES} more`);
    }
    lines.push(`  Re-run only this suite:  npm run ${result.script}`);
  }

  lines.push(RULE, "");
  return lines.join("\n");
}

/**
 * Accumulates decoded output a line at a time. Chunks split mid-line, so the
 * trailing partial is held back until the next one completes it.
 */
function createCapture() {
  const lines = [];
  let partial = "";
  return {
    push(text) {
      partial += text;
      const parts = partial.split(/\r?\n/);
      partial = parts.pop() ?? "";
      for (const part of parts) {
        lines.push(stripAnsi(part));
        if (lines.length > MAX_CAPTURED_LINES) lines.shift();
      }
    },
    finish() {
      if (partial) {
        lines.push(stripAnsi(partial));
        partial = "";
      }
      return lines;
    },
  };
}

function runSuite(suite) {
  return new Promise((resolveSuite) => {
    const startedAt = Date.now();
    const capture = createCapture();
    const child = spawn("npm", ["run", suite.script], {
      cwd: ROOT_DIR,
      // Reporters drop colour when they see a pipe. Since the pipe is ours and
      // the raw bytes go straight back out, hand the colour back whenever the
      // real terminal can show it -- parsing strips it either way.
      env: process.stdout.isTTY
        ? { ...process.env, FORCE_COLOR: "1" }
        : process.env,
      shell: IS_WINDOWS,
      stdio: ["inherit", "pipe", "pipe"],
    });

    const tee = (chunk, stream) => {
      stream.write(chunk);
      capture.push(chunk.toString());
    };
    child.stdout.on("data", (chunk) => tee(chunk, process.stdout));
    child.stderr.on("data", (chunk) => tee(chunk, process.stderr));

    const settle = (code) => {
      const lines = capture.finish();
      const ok = code === 0;
      resolveSuite({
        key: suite.key,
        script: suite.script,
        status: ok ? SUITE_STATUS.PASS : SUITE_STATUS.FAIL,
        detail: suite.describe(lines),
        failures: ok ? [] : suite.failures(lines),
        durationMs: Date.now() - startedAt,
      });
    };

    child.on("error", (error) => {
      process.stderr.write(`\nFailed to start ${suite.script}: ${error}\n`);
      settle(1);
    });
    child.on("close", (code) => settle(code ?? 1));
  });
}

async function main() {
  const bail = process.argv.includes("--bail");
  const results = [];

  for (const suite of TEST_SUITES) {
    const result = await runSuite(suite);
    results.push(result);
    if (bail && result.status === SUITE_STATUS.FAIL) break;
  }

  for (const suite of TEST_SUITES.slice(results.length)) {
    results.push({
      key: suite.key,
      script: suite.script,
      status: SUITE_STATUS.SKIP,
      failures: [],
      durationMs: 0,
    });
  }

  process.stdout.write(renderSummary(results));
  process.exitCode = results.every(
    (result) => result.status === SUITE_STATUS.PASS
  )
    ? 0
    : 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
