import * as assert from "assert";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { suite, test } from "mocha";
import {
  RecentWorkflowCatalog,
  RecentWorkflowPublisher,
  type RecentWorkflowCatalogHost,
} from "../../core/orchestration/RecentWorkflowCatalog";
import { OutputHistoryManager } from "../../core/orchestration/OutputHistoryManager";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";
import {
  EXECUTION_STATES,
  MESSAGE_TYPES,
  type ExecutionState,
} from "../../types/DashboardConstants";
import type { WorkflowKey, WorkflowSummary } from "../../types/CtrlYokeTypes";
import type { RecentWorkflowUpdatedMessage } from "../../types/WebviewMessageTypes";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

class TestCatalogHost implements RecentWorkflowCatalogHost {
  summaries: WorkflowSummary[] = [];
  /** Runs on every `getWorkflowSummaries` call, numbered from 1. */
  onSummariesRead?: (call: number) => void;
  private calls = 0;

  getWorkflowSummaries(): readonly WorkflowSummary[] {
    this.calls += 1;
    this.onSummariesRead?.(this.calls);
    return this.summaries;
  }

  async ensureExternalRunWatchSession(): Promise<boolean> {
    return false;
  }

  getOutputHistoryManager(workspaceRoot: string): OutputHistoryManager {
    return new OutputHistoryManager(workspaceRoot);
  }
}

function writeDraft(
  workspaceRoot: string,
  workflowKey: WorkflowKey,
  executionState: ExecutionState,
  stepCount = 1
): void {
  fsSync.mkdirSync(WorkflowPaths.draftDir(workspaceRoot, workflowKey), {
    recursive: true,
  });
  fsSync.writeFileSync(
    WorkflowPaths.draftFilePath(workspaceRoot, workflowKey),
    JSON.stringify({
      definitionRevision: 1,
      startedAt: 1_000,
      steps: Array.from({ length: stepCount }, () => ({ prompt: "hello" })),
      _runtime: { currentIndex: 0, executionState },
    })
  );
}

