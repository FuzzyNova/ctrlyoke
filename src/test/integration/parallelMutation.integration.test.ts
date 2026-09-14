import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import {
  WorkflowExecutor,
  type WorkflowExecutionContext,
} from "../../core/WorkflowExecutor";
import { PromptQueue } from "../../core/PromptQueue";
import { EndConditionEvaluator } from "../../core/EndConditionEvaluator";
import { EndConditionHandler } from "../../core/EndConditionHandler";
import { StatusMessageReporter } from "../../core/orchestration/StatusMessageReporter";
import {
  FINAL_STEP_PHASES,
  PROMPT_TERMINAL_STATUS,
} from "../../types/DashboardConstants";
import type {
  ParallelGroupDefinition,
  PromptStep,
  StepExecutionOutcome,
  WorkingFile,
} from "../../types/CtrlYokeTypes";
import { createNoWorktreeExecutionWorkspace } from "../../platform/PlatformAdapter";
import {
  WorkspaceSnapshotService,
  type RawWorkspaceState,
} from "../../utils/WorkspaceSnapshotService";
import type { WorkspaceSnapshot } from "../../types/OutputHistoryTypes";
import { MockHarnessIntegration, MockPlatform } from "../helpers/mockHarness";

class PromotionSnapshotService extends WorkspaceSnapshotService {
  public captureCount = 0;
  public beforeCaptureIds: number[] = [];

  override async selectStrategy(): Promise<"filesystem"> {
    return "filesystem";
  }

  override async captureWorkspaceState(
    _executionRoot: string,
    strategy: "git" | "filesystem"
  ): Promise<RawWorkspaceState> {
    this.captureCount += 1;
    return {
      capturedAt: this.captureCount,
      strategy,
      segments: [],
    };
  }

  override snapshotRepoInfos(): undefined {
    return undefined;
  }

  override async computeSnapshotChanges(
    beforeState: RawWorkspaceState
  ): Promise<WorkspaceSnapshot["changedFiles"]> {
    this.beforeCaptureIds.push(beforeState.capturedAt);
    return [
      {
        path: `before-${beforeState.capturedAt}`,
        changeType: "created",
      },
    ];
  }

  override async enrichSnapshotBeforeContent(
    snapshot: WorkspaceSnapshot
  ): Promise<WorkspaceSnapshot> {
    return snapshot;
  }
}

function createContext(
  workspace: string,
  integrations: ReadonlyMap<number, MockHarnessIntegration>,
  snapshotService?: WorkspaceSnapshotService,
  boundaries?: Map<number, number | undefined>,
  fallback?: MockHarnessIntegration
): WorkflowExecutionContext {
  const defaultIntegration =
    fallback ??
    integrations.values().next().value ??
    new MockHarnessIntegration(undefined, false);
  const platform = new MockPlatform(workspace);
  const statusReporter = new StatusMessageReporter(
    () => undefined,
    () => undefined
  );
  const context: WorkflowExecutionContext = {
    executionWorkspace: createNoWorktreeExecutionWorkspace(platform),
    workspaceFolderPath: workspace,
    currentPromptFilePath: "workflow.ctrlyoke.json",
    shouldShowCliCommand: false,
    dynamicQueueConfig: {
      maxQueueSize: 100,
      maxParallelSteps: 6,
      maxWorkflowExecutionTime: 3600,
      unlimitedMode: false,
      notifyOnExtension: false,
    },
    parallelGroupFanOutEnabled: true,
    getIntegrationForPrompt: (_step, _harness, target) => {
      if (target?.kind === FINAL_STEP_PHASES.QUEUE) {
        boundaries?.set(target.stepIndex, undefined);
        const integration = integrations.get(target.stepIndex);
        if (integration) return integration;
      }
      return defaultIntegration;
    },
    historyFilePath: "",
    statusReporter,
    snapshotService,
    releaseTargetResources: async () => undefined,
  };

  // The executor's preflight and execution both receive the group boundary in
  // the harness context. The mock integrations record it at send time below.
  return context;
}

function createExecutor(
  queue: PromptQueue,
  workspace: string
): WorkflowExecutor {
  const platform = new MockPlatform(workspace);
  const evaluator = new EndConditionEvaluator(platform);
  return new WorkflowExecutor(
    queue,
    new EndConditionHandler(
      evaluator,
      queue,
      new StatusMessageReporter(
        () => undefined,
        () => undefined
      )
    ),
    evaluator,
    platform
  );
}

async function readWorkingFile(filePath: string): Promise<WorkingFile> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as WorkingFile;
}

