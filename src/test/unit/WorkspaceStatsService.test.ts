import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  EXECUTION_STATES,
  HARNESS_IDS,
  WORKFLOW_TOKEN_COVERAGE,
  WORKSPACE_STATS_BACKFILL_STATES,
} from "../../types/DashboardConstants";
import type { WorkflowRunManifest } from "../../types/WorkflowTimelineTypes";
import type { LifetimeBackfillBatch } from "../../core/harness/shared/usage/LifetimeUsageStore";
import { LifetimeUsageStore } from "../../core/harness/shared/usage/LifetimeUsageStore";
import { WorkspaceStatsService } from "../../core/harness/shared/usage/WorkspaceStatsService";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import type { WorkflowKey } from "../../types/CtrlYokeTypes";

suite("WorkspaceStatsService", () => {
  let workspaceRoot: string;
  const baseTime = Date.UTC(2026, 7, 1, 12, 0, 0);

  setup(async () => {
    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-workspace-stats-")
    );
  });

  teardown(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  function tokenTotals(total: number) {
    return {
      total,
      coverage: WORKFLOW_TOKEN_COVERAGE.COMPLETE,
      reportedAttemptCount: 1,
      attemptCount: 1,
      isFinal: true,
      byHarness: {
        [HARNESS_IDS.CLAUDE_CLI]: {
          input: total,
          output: 0,
          total,
          coverage: WORKFLOW_TOKEN_COVERAGE.COMPLETE,
          reportedAttemptCount: 1,
          attemptCount: 1,
        },
      },
      byLocalDay: {},
    };
  }

  async function writeRun(
    workflowKey: WorkflowKey,
    timestamp: number,
    total: number,
    rawManifest?: string
  ): Promise<ReturnType<typeof WorkflowPaths.formatRunRef>> {
    const runRef = WorkflowPaths.formatRunRef(timestamp);
    await fs.mkdir(WorkflowPaths.runDir(workspaceRoot, workflowKey, runRef), {
      recursive: true,
    });
    const manifest: WorkflowRunManifest = {
      schemaVersion: 2,
      storageKind: "timeline",
      workflowId: workflowKey,
      runId: 1,
      startedAt: timestamp,
      completedAt: timestamp + 1000,
      executionState: EXECUTION_STATES.COMPLETED,
      definitionRevision: 1,
      stepCount: 1,
      eventCount: 1,
      nextSequence: 2,
      lastUpdatedAt: timestamp + 1000,
      tokenTotals: tokenTotals(total),
    };
    await fs.writeFile(
      WorkflowPaths.manifestPath(workspaceRoot, workflowKey, runRef),
      rawManifest ?? JSON.stringify(manifest),
      "utf8"
    );
    return runRef;
  }

  async function createLineage(workflowKey: WorkflowKey): Promise<void> {
    await fs.mkdir(
      path.join(WorkflowPaths.lineageDir(workspaceRoot, workflowKey), "draft"),
      { recursive: true }
    );
  }

  test("counts draft-only workflows and is idempotent across passes", async () => {
    const draftOnly = "draft-only-workflow" as WorkflowKey;
    const withRuns = "stats-workflow" as WorkflowKey;
    await createLineage(draftOnly);
    await createLineage(withRuns);
    await writeRun(withRuns, baseTime, 7);
    await writeRun(withRuns, baseTime + 1000, 9);

    const service = new WorkspaceStatsService(workspaceRoot);
    const first = await service.refresh();
    const second = await service.refresh();
    assert.strictEqual(first.workflowCount, 2);
    assert.strictEqual(first.runCount, 2);
    assert.strictEqual(first.totals.total, 16);
    assert.strictEqual(second.runCount, 2);
    assert.strictEqual(second.totals.total, 16);
    assert.strictEqual(
      second.backfill.state,
      WORKSPACE_STATS_BACKFILL_STATES.COMPLETE
    );
  });

  test("uses the counted interval when lineage mtimes are stale or unavailable", async () => {
    const workflowKey = "stale-mtime-workflow" as WorkflowKey;
    await createLineage(workflowKey);
    await writeRun(workflowKey, baseTime, 5);
    const service = new WorkspaceStatsService(workspaceRoot);
    await service.refresh();
    const firstMtime = (
      await fs.stat(WorkflowPaths.lineageDir(workspaceRoot, workflowKey))
    ).mtimeMs;

    await writeRun(workflowKey, baseTime - 1000, 3);
    await fs.utimes(
      WorkflowPaths.lineageDir(workspaceRoot, workflowKey),
      new Date(firstMtime),
      new Date(firstMtime + 1000)
    );
    let snapshot = await new WorkspaceStatsService(workspaceRoot).refresh();
    assert.strictEqual(snapshot.runCount, 2);
    assert.strictEqual(snapshot.totals.total, 8);

    await writeRun(workflowKey, baseTime - 2000, 2);
    snapshot = await new WorkspaceStatsService(workspaceRoot, undefined, {
      stat: async () => {
        throw Object.assign(new Error("stat unavailable"), { code: "EIO" });
      },
    }).refresh();
    assert.strictEqual(snapshot.runCount, 3);
    assert.strictEqual(snapshot.totals.total, 10);
  });

  test("discloses unreadable manifests instead of dropping them", async () => {
    const workflowKey = "unreadable-workflow" as WorkflowKey;
    await createLineage(workflowKey);
    await writeRun(workflowKey, baseTime, 0, "not-json");

    const snapshot = await new WorkspaceStatsService(workspaceRoot).refresh();
    assert.strictEqual(snapshot.runCount, 0);
    assert.strictEqual(snapshot.skippedRunCount, 1);
  });

  test("resumes from a persisted mid-scan checkpoint", async () => {
    const workflowKey = "checkpoint-workflow" as WorkflowKey;
    await createLineage(workflowKey);
    for (let index = 0; index < 34; index++) {
      await writeRun(workflowKey, baseTime + index * 1000, 1);
    }

    class InterruptingStore extends LifetimeUsageStore {
      private calls = 0;

      override async applyBackfillBatch(
        batch: LifetimeBackfillBatch,
        now?: number
      ): Promise<void> {
        this.calls++;
        if (this.calls === 2) throw new Error("interrupted");
        await super.applyBackfillBatch(batch, now);
      }
    }

    await new WorkspaceStatsService(
      workspaceRoot,
      new InterruptingStore(workspaceRoot)
    ).refresh();
    const resumed = await new WorkspaceStatsService(workspaceRoot).refresh();
    assert.strictEqual(resumed.runCount, 34);
    assert.strictEqual(resumed.totals.total, 34);
  });
});
