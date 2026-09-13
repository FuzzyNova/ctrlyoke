import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PREPARE_SCRIPT,
  SUITE_STATUS,
  SUMMARY_ANCHOR,
  TEST_SUITES,
  describeMochaRun,
  describeNodeTestRun,
  describeVitestRun,
  formatDuration,
  mochaFailures,
  nodeTestFailures,
  planParallelism,
  renderSummary,
  stripAnsi,
  vitestFailures,
} from "./run-test-suites.mjs";

/** A passing result for a suite, so cases only state what they care about. */
function passing(key, detail) {
  return {
    key,
    script: `test:${key}`,
    status: SUITE_STATUS.PASS,
    detail,
    failures: [],
    durationMs: 1000,
  };
}

describe("test suite reporters", () => {
  it("reads Mocha's epilogue", () => {
    assert.equal(
      describeMochaRun(["  4050 passing (5m)", "  1 pending", "  2 failing"]),
      "4050 passing, 1 pending, 2 failing"
    );
  });

  it("reports zero failures when Mocha prints no failing line", () => {
    assert.equal(
      describeMochaRun(["  4050 passing (5m)"]),
      "4050 passing, 0 failing"
    );
  });

  it("reads Vitest's epilogue and swaps the repeated total for the file count", () => {
    assert.equal(
      describeVitestRun([
        " Test Files  232 passed (232)",
        "      Tests  2649 passed (2649)",
      ]),
      "2649 passed in 232 files"
    );
    assert.equal(
      describeVitestRun([
        " Test Files  1 failed | 231 passed (232)",
        "      Tests  3 failed | 2646 passed (2649)",
      ]),
      "3 failed | 2646 passed in 232 files"
    );
    assert.equal(
      describeVitestRun([
        " Test Files  1 failed (1)",
        "      Tests  1 failed | 1 passed (2)",
      ]),
      "1 failed | 1 passed in 1 file"
    );
  });

  it("reads node:test's TAP epilogue", () => {
    assert.equal(
      describeNodeTestRun(["# pass 20", "# fail 0"]),
      "20 pass, 0 fail"
    );
  });

  // The verdict always comes from the exit code, so an unrecognised epilogue
  // costs detail in the summary and nothing else.
  it("returns undefined rather than guessing when the epilogue is missing", () => {
    assert.equal(describeMochaRun(["some other output"]), undefined);
    assert.equal(describeVitestRun(["some other output"]), undefined);
    assert.equal(describeNodeTestRun(["some other output"]), undefined);
  });

  it("parses an epilogue that arrived with colour", () => {
    assert.equal(
      describeMochaRun([stripAnsi("  [32m4050 passing[0m (5m)")]),
      "4050 passing, 0 failing"
    );
  });
});

