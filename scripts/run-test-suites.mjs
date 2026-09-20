#!/usr/bin/env node
/**
 * Runs every `npm test` suite -- concurrently -- and ends with one summary.
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
 * So: every suite runs, and the run always ends with a fixed-width block
 * anchored on `TEST SUMMARY:`, giving each suite's verdict, its counts, and the
 * name of every failing test. Tail ~40 lines or grep that anchor and one run is
 * enough.
 *
 * ## Parallelism
 *
 * The three suites are independent once the TypeScript is compiled, so they run
 * at the same time instead of end to end, and each one is told how much of the
 * machine it may use (`planParallelism`). Two things make that safe:
 *
 * - `compile-tests` runs *first*, on its own. Both the extension suite and the
 *   packaging suite read `out/`, so compiling inside one of them while the
 *   other reads it is a race. It is hoisted here and the suites below use the
 *   already-compiled entry points.
 * - Suite output is buffered and flushed as one labelled block when that suite
 *   finishes. Nothing is hidden -- it just arrives per suite rather than live,
 *   because three reporters writing to one terminal at once is unreadable.
 *   `--serial` restores the old sequential, live-streamed behaviour.
 *
 * Counts and failing names are parsed best-effort -- the *verdict* is always
 * the child's exit code, so a reporter changing its wording can cost detail in
 * the summary but can never turn a failure into a pass.
 *
 * Usage:
 *   node scripts/run-test-suites.mjs [--serial] [--bail]
 *
 *   --serial  one suite at a time, streamed live (what `--bail` needs, and the
 *             mode to use when a suite's own output is what you are reading)
 *   --bail    stop at the first failing suite; implies --serial, because a
 *             suite that is already running cannot be "not run"
 */
import { spawn } from "node:child_process";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanStaleTestTempDirs } from "./clean-stale-test-temp.mjs";

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

/**
 * Mocha's spec reporter epilogue: "4050 passing (5m)" / "2 failing".
 *
 * Summed across every epilogue in the output, not read off the last one: the
 * extension suite splits itself across several extension hosts, so a sharded
 * run prints one epilogue per shard and reading only the last would report a
 * fraction of the tests -- and, worse, would miss an earlier shard's failures.
 */
export function describeMochaRun(lines) {
  const passing = sumMatches(lines, /^\s*(\d+) passing\b/);
  if (passing === undefined) return undefined;
  const failing = sumMatches(lines, /^\s*(\d+) failing\b/);
  const pending = sumMatches(lines, /^\s*(\d+) pending\b/);
  const parts = [`${passing} passing`];
  if (pending !== undefined) parts.push(`${pending} pending`);
  parts.push(`${failing ?? 0} failing`);
  return parts.join(", ");
}

/** Total of every capture-group-1 match, or undefined if the pattern never hit. */
function sumMatches(lines, pattern) {
  let total;
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match) total = (total ?? 0) + Number(match[1]);
  }
  return total;
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
 * Only the epilogue lists are read. The spec reporter names every failure twice
 * -- once inline as it walks the tree ("1) resumes a run", the bare title) and
 * once in the epilogue (suite and title, on separate lines) -- and the two
 * forms are different strings, so deduping cannot merge them. Reading both
 * would report one broken test as two.
 *
 * "lists" plural: a sharded extension run concatenates one whole spec report
 * per shard, so each `N failing` line opens its own epilogue region that runs
 * until the next shard's report begins.
 */
export function mochaFailures(lines) {
  const found = [];
  let sawEpilogue = false;

  for (const [index, line] of lines.entries()) {
    const failing = /^\s*(\d+) failing\b/.exec(line);
    if (!failing) continue;
    sawEpilogue = true;
    // The count on the `N failing` line is what bounds the list: without it,
    // scanning to the next epilogue would swallow the following shard's tree
    // walk and report its inline markers as extra failures.
    found.push(...readEpilogueEntries(lines, index + 1, Number(failing[1])));
  }

  // No epilogue at all (the run died before printing one) leaves the inline
  // markers as the only thing to go on.
  return sawEpilogue ? found : inlineMochaFailures(lines, 0, lines.length);
}