suite("Parallel mutation integration", () => {
  test("persists an appended member and the group's extended bounds", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-parallel-append-")
    );
    try {
      const queue = new PromptQueue();
      const steps: PromptStep[] = [
        { prompt: "member one" },
        { prompt: "member two" },
      ];
      const groups: ParallelGroupDefinition[] = [
        { id: "append-group", startIndex: 0, endIndex: 1, failFast: false },
      ];
      const workingFilePath = await queue.createWorkingFile(
        "parallel-append",
        steps,
        workspace,
        undefined,
        undefined,
        groups
      );
      queue.loadPrompts({ steps, parallelGroups: groups }, workingFilePath);

      await queue.appendParallelGroupMember("append-group", {
        prompt: "member three",
      });

      const persisted = await readWorkingFile(workingFilePath);
      assert.deepStrictEqual(persisted.parallelGroups, [
        { id: "append-group", startIndex: 0, endIndex: 2, failFast: false },
      ]);
      const inserted = persisted.steps?.[2];
      assert.ok(inserted && "prompt" in inserted);
      assert.strictEqual(inserted.prompt, "member three");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("persists append and promotion topology, with the promoted group snapshot", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-parallel-mutation-")
    );
    try {
      const queue = new PromptQueue();
      const steps: PromptStep[] = [{ prompt: "anchor" }];
      const draftPath = await queue.createWorkingFile(
        "parallel-mutation",
        steps,
        workspace
      );
      queue.loadPrompts({ steps }, draftPath);
      await queue.promoteToNewRun(workspace, 100);

      const anchor = new MockHarnessIntegration(undefined, false);
      const sibling = new MockHarnessIntegration(undefined, false);
      const snapshotService = new PromotionSnapshotService();
      const captured: Array<{
        target: number;
        snapshot: WorkspaceSnapshot;
      }> = [];
      const boundaries = new Map<number, number | undefined>();
      const context = createContext(
        workspace,
        new Map([
          [0, anchor],
          [1, sibling],
        ]),
        snapshotService,
        boundaries
      );
      context.onSnapshotCaptured = (target, snapshot) => {
        if (target.kind === FINAL_STEP_PHASES.QUEUE) {
          captured.push({ target: target.stepIndex, snapshot });
        }
      };
      anchor.prepareSentPrompt = async () => {
        await queue.promoteStepToParallelGroup(0, { prompt: "sibling" });
        return "anchor";
      };
      anchor.onSend = async () => ({ responseText: "anchor settled" });
      sibling.onSend = async (_step, workflowContext) => {
        boundaries.set(1, workflowContext?.groupStartBoundary);
        return { responseText: "sibling settled" };
      };

      await createExecutor(queue, workspace).execute(anchor, context);

      const runPath = queue.getState().workingFilePath;
      assert.ok(runPath);
      const persisted = await readWorkingFile(runPath);
      assert.deepStrictEqual(persisted.parallelGroups, [
        {
          id: persisted.parallelGroups?.[0]?.id,
          startIndex: 0,
          endIndex: 1,
          failFast: false,
        },
      ]);
      const promotedSibling = persisted.steps?.[1];
      assert.ok(promotedSibling && "prompt" in promotedSibling);
      assert.strictEqual(promotedSibling.prompt, "sibling");
      assert.strictEqual(boundaries.get(1), 0);
      assert.deepStrictEqual(snapshotService.beforeCaptureIds, [1, 1]);
      assert.strictEqual(captured.length, 2);
      assert.ok(
        captured.every(
          ({ target, snapshot }) =>
            target === 0 &&
            snapshot.parallelGroupId === persisted.parallelGroups?.[0]?.id
        )
      );
      assert.ok(
        captured.every(({ snapshot }) =>
          snapshot.changedFiles.some((change) => change.path === "before-1")
        )
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("reloads a promoted group and reschedules only unsettled members", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-parallel-recovery-")
    );
    try {
      const queue = new PromptQueue();
      const steps: PromptStep[] = [{ prompt: "anchor" }];
      const draftPath = await queue.createWorkingFile(
        "parallel-recovery",
        steps,
        workspace
      );
      queue.loadPrompts({ steps }, draftPath);
      await queue.promoteToNewRun(workspace, 100);
      const anchorId = queue.getState().steps[0]._runtime?.stepId;
      assert.ok(anchorId);
      await queue.claimStepById(anchorId, 123, workspace);
      await queue.promoteStepToParallelGroup(0, {
        prompt: "unsettled sibling",
      });

      const settledAnchor: StepExecutionOutcome = {
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        status: PROMPT_TERMINAL_STATUS.COMPLETED,
      };
      await queue.persistStepOutcome(settledAnchor);
      const workingFilePath = queue.getState().workingFilePath;
      assert.ok(workingFilePath);
      const beforeReload = await readWorkingFile(workingFilePath);
      assert.strictEqual(beforeReload.parallelGroups?.[0]?.startIndex, 0);

      const recoveredQueue = new PromptQueue();
      await recoveredQueue.restoreFromWorkingFile(workingFilePath, true);
      assert.deepStrictEqual(
        recoveredQueue.getState().parallelGroups,
        beforeReload.parallelGroups
      );
      assert.strictEqual(
        recoveredQueue.getState().steps[0]._runtime?.completedAt !== undefined,
        true
      );
      assert.strictEqual(
        recoveredQueue.getState().steps[1]._runtime?.completedAt,
        undefined
      );

      const sibling = new MockHarnessIntegration(undefined, false);
      const context = createContext(
        workspace,
        new Map([[1, sibling]]),
        undefined,
        undefined,
        sibling
      );
      await createExecutor(recoveredQueue, workspace).execute(sibling, context);
      assert.deepStrictEqual(sibling.sentPrompts, ["unsettled sibling"]);
      assert.strictEqual(recoveredQueue.getState().currentIndex, 2);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
