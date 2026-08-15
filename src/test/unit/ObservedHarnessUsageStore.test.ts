import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  HARNESS_IDS,
  RUN_HISTORY_LOCATIONS,
  WORKFLOW_TOKEN_COVERAGE,
} from "../../types/DashboardConstants";
import type {
  HarnessId,
  WorkflowKey,
  WorkflowTokenTotals,
} from "../../types/CtrlYokeTypes";
import { formatRunRef } from "../../utils/WorkflowPaths";
import {
  initializeRunHistoryLocation,
  resetRunHistoryLocationForTests,
} from "../../utils/RunHistoryStoragePolicy";
import {
  ObservedHarnessUsageStore,
  OBSERVED_USAGE_SCHEMA_VERSION,
} from "../../core/harness/shared/usage/ObservedHarnessUsageStore";

suite("ObservedHarnessUsageStore", () => {
  let workspaceRoot: string;
  let store: ObservedHarnessUsageStore;
  let originalCtrlyokeHome: string | undefined;
  const now = new Date(2026, 7, 9, 12, 0, 0).getTime();
  const workflowKey = "usage-test-workflow-2026" as WorkflowKey;
  const runRef = formatRunRef(now);

  setup(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-usage-"));
    originalCtrlyokeHome = process.env.CTRLYOKE_HOME;
    process.env.CTRLYOKE_HOME = workspaceRoot;
    store = new ObservedHarnessUsageStore(workspaceRoot);
  });

  teardown(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    if (originalCtrlyokeHome === undefined) {
      delete process.env.CTRLYOKE_HOME;
    } else {
      process.env.CTRLYOKE_HOME = originalCtrlyokeHome;
    }
  });

  function totals(
    byLocalDay: WorkflowTokenTotals["byLocalDay"]
  ): WorkflowTokenTotals {
    return {
      total: 100,
      coverage: WORKFLOW_TOKEN_COVERAGE.COMPLETE,
      reportedAttemptCount: 2,
      attemptCount: 2,
      isFinal: true,
      byHarness: {},
      byLocalDay,
    };
  }

  function subtotal(total: number) {
    return {
      input: total,
      output: 0,
      total,
      coverage: WORKFLOW_TOKEN_COVERAGE.COMPLETE,
      reportedAttemptCount: 1,
      attemptCount: 1,
    };
  }

  test("buckets local days into Monday ISO weeks and calendar months", async () => {
    await store.upsertRunContribution(
      workflowKey,
      runRef,
      totals({ "2026-08-08": { [HARNESS_IDS.CLAUDE_CLI]: subtotal(12) } }),
      now
    );

    const data = await store.read(now);
    assert.strictEqual(
      data.buckets.daily["2026-08-08"]?.[HARNESS_IDS.CLAUDE_CLI]?.total,
      12
    );
    assert.strictEqual(
      data.buckets.weekly["2026-08-03"]?.[HARNESS_IDS.CLAUDE_CLI]?.total,
      12
    );
    assert.strictEqual(
      data.buckets.monthly["2026-08-01"]?.[HARNESS_IDS.CLAUDE_CLI]?.total,
      12
    );
  });

  test("attributes mixed harnesses and multi-day runs independently", async () => {
    await store.upsertRunContribution(
      workflowKey,
      runRef,
      totals({
        "2026-08-03": { [HARNESS_IDS.CLAUDE_CLI]: subtotal(7) },
        "2026-08-08": { [HARNESS_IDS.CODEX_CLI]: subtotal(11) },
      }),
      now
    );

    const data = await store.read(now);
    assert.strictEqual(
      data.buckets.daily["2026-08-03"]?.[HARNESS_IDS.CLAUDE_CLI]?.total,
      7
    );
    assert.strictEqual(
      data.buckets.daily["2026-08-08"]?.[HARNESS_IDS.CODEX_CLI]?.total,
      11
    );
    assert.strictEqual(
      data.buckets.monthly["2026-08-01"]?.[HARNESS_IDS.CLAUDE_CLI]?.total,
      7
    );
    assert.strictEqual(
      data.buckets.monthly["2026-08-01"]?.[HARNESS_IDS.CODEX_CLI]?.total,
      11
    );
  });

  test("replaces a same-run continuation and repeated terminal notification", async () => {
    const first = totals({
      "2026-08-08": { [HARNESS_IDS.CLAUDE_CLI]: subtotal(12) },
    });
    const replacement = totals({
      "2026-08-08": { [HARNESS_IDS.CLAUDE_CLI]: subtotal(4) },
      "2026-08-09": { [HARNESS_IDS.CODEX_CLI]: subtotal(6) },
    });
    await store.upsertRunContribution(workflowKey, runRef, first, now);
    await store.upsertRunContribution(workflowKey, runRef, replacement, now);
    await store.upsertRunContribution(workflowKey, runRef, replacement, now);

    const data = await store.read(now);
    assert.strictEqual(
      data.buckets.monthly["2026-08-01"]?.[HARNESS_IDS.CLAUDE_CLI]?.total,
      4
    );
    assert.strictEqual(
      data.buckets.monthly["2026-08-01"]?.[HARNESS_IDS.CODEX_CLI]?.total,
      6
    );
    assert.strictEqual(Object.keys(data.runs).length, 1);
  });

  test("recovers from corrupt data without blocking the next write", async () => {
    await fs.mkdir(path.dirname(store.getPath()), { recursive: true });
    await fs.writeFile(store.getPath(), "not-json", "utf8");

    await store.upsertRunContribution(
      workflowKey,
      runRef,
      totals({ "2026-08-09": { [HARNESS_IDS.CLAUDE_CLI]: subtotal(3) } }),
      now
    );

    const data = await store.read(now);
    assert.strictEqual(data.schemaVersion, OBSERVED_USAGE_SCHEMA_VERSION);
    assert.strictEqual(
      data.buckets.daily["2026-08-09"]?.[HARNESS_IDS.CLAUDE_CLI]?.total,
      3
    );
    const files = await fs.readdir(path.dirname(store.getPath()));
    assert.ok(
      files.some((file) => file.startsWith("observed-usage.json.corrupt-"))
    );
  });

  test("prunes contributions that cannot affect current day, week, or month", async () => {
    await store.upsertRunContribution(
      workflowKey,
      runRef,
      totals({ "2026-07-01": { [HARNESS_IDS.CLAUDE_CLI]: subtotal(99) } }),
      now
    );

    const data = await store.read(now);
    assert.deepStrictEqual(data.runs, {});
    assert.deepStrictEqual(data.buckets.daily, {});
    assert.deepStrictEqual(data.buckets.weekly, {});
    assert.deepStrictEqual(data.buckets.monthly, {});
  });

  test("does not require byHarness to build observed usage", async () => {
    const harness: HarnessId = HARNESS_IDS.QWEN_CLI;
    await store.upsertRunContribution(
      workflowKey,
      runRef,
      totals({ "2026-08-09": { [harness]: subtotal(5) } }),
      now
    );
    const data = await store.read(now);
    assert.strictEqual(data.buckets.daily["2026-08-09"]?.[harness]?.total, 5);
  });

  test("folds buckets across user projects without re-counting runs", async () => {
    await writeProjectUsage("project-one", {
      [HARNESS_IDS.CLAUDE_CLI]: observedTokens(12),
    });
    await writeProjectUsage("project-two", {
      [HARNESS_IDS.CLAUDE_CLI]: observedTokens(8),
      [HARNESS_IDS.CODEX_CLI]: observedTokens(4),
    });

    const data = JSON.parse(
      await fs.readFile(
        new ObservedHarnessUsageStore(
          path.join(workspaceRoot, "project-one")
        ).getPath(),
        "utf8"
      )
    ) as {
      buckets: {
        daily: Record<string, Record<string, { total: number }>>;
      };
    };
    data.buckets.daily["2026-08-09"][HARNESS_IDS.CLAUDE_CLI].total = 99;
    await fs.writeFile(
      new ObservedHarnessUsageStore(
        path.join(workspaceRoot, "project-one")
      ).getPath(),
      JSON.stringify({
        schemaVersion: OBSERVED_USAGE_SCHEMA_VERSION,
        updatedAt: now,
        runs: {
          "same-run": {
            workflowKey: "same-workflow",
            runRef: "same-run",
            updatedAt: now,
            byLocalDay: {
              "2026-08-09": {
                [HARNESS_IDS.CLAUDE_CLI]: {
                  input: 500,
                  output: 0,
                  total: 500,
                },
              },
            },
          },
        },
        buckets: data.buckets,
      }),
      "utf8"
    );

    const rolledUp = await store.readForDisplay(now);
    assert.strictEqual(
      rolledUp.daily["2026-08-09"]?.[HARNESS_IDS.CLAUDE_CLI]?.total,
      107
    );
    assert.strictEqual(
      rolledUp.daily["2026-08-09"]?.[HARNESS_IDS.CODEX_CLI]?.total,
      4
    );
  });

  test("skips malformed project usage files", async () => {
    await writeProjectUsage("valid-project", {
      [HARNESS_IDS.CLAUDE_CLI]: observedTokens(7),
    });
    const malformedPath = path.join(
      workspaceRoot,
      "projects",
      "malformed-project",
      ".usage",
      "observed-usage.json"
    );
    await fs.mkdir(path.dirname(malformedPath), { recursive: true });
    await fs.writeFile(malformedPath, '{"schemaVersion":1', "utf8");

    const rolledUp = await store.readForDisplay(now);
    assert.strictEqual(
      rolledUp.daily["2026-08-09"]?.[HARNESS_IDS.CLAUDE_CLI]?.total,
      7
    );
  });

  test("uses the current project only in workspace mode", async () => {
    await writeProjectUsage("user-project", {
      [HARNESS_IDS.CLAUDE_CLI]: observedTokens(50),
    });

    resetRunHistoryLocationForTests();
    initializeRunHistoryLocation(RUN_HISTORY_LOCATIONS.WORKSPACE);
    try {
      const workspaceStore = new ObservedHarnessUsageStore(workspaceRoot);
      await workspaceStore.upsertRunContribution(
        workflowKey,
        runRef,
        totals({
          "2026-08-09": {
            [HARNESS_IDS.CLAUDE_CLI]: subtotal(3),
          },
        }),
        now
      );

      const rolledUp = await workspaceStore.readForDisplay(now);
      assert.strictEqual(
        rolledUp.daily["2026-08-09"]?.[HARNESS_IDS.CLAUDE_CLI]?.total,
        3
      );
    } finally {
      resetRunHistoryLocationForTests();
      initializeRunHistoryLocation(RUN_HISTORY_LOCATIONS.USER);
    }
  });

  async function writeProjectUsage(
    projectName: string,
    harnesses: Record<string, ReturnType<typeof observedTokens>>
  ): Promise<void> {
    const projectStore = new ObservedHarnessUsageStore(
      path.join(workspaceRoot, projectName)
    );
    const filePath = projectStore.getPath();
    const bucket = {
      "2026-08-09": harnesses,
    };
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: OBSERVED_USAGE_SCHEMA_VERSION,
        updatedAt: now,
        runs: {},
        buckets: {
          daily: bucket,
          weekly: { "2026-08-03": harnesses },
          monthly: { "2026-08-01": harnesses },
        },
      }),
      "utf8"
    );
  }

  function observedTokens(total: number) {
    return {
      input: total,
      output: 0,
      total,
      since: new Date(2026, 7, 9).getTime(),
    };
  }
});