/** The `wanted` numbered entries Mocha lists after its `N failing` line. */
function readEpilogueEntries(lines, from, wanted) {
  const found = [];
  for (
    let index = from;
    index < lines.length && found.length < wanted;
    index++
  ) {
    // A `N passing` line means the next shard's report has begun, so this
    // shard's list was shorter than it claimed -- stop rather than read on.
    if (/^\s*\d+ passing\b/.test(lines[index])) break;
    if (!/^\s*\d+\)\s+\S/.test(lines[index])) continue;
    const head = lines[index].trim().replace(/^\d+\)\s*/, "");
    const next = (lines[index + 1] ?? "").trim();
    found.push(next.endsWith(":") ? `${head} > ${next.slice(0, -1)}` : head);
  }
  return found;
}

function inlineMochaFailures(lines, from, to) {
  const found = [];
  for (let index = from; index < to; index++) {
    if (/^\s*\d+\)\s+\S/.test(lines[index])) {
      found.push(lines[index].trim().replace(/^\d+\)\s*/, ""));
    }
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
 * How much of the machine each suite may use.
 *
 * The three suites run at once, so their internal parallelism has to be
 * budgeted together -- left to their own defaults, Vitest alone would claim
 * every core and then contend with six extension hosts for them.
 *
 * A shard of the extension suite is one whole VS Code instance running its
 * files in order, so it is worth about one core, and the cap is there because
 * each one pays a few seconds of VS Code startup and extension activation
 * before its first test -- past six shards that fixed cost outgrows the
 * shrinking slice of test files it buys.
 */
export function planParallelism(cpus) {
  const extensionShards = Math.min(6, Math.max(1, Math.floor(cpus / 4)));
  // Whatever is left, holding back a core for this orchestrator and one for the
  // short packaging suite.
  const uiWorkers = Math.max(2, cpus - extensionShards - 2);
  return { extensionShards, uiWorkers };
}

/**
 * The suites `npm test` covers. Each one stays a plain npm script so it can
 * still be run on its own -- `rerun` is the script the summary points a reader
 * at, which for the extension suite is the compiling wrapper rather than the
 * bare runner this file invokes once `compile-tests` has already run.
 */
export const TEST_SUITES = [
  {
    key: "extension",
    script: "test:extension:run",
    rerun: "test:extension",
    describe: describeMochaRun,
    failures: mochaFailures,
    env: (plan) => ({
      CTRLYOKE_TEST_SHARD_COUNT: String(plan.extensionShards),
    }),
  },
  {
    key: "ui",
    script: "test:ui",
    describe: describeVitestRun,
    failures: vitestFailures,
    env: (plan) => ({ CTRLYOKE_UI_TEST_WORKERS: String(plan.uiWorkers) }),
  },
  {
    key: "packaging",
    script: "test:packaging",
    describe: describeNodeTestRun,
    failures: nodeTestFailures,
  },
];

/**
 * Compiled once, up front, instead of inside `test:extension`. Both the
 * extension suite and the packaging suite read `out/`, so a compile running
 * concurrently with either one is a race.
 */
export const PREPARE_SCRIPT = "compile-tests";

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
  const chunks = [];
  let partial = "";
  return {
    push(text) {
      chunks.push(text);
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
    /** The bytes exactly as they arrived, for replaying a buffered suite. */
    raw: () => chunks.join(""),
  };
}

/**
 * Spawns one npm script, capturing its output for the summary.
 *
 * `live` decides where the bytes go on the way past: straight to the terminal
 * when suites run one at a time, or held in the capture and flushed as one
 * block by the caller when they run together. Either way nothing is discarded.
 */
function runScript({ script, env, live }) {
  return new Promise((resolveScript) => {
    const startedAt = Date.now();
    const capture = createCapture();
    const child = spawn("npm", ["run", script], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        // Reporters drop colour when they see a pipe. Since the pipe is ours
        // and the raw bytes go straight back out, hand the colour back whenever
        // the real terminal can show it -- parsing strips it either way.
        ...(process.stdout.isTTY ? { FORCE_COLOR: "1" } : {}),
        ...env,
      },
      shell: IS_WINDOWS,
      stdio: ["inherit", "pipe", "pipe"],
    });

    const consume = (chunk, stream) => {
      const text = chunk.toString();
      if (live) stream.write(chunk);
      capture.push(text);
    };
    child.stdout.on("data", (chunk) => consume(chunk, process.stdout));
    child.stderr.on("data", (chunk) => consume(chunk, process.stderr));

    const settle = (code) =>
      resolveScript({
        code,
        lines: capture.finish(),
        raw: capture.raw(),
        durationMs: Date.now() - startedAt,
      });

    child.on("error", (error) => {
      process.stderr.write(`\nFailed to start ${script}: ${error}\n`);
      settle(1);
    });
    child.on("close", (code) => settle(code ?? 1));
  });
}

