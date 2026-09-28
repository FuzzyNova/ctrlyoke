import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  EXECUTION_STATES,
  HARNESS_IDS,
  WORKFLOW_TOKEN_COVERAGE,
} from "../../types/DashboardConstants";
import type {
  RunRef,
  WorkflowKey,
  WorkflowTokenTotals,
} from "../../types/CtrlYokeTypes";
import type {
  LifetimeHarnessContribution,
  LifetimeRunContribution,
} from "../../types/UsageTypes";
import type { WorkflowRunManifest } from "../../types/WorkflowTimelineTypes";
import {
  LifetimeUsageStore,
  LIFETIME_USAGE_ERROR_CODES,
} from "../../core/harness/shared/usage/LifetimeUsageStore";
import { formatRunRef, manifestPath, runDir } from "../../utils/WorkflowPaths";

suite("LifetimeUsageStore", () => {
  suiteSetup(function () {
    this.timeout(30000);
  });
  let workspaceRoot: string;
  let store: LifetimeUsageStore;
  const baseTime = Date.UTC(2026, 7, 1, 12, 0, 0);
  const workflowKey = "lifetime-test-workflow-2026" as WorkflowKey;

  setup(async () => {
    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-lifetime-")
    );
    store = new LifetimeUsageStore(workspaceRoot);
  });

  teardown(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  function harnessContribution(total: number): LifetimeHarnessContribution {
    return {
      input: total,
      output: 0,
      total,
      attemptCount: 1,
      reportedAttemptCount: 1,
    };
  }

  function contribution(
    runRef: RunRef,
    total: number,
    updatedAt = baseTime
  ): LifetimeRunContribution {
    return {
      workflowKey,
      runRef,
      updatedAt,
      startedAt: baseTime,
      completedAt: baseTime + 1000,
      executionState: EXECUTION_STATES.COMPLETED,
      stepCount: 1,
      activeExecutionMs: 500,
      byHarness: {
        [HARNESS_IDS.CLAUDE_CLI]: harnessContribution(total),
      },
    };
  }

  function tokenTotals(total: number): WorkflowTokenTotals {
    return {
      total,
      coverage: WORKFLOW_TOKEN_COVERAGE.COMPLETE,
      reportedAttemptCount: 1,
      attemptCount: 1,
      isFinal: true,
      byHarness: {
        [HARNESS_IDS.CLAUDE_CLI]: {
          ...harnessContribution(total),
          coverage: WORKFLOW_TOKEN_COVERAGE.COMPLETE,
        },
      },
      byLocalDay: {},
    };
  }

  async function writeManifest(
    runRef: RunRef,
    total: number,
    lastUpdatedAt = baseTime
  ): Promise<void> {
    const filePath = manifestPath(workspaceRoot, workflowKey, runRef);
    await fs.mkdir(runDir(workspaceRoot, workflowKey, runRef), {
      recursive: true,
    });
    const manifest: WorkflowRunManifest = {
      schemaVersion: 1,
      storageKind: "timeline",
      workflowId: workflowKey,
      runId: 1,
      startedAt: baseTime,
      completedAt: baseTime + 1000,
      activeExecutionMs: 500,
      executionState: EXECUTION_STATES.COMPLETED,
      definitionRevision: 1,
      stepCount: 1,
      eventCount: 1,
      nextSequence: 2,
      lastUpdatedAt,
      tokenTotals: tokenTotals(total),
    };
    await fs.writeFile(filePath, JSON.stringify(manifest), "utf8");
  }

  test("repeated identical feeds do not double-count", async () => {
    const runRef = formatRunRef(baseTime);
    const run = contribution(runRef, 12);
    await store.upsertRunContribution(run, baseTime);
    await store.upsertRunContribution(run, baseTime + 1);

    const data = await store.read(baseTime + 1);
    assert.strictEqual(data.runCount, 1);
    assert.strictEqual(data.totals.total, 12);
    assert.strictEqual(data.totals.attemptCount, 1);
  });

  test("revises an old run after its recent cache entry is evicted", async () => {
    const oldRunRef = formatRunRef(baseTime);
    await writeManifest(oldRunRef, 10);
    await store.upsertRunContribution(contribution(oldRunRef, 10), baseTime);

    for (let index = 1; index <= 200; index++) {
      const runRef = formatRunRef(baseTime + index * 1000);
      await writeManifest(runRef, 1, baseTime + index * 1000);
      await store.upsertRunContribution(
        contribution(runRef, 1, baseTime + index * 1000),
        baseTime + index * 1000
      );
    }

    await writeManifest(oldRunRef, 25, baseTime + 201000);
    store.clearRecentContributionCache();
    await store.upsertRunContribution(
      contribution(oldRunRef, 25, baseTime + 201000),
      baseTime + 201000
    );

    const data = await store.read(baseTime + 201000);
    assert.strictEqual(data.runCount, 201);
    assert.strictEqual(data.totals.total, 225);
    assert.strictEqual(data.totals.attemptCount, 201);
  });

  test("quarantines corrupt data and returns an empty store", async () => {
    await fs.mkdir(path.dirname(store.getPath()), { recursive: true });
    await fs.writeFile(store.getPath(), "not-json", "utf8");

    const data = await store.read(baseTime);
    assert.strictEqual(data.runCount, 0);
    assert.strictEqual(data.totals.total, 0);
    assert.strictEqual(
      store.getLastErrorCode(),
      LIFETIME_USAGE_ERROR_CODES.MALFORMED_DATA
    );
    const files = await fs.readdir(path.dirname(store.getPath()));
    assert.ok(
      files.some((file) => file.startsWith("lifetime-stats.json.corrupt-"))
    );
  });
});
