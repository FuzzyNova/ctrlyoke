import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  createWorkflowLineageNotFoundError,
  resolveCliRunRef,
  resolveCliRunRefAtLineage,
} from "../../cli/CliRunSelector";
import type { OutputHistoryManager } from "../../core/orchestration/OutputHistoryManager";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";
import type { RunSummary } from "../../types/WorkflowTimelineTypes";
import * as WorkflowPaths from "../../utils/WorkflowPaths";

const workflowKey = "release-2026-07-20T10-30-00-000" as WorkflowKey;

function summary(
  runId: number,
  timestamp: number,
  key: WorkflowKey = workflowKey
): RunSummary {
  const runRef = WorkflowPaths.formatRunRef(timestamp);
  return {
    workflowKey: key,
    runRef,
    runDirectory: WorkflowPaths.runDir(".", key, runRef),
    runId,
    startedAt: timestamp,
    executionState: "completed",
    definitionRevision: 1,
    stepCount: 1,
    hasMixedHarnesses: false,
    hasMixedModels: false,
  };
}

function historyWith(summaries: RunSummary[]): OutputHistoryManager {
  return {
    getRunSummaries: async () => summaries,
  } as unknown as OutputHistoryManager;
}

suite("CliRunSelector", () => {
  test("parses a stable RunRef selector without treating it as a path", async () => {
    const selected = summary(7, 7_000);
    const resolved = await resolveCliRunRef(
      historyWith([selected]),
      workflowKey,
      selected.runRef,
      "--run"
    );

    assert.strictEqual(resolved, selected.runRef);
  });

  test("resolves numeric run IDs rather than volatile list positions", async () => {
    const newest = summary(9, 9_000);
    const older = summary(3, 3_000);
    const resolved = await resolveCliRunRef(
      historyWith([newest, older]),
      workflowKey,
      "3",
      "--from"
    );

    assert.strictEqual(resolved, older.runRef);
  });

  test("does not fill numeric run-ID gaps from a run-list index", async () => {
    await assert.rejects(
      resolveCliRunRef(
        historyWith([summary(9, 9_000), summary(3, 3_000)]),
        workflowKey,
        "4",
        "--run"
      ),
      /Run ID "4" was not found/
    );
  });

  test("rejects ambiguous numeric selectors", async () => {
    await assert.rejects(
      resolveCliRunRef(
        historyWith([summary(5, 5_000), summary(5, 6_000)]),
        workflowKey,
        "5",
        "--from"
      ),
      /Ambiguous --from run ID/
    );
  });

  test("rejects missing stable selectors and defaults to the newest summary", async () => {
    const latest = summary(8, 8_000);
    const older = summary(2, 2_000);
    assert.strictEqual(
      await resolveCliRunRef(
        historyWith([latest, older]),
        workflowKey,
        undefined,
        "--from"
      ),
      latest.runRef
    );

    const missing = WorkflowPaths.formatRunRef(1_000) as RunRef;
    await assert.rejects(
      resolveCliRunRef(historyWith([latest]), workflowKey, missing, "--run"),
      /was not found/
    );
  });

  test("resolves selectors under the lineage metadata lock", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cli-selector-"));
    try {
      const created = await new WorkflowLineageRepository().createLineage(
        workspace,
        "selector",
        "Selector"
      );
      const selected = summary(1, 1_000, created.workflowKey);
      assert.strictEqual(
        await resolveCliRunRefAtLineage(
          workspace,
          historyWith([selected]),
          created.workflowKey,
          "1",
          "--run"
        ),
        selected.runRef
      );
      await assert.rejects(
        fs.access(
          `${WorkflowPaths.descriptorPath(workspace, created.workflowKey)}.lock`
        )
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("rejects a missing lineage before creating its descriptor lock", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cli-selector-"));
    const missingKey = "missing-workflow" as WorkflowKey;
    try {
      await assert.rejects(
        resolveCliRunRefAtLineage(
          workspace,
          historyWith([]),
          missingKey,
          "1",
          "--run"
        ),
        (error: Error) => {
          assert.strictEqual(
            error.message,
            createWorkflowLineageNotFoundError(missingKey).message
          );
          return true;
        }
      );
      await assert.rejects(
        fs.access(
          `${WorkflowPaths.descriptorPath(workspace, missingKey)}.lock`
        ),
        { code: "ENOENT" }
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