async function runSuite(suite, plan, live) {
  const run = await runScript({
    script: suite.script,
    env: suite.env?.(plan),
    live,
  });
  const ok = run.code === 0;
  return {
    key: suite.key,
    script: suite.rerun ?? suite.script,
    status: ok ? SUITE_STATUS.PASS : SUITE_STATUS.FAIL,
    detail: suite.describe(run.lines),
    failures: ok ? [] : suite.failures(run.lines),
    durationMs: run.durationMs,
    output: live ? undefined : run.raw,
  };
}

function skipped(suite) {
  return {
    key: suite.key,
    script: suite.rerun ?? suite.script,
    status: SUITE_STATUS.SKIP,
    failures: [],
    durationMs: 0,
  };
}

function flushSuiteOutput(result) {
  if (result.output === undefined) return;
  const banner = `${RULE}\n ${result.key} suite output\n${RULE}\n`;
  process.stdout.write(`\n${banner}${result.output}`);
}

/** A line every half minute, so a long silent parallel run still shows life. */
function startProgressTicker(pending) {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (pending.size === 0) return;
    process.stdout.write(
      `  ... ${formatDuration(Date.now() - startedAt)} elapsed, ` +
        `still running: ${[...pending].join(", ")}\n`
    );
  }, 30_000);
  timer.unref();
  return () => clearInterval(timer);
}

async function runSuitesSerially(bail, plan) {
  const results = [];
  for (const suite of TEST_SUITES) {
    const result = await runSuite(suite, plan, true);
    results.push(result);
    if (bail && result.status === SUITE_STATUS.FAIL) break;
  }
  return [...results, ...TEST_SUITES.slice(results.length).map(skipped)];
}

async function runSuitesConcurrently(plan) {
  const pending = new Set(TEST_SUITES.map((suite) => suite.key));
  const stopTicker = startProgressTicker(pending);
  try {
    return await Promise.all(
      TEST_SUITES.map(async (suite) => {
        const result = await runSuite(suite, plan, false);
        pending.delete(suite.key);
        // Flush as each suite lands rather than all at the end, so the first
        // finisher's output is readable while the others are still going.
        flushSuiteOutput(result);
        return result;
      })
    );
  } finally {
    stopTicker();
  }
}

async function main() {
  const bail = process.argv.includes("--bail");
  // `--bail` means "the later suites did not run", which concurrency cannot
  // honour -- by the time one suite fails the others are already going.
  const serial = bail || process.argv.includes("--serial");
  const plan = planParallelism(availableParallelism());

  // Sweeps up whatever a previous run's crash, kill, or --bail left behind in
  // the OS temp folder before its own teardown could run -- see
  // clean-stale-test-temp.mjs. Cheap (a readdir plus a stat per candidate),
  // so it runs unconditionally rather than behind a flag.
  const swept = cleanStaleTestTempDirs();
  if (swept.removed > 0) {
    process.stdout.write(
      `Cleaned up ${swept.removed}/${swept.found} stale test temp dir(s) from ${tmpdir()}.\n`
    );
  }

  process.stdout.write(`\n${RULE}\n ${PREPARE_SCRIPT}\n${RULE}\n`);
  const prepared = await runScript({ script: PREPARE_SCRIPT, live: true });
  if (prepared.code !== 0) {
    process.stdout.write(
      renderSummary([
        {
          key: PREPARE_SCRIPT,
          script: PREPARE_SCRIPT,
          status: SUITE_STATUS.FAIL,
          detail: "compile failed -- no suite ran",
          failures: [],
          durationMs: prepared.durationMs,
        },
        ...TEST_SUITES.map(skipped),
      ])
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    serial
      ? `\nRunning ${TEST_SUITES.length} suites one at a time.\n`
      : `\nRunning ${TEST_SUITES.length} suites together ` +
          `(${plan.extensionShards} extension shards, ` +
          `${plan.uiWorkers} UI workers).\n`
  );

  const results = serial
    ? await runSuitesSerially(bail, plan)
    : await runSuitesConcurrently(plan);

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
