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
import { WorkspaceStatsService } from "../../core/harness/shared/usage/WorkspaceStatsService";

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
      schemaVersion: 2,
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

  test("rebuilds a live-upsert lineage when a backfill batch has older refs", async () => {
    const olderRefs = [0, 1, 2].map((index) =>
      formatRunRef(baseTime + index * 1000)
    );
    for (const [index, runRef] of olderRefs.entries()) {
      await writeManifest(runRef, index + 1);
    }
    const newestRunRef = formatRunRef(baseTime + 3000);
    await writeManifest(newestRunRef, 4);
    await store.upsertRunContribution(contribution(newestRunRef, 4));

    await store.applyBackfillBatch({
      workflowKey,
      runRefs: olderRefs,
      contributions: olderRefs.map((runRef, index) =>
        contribution(runRef, index + 1)
      ),
      skippedRunCount: 0,
    });

    const data = await store.read(baseTime + 1);
    assert.strictEqual(data.runCount, 4);
    assert.strictEqual(data.totals.total, 10);
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

  test("keeps skipped run counts stable when a fresh store rescans a lineage", async () => {
    const readableRunRef = formatRunRef(baseTime);
    await writeManifest(readableRunRef, 10);
    const unreadableRunRef = formatRunRef(baseTime + 1000);
    await fs.mkdir(runDir(workspaceRoot, workflowKey, unreadableRunRef), {
      recursive: true,
    });
    const initial = await new WorkspaceStatsService(workspaceRoot).refresh();
    assert.strictEqual(initial.skippedRunCount, 1);

    const freshStore = new LifetimeUsageStore(workspaceRoot);
    const revised = contribution(readableRunRef, 15);
    revised.byHarness[HARNESS_IDS.CLAUDE_CLI]!.costSources = [
      "harness-reported",
    ];
    await freshStore.upsertRunContribution(revised, baseTime + 2000);

    const afterRescan = await freshStore.read(baseTime + 2000);
    assert.strictEqual(afterRescan.skippedRunCount, 1);
    assert.strictEqual(afterRescan.lineages[workflowKey].skippedRunCount, 1);
  });

  test("rebuilds persisted data when a lineage has no skipped run count", async () => {
    await writeManifest(formatRunRef(baseTime), 10);
    await store.upsertRunContribution(contribution(formatRunRef(baseTime), 10));
    const stored = await store.read(baseTime);
    const legacy = JSON.parse(JSON.stringify(stored)) as typeof stored;
    delete (
      legacy.lineages[workflowKey] as Partial<
        (typeof legacy.lineages)[typeof workflowKey]
      >
    ).skippedRunCount;
    await fs.writeFile(store.getPath(), JSON.stringify(legacy), "utf8");

    const reader = new LifetimeUsageStore(workspaceRoot);
    const rebuilt = await reader.read(baseTime + 1);
    assert.strictEqual(rebuilt.runCount, 0);
    assert.strictEqual(rebuilt.skippedRunCount, 0);
    // An older shape is not corruption: no error, nothing quarantined.
    assert.strictEqual(reader.getLastErrorCode(), undefined);
    const siblings = await fs.readdir(path.dirname(store.getPath()));
    assert.ok(
      !siblings.some((name) => name.includes(".corrupt-")),
      siblings.join(", ")
    );
  });
});