describe("test suite failure extraction", () => {
  // Verbatim shape of a real `mocha --reporter spec` run: the failure is named
  // inline as the reporter walks the tree, then again in the epilogue with the
  // suite on its own line. Both halves matter -- reading both reported one
  // broken test as two, and deduping cannot merge the differing forms.
  const MOCHA_RUN = [
    "  PromptQueue",
    "    ✔ keeps a passing case",
    "    1) resumes a paused run",
    "",
    "",
    "  1 passing (3ms)",
    "  1 failing",
    "",
    "  1) PromptQueue",
    "       resumes a paused run:",
    "     Error: boom",
    "      at Context.<anonymous> (spec.js:4:11)",
  ];

  it("names a Mocha failure once, from the epilogue", () => {
    assert.deepEqual(mochaFailures(MOCHA_RUN), [
      "PromptQueue > resumes a paused run",
    ]);
  });

  it("falls back to Mocha's inline markers when the run died early", () => {
    assert.deepEqual(mochaFailures(MOCHA_RUN.slice(0, 3)), [
      "resumes a paused run",
    ]);
  });

  it("keeps a Mocha failure whose next line is not a title", () => {
    assert.deepEqual(
      mochaFailures(["  1 failing", "  1) WorkflowExecutor", ""]),
      ["WorkflowExecutor"]
    );
  });

  // Verbatim shape of a real Vitest run, which names a failure twice the same
  // way -- inline with an unstable duration, then fully qualified.
  const VITEST_RUN = [
    " ❯ test/zzz-probe.test.ts (2 tests | 1 failed) 8ms",
    "     × keeps the row under the cursor 5ms",
    "",
    "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
    "",
    " FAIL  test/zzz-probe.test.ts > probe suite > keeps the row under the cursor",
    "AssertionError: expected 1 to be 2",
  ];

  it("names a Vitest failure once, fully qualified", () => {
    assert.deepEqual(vitestFailures(VITEST_RUN), [
      "test/zzz-probe.test.ts > probe suite > keeps the row under the cursor",
    ]);
  });

  it("falls back to Vitest's inline markers when there is no Failed Tests section", () => {
    assert.deepEqual(vitestFailures(VITEST_RUN.slice(0, 2)), [
      "keeps the row under the cursor 5ms",
    ]);
  });

  // Each shard prints a full spec report, so a later shard's tree walk sits
  // between one epilogue and the next. Scanning to the end of the output from
  // the first epilogue would pick those inline markers up as extra failures.
  it("reads each shard's Mocha epilogue without spilling into the next", () => {
    assert.deepEqual(
      mochaFailures([
        ...MOCHA_RUN,
        "  WorkflowExecutor",
        "    1) resumes a run",
        "",
        "  5 passing (9ms)",
        "  1 failing",
        "",
        "  1) WorkflowExecutor",
        "       resumes a run:",
        "     Error: boom",
      ]),
      ["PromptQueue > resumes a paused run", "WorkflowExecutor > resumes a run"]
    );
  });

  it("reads node:test's not-ok lines", () => {
    assert.deepEqual(
      nodeTestFailures(["ok 1 - fine", "not ok 2 - rejects a stale tag"]),
      ["rejects a stale tag"]
    );
  });
});

describe("test summary rendering", () => {
  it("anchors a clean run on a single unambiguous headline", () => {
    const summary = renderSummary([
      passing("extension", "4050 passing, 0 failing"),
      passing("ui", "2649 passed in 232 files"),
      passing("packaging", "20 pass, 0 fail"),
    ]);

    assert.match(summary, new RegExp(`${SUMMARY_ANCHOR} ALL 3 SUITES PASSED`));
    assert.doesNotMatch(summary, /FAIL/);
  });

  it("names every failing test and how to re-run just that suite", () => {
    const summary = renderSummary([
      passing("extension", "4050 passing, 0 failing"),
      {
        key: "ui",
        script: "test:ui",
        status: SUITE_STATUS.FAIL,
        detail: "3 failed | 2646 passed in 232 files",
        failures: ["Foo.test.tsx > renders", "Foo.test.tsx > renders"],
        durationMs: 80_000,
      },
      passing("packaging", "20 pass, 0 fail"),
    ]);

    assert.match(summary, new RegExp(`${SUMMARY_ANCHOR} 1 OF 3 SUITES FAILED`));
    assert.match(summary, /Re-run only this suite: {2}npm run test:ui/);
    // Vitest names a failure both inline and in its epilogue; listing it twice
    // would misstate how much is broken.
    assert.equal(summary.match(/Foo\.test\.tsx > renders/g)?.length, 1);
  });

  it("still reports a failure whose output it could not parse", () => {
    const summary = renderSummary([
      {
        key: "extension",
        script: "test:extension",
        status: SUITE_STATUS.FAIL,
        detail: undefined,
        failures: [],
        durationMs: 5000,
      },
    ]);

    assert.match(summary, new RegExp(`${SUMMARY_ANCHOR} 1 OF 1 SUITES FAILED`));
    assert.match(summary, /no counts parsed/);
    assert.match(summary, /no test names parsed/);
  });

  // A bailed run must not read as a pass just because nothing after the
  // failure got a chance to fail.
  it("marks suites that --bail skipped without calling the run clean", () => {
    const summary = renderSummary([
      {
        key: "extension",
        script: "test:extension",
        status: SUITE_STATUS.FAIL,
        detail: "4049 passing, 1 failing",
        failures: ["WorkflowExecutor > resumes"],
        durationMs: 5000,
      },
      {
        key: "ui",
        script: "test:ui",
        status: SUITE_STATUS.SKIP,
        failures: [],
        durationMs: 0,
      },
    ]);

    assert.match(summary, new RegExp(`${SUMMARY_ANCHOR} 1 OF 2 SUITES FAILED`));
    // The key column pads to the widest key, so `ui` carries the padding of
    // `extension` before the detail begins.
    assert.match(summary, /SKIP {2}ui\s+not run \(--bail\)$/m);
  });

  // A skipped suite has no duration to print, and the padding that lines the
  // column up would otherwise be left dangling off the end of the row.
  it("leaves no trailing whitespace on any row", () => {
    const summary = renderSummary([
      passing("extension", "4050 passing, 0 failing"),
      {
        key: "ui",
        script: "test:ui",
        status: SUITE_STATUS.SKIP,
        failures: [],
        durationMs: 0,
      },
    ]);

    assert.equal(
      summary.split("\n").filter((line) => /\s$/.test(line)).length,
      0
    );
  });
});