function summaryFor(
  workspaceRoot: string,
  workflowKey: WorkflowKey,
  executionState: ExecutionState,
  totalSteps = 1
): WorkflowSummary {
  return {
    id: `inst-${workflowKey}`,
    workflowKey,
    workflowName: "Recent",
    filePath: WorkflowPaths.draftFilePath(workspaceRoot, workflowKey),
    workingFilePath: WorkflowPaths.draftFilePath(workspaceRoot, workflowKey),
    executionState,
    currentStep: 0,
    totalSteps,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function withRunStorage(
  run: (
    workspaceRoot: string,
    repository: WorkflowLineageRepository
  ) => Promise<void>
): Promise<void> {
  const workspaceRoot = makeTempDir("ctrlyoke-recent-catalog-");
  try {
    await run(workspaceRoot, new WorkflowLineageRepository());
  } finally {
    await fs.rm(path.dirname(WorkflowPaths.runsRoot(workspaceRoot)), {
      recursive: true,
      force: true,
    });
    removeTempDir(workspaceRoot);
  }
}

suite("RecentWorkflowCatalog", () => {
  test("a built row takes executing state and step count from the live summary", async () => {
    await withRunStorage(async (workspaceRoot, repository) => {
      const { workflowKey } = await repository.createLineage(
        workspaceRoot,
        "wf-live",
        "Live"
      );
      writeDraft(workspaceRoot, workflowKey, EXECUTION_STATES.RUNNING);
      const catalog = new RecentWorkflowCatalog(
        repository,
        new TestCatalogHost()
      );

      const entry = await catalog.buildEntry(
        workspaceRoot,
        workflowKey,
        summaryFor(workspaceRoot, workflowKey, EXECUTION_STATES.COMPLETED, 4)
      );

      assert.strictEqual(entry?.executionState, EXECUTION_STATES.COMPLETED);
      assert.strictEqual(entry?.totalSteps, 4);
      assert.strictEqual(entry?.workflowName, "Live");
    });
  });

  test("a run that finishes while the list is scanning is re-read, not listed as running", async () => {
    await withRunStorage(async (workspaceRoot, repository) => {
      const { workflowKey } = await repository.createLineage(
        workspaceRoot,
        "wf-finishing",
        "Finishing"
      );
      writeDraft(workspaceRoot, workflowKey, EXECUTION_STATES.RUNNING);
      const host = new TestCatalogHost();
      host.summaries = [
        summaryFor(workspaceRoot, workflowKey, EXECUTION_STATES.RUNNING),
      ];
      // The first read seeds the scan; by the second (taken after every row
      // was read) the instance has retired and flushed its final state.
      host.onSummariesRead = (call) => {
        if (call === 2) {
          host.summaries = [];
          writeDraft(workspaceRoot, workflowKey, EXECUTION_STATES.COMPLETED);
        }
      };

      const { workflows } = await new RecentWorkflowCatalog(
        repository,
        host
      ).list(workspaceRoot);

      assert.strictEqual(workflows.length, 1);
      assert.strictEqual(
        workflows[0].executionState,
        EXECUTION_STATES.COMPLETED
      );
    });
  });

  test("concurrent list requests share one scan unless a fresh one is asked for", async () => {
    await withRunStorage(async (workspaceRoot, repository) => {
      const { workflowKey } = await repository.createLineage(
        workspaceRoot,
        "wf-shared",
        "Shared"
      );
      writeDraft(workspaceRoot, workflowKey, EXECUTION_STATES.IDLE);
      const catalog = new RecentWorkflowCatalog(
        repository,
        new TestCatalogHost()
      );

      const first = catalog.list(workspaceRoot);
      const joined = catalog.list(workspaceRoot);
      const fresh = catalog.list(workspaceRoot, { fresh: true });

      assert.strictEqual(joined, first);
      assert.notStrictEqual(fresh, first);
      const [firstList, freshList] = await Promise.all([first, fresh]);
      assert.ok(freshList.seq > firstList.seq);
      const later = catalog.list(workspaceRoot);
      assert.notStrictEqual(later, first);
      await later;
    });
  });
});

suite("RecentWorkflowPublisher", () => {
  test("pushes a lineage's row when its summary changes, and only then", async () => {
    await withRunStorage(async (workspaceRoot, repository) => {
      const { workflowKey } = await repository.createLineage(
        workspaceRoot,
        "wf-pushed",
        "Pushed"
      );
      writeDraft(workspaceRoot, workflowKey, EXECUTION_STATES.IDLE);
      const messages: RecentWorkflowUpdatedMessage[] = [];
      const publisher = new RecentWorkflowPublisher(
        new RecentWorkflowCatalog(repository, new TestCatalogHost()),
        () => workspaceRoot,
        (message) => messages.push(message),
        0
      );
      try {
        publisher.observe(
          summaryFor(workspaceRoot, workflowKey, EXECUTION_STATES.RUNNING)
        );
        await waitFor(() => messages.length === 1);
        assert.strictEqual(
          messages[0].type,
          MESSAGE_TYPES.RECENT_WORKFLOW_UPDATED
        );
        assert.strictEqual(
          messages[0].workflow.address.workflowKey,
          workflowKey
        );
        assert.strictEqual(
          messages[0].workflow.executionState,
          EXECUTION_STATES.RUNNING
        );

        // Live-progress churn that changes nothing the row shows is skipped.
        publisher.observe(
          summaryFor(workspaceRoot, workflowKey, EXECUTION_STATES.RUNNING)
        );
        publisher.observe(
          summaryFor(workspaceRoot, workflowKey, EXECUTION_STATES.COMPLETED)
        );
        await waitFor(() => messages.length === 2);
        assert.strictEqual(
          messages[1].workflow.executionState,
          EXECUTION_STATES.COMPLETED
        );
        assert.ok(messages[1].seq > messages[0].seq);
      } finally {
        publisher.dispose();
      }
    });
  });

  test("a lineage with no working file yet is retried on its next summary", async () => {
    await withRunStorage(async (workspaceRoot, repository) => {
      const { workflowKey } = await repository.createLineage(
        workspaceRoot,
        "wf-new",
        "New"
      );
      const messages: RecentWorkflowUpdatedMessage[] = [];
      const publisher = new RecentWorkflowPublisher(
        new RecentWorkflowCatalog(repository, new TestCatalogHost()),
        () => workspaceRoot,
        (message) => messages.push(message),
        0
      );
      try {
        const summary = summaryFor(
          workspaceRoot,
          workflowKey,
          EXECUTION_STATES.IDLE
        );
        publisher.observe(summary);
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.strictEqual(messages.length, 0);

        writeDraft(workspaceRoot, workflowKey, EXECUTION_STATES.IDLE);
        publisher.observe(summary);
        await waitFor(() => messages.length === 1);
        assert.strictEqual(
          messages[0].workflow.address.workflowKey,
          workflowKey
        );
      } finally {
        publisher.dispose();
      }
    });
  });
});