describe("test suite wiring", () => {
  // The summary tells a reader to run `npm run <script>`; a typo there sends
  // them to a script that does not exist.
  it("names only scripts package.json actually defines", async () => {
    const { default: packageJson } = await import("../package.json", {
      with: { type: "json" },
    });

    assert.ok(
      packageJson.scripts[PREPARE_SCRIPT],
      `package.json has no "${PREPARE_SCRIPT}" script`
    );
    for (const suite of TEST_SUITES) {
      for (const script of [suite.script, suite.rerun ?? suite.script]) {
        assert.ok(
          packageJson.scripts[script],
          `package.json has no "${script}" script`
        );
      }
    }
  });

  // The suites run concurrently, so the script this file spawns must not
  // compile -- the packaging suite reads `out/` at the same time. Compiling is
  // hoisted into PREPARE_SCRIPT, and the standalone `rerun` script is what
  // still chains a compile for someone running that suite by hand.
  it("spawns suite scripts that do not compile, and reruns that do", async () => {
    const { default: packageJson } = await import("../package.json", {
      with: { type: "json" },
    });

    for (const suite of TEST_SUITES) {
      assert.doesNotMatch(
        packageJson.scripts[suite.script],
        /compile/,
        `${suite.script} compiles, which races the concurrently running suites`
      );
    }
    assert.match(
      packageJson.scripts[
        TEST_SUITES.find((suite) => suite.key === "extension").rerun
      ],
      new RegExp(PREPARE_SCRIPT)
    );
  });

  it("gives every core to a suite without oversubscribing the machine", () => {
    for (const cpus of [1, 2, 4, 8, 12, 16, 24, 64]) {
      const { extensionShards, uiWorkers } = planParallelism(cpus);
      assert.ok(
        extensionShards >= 1 && extensionShards <= 6,
        `${cpus} cores produced ${extensionShards} extension shards`
      );
      assert.ok(uiWorkers >= 2, `${cpus} cores produced ${uiWorkers} workers`);
      // A small machine is allowed to oversubscribe -- both suites need at
      // least a worker each -- but a real one must not hand out more than it
      // has.
      if (cpus >= 8) {
        assert.ok(
          extensionShards + uiWorkers <= cpus,
          `${cpus} cores handed out ${extensionShards + uiWorkers}`
        );
      }
    }
  });

  it("formats durations at both ends of a run", () => {
    assert.equal(formatDuration(2100), "2.1s");
    assert.equal(formatDuration(80_000), "1m 20s");
    assert.equal(formatDuration(302_000), "5m 02s");
  });
});
