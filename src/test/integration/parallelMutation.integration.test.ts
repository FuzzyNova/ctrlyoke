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
  EXECUTION_MODES,
  QUEUE_POSITION,
  PROMPT_TERMINAL_STATUS,
  STEP_CLAIM_OUTCOMES,
  STEP_TYPES,
  MCP_SKILL_NAMES,
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
import { ensureMcpStorageInitialized } from "../helpers/mcpStorage";
import { CtrlYokeMCPServer } from "../../mcp-server";
import {
  MCP_APPEND_STEP_TOOL_NAME,
  MCP_EDIT_STEP_TOOL_NAME,
  MCP_REMOVE_STEP_TOOL_NAME,
} from "../../utils/McpToolDefinitions";
import { McpToolSkillGenerator } from "../../utils/McpToolSkillGenerator";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { withFileLock } from "../../utils/FileLockUtils";

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
      maxSteps: 100,
      maxParallelSteps: 6,
      maxWorkflowExecutionTime: 3600,
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

function responseJson(result: unknown): Record<string, any> {
  const typed = result as { content: Array<{ text: string }> };
  return JSON.parse(typed.content[0].text) as Record<string, any>;
}

async function restoreEnvironment(
  values: Readonly<Record<string, string | undefined>>
): Promise<void> {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
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

  test("lets a group orchestrator mutate flat future work and join without stale indices", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-parallel-orchestrator-")
    );
    const environment = {
      CTRLYOKE_WORKING_FILE: process.env.CTRLYOKE_WORKING_FILE,
      CTRLYOKE_EXECUTION_ROOT: process.env.CTRLYOKE_EXECUTION_ROOT,
      CTRLYOKE_MAX_PARALLEL_STEPS: process.env.CTRLYOKE_MAX_PARALLEL_STEPS,
      CTRLYOKE_PROMPT_INDEX: process.env.CTRLYOKE_PROMPT_INDEX,
      CTRLYOKE_PARALLEL_GROUP_ID: process.env.CTRLYOKE_PARALLEL_GROUP_ID,
    };
    let releaseImplementation!: () => void;
    const implementationMayFinish = new Promise<void>((resolve) => {
      releaseImplementation = resolve;
    });
    try {
      await ensureMcpStorageInitialized(workspace);
      const queue = new PromptQueue();
      const steps: PromptStep[] = [
        { prompt: "implementation" },
        { prompt: "orchestrator" },
      ];
      const groups: ParallelGroupDefinition[] = [
        {
          id: "implementation-orchestrator",
          startIndex: 0,
          endIndex: 1,
          failFast: false,
        },
      ];
      const draftPath = await queue.createWorkingFile(
        "parallel-orchestrator",
        steps,
        workspace,
        undefined,
        undefined,
        groups
      );
      queue.loadPrompts({ steps, parallelGroups: groups }, draftPath);
      const promoted = await queue.promoteToNewRun(workspace, Date.now());
      assert.ok(promoted);
      const workingFilePath = promoted.workingFilePath;
      const workflowKey = queue.getState().workflowKey;
      const runRef = queue.getState().runRef;
      assert.ok(workflowKey && runRef);
      assert.strictEqual(
        WorkflowPaths.runFilePath(workspace, workflowKey, runRef),
        workingFilePath
      );
      process.env.CTRLYOKE_WORKING_FILE = workingFilePath;
      process.env.CTRLYOKE_EXECUTION_ROOT = workspace;
      process.env.CTRLYOKE_MAX_PARALLEL_STEPS = "6";
      process.env.CTRLYOKE_PROMPT_INDEX = "1";
      process.env.CTRLYOKE_PARALLEL_GROUP_ID = groups[0].id;
      const server = new CtrlYokeMCPServer({ workspaceRoot: workspace });
      const skillContext = {
        mcpServerPath: "mcp-server.js",
        workspaceRoot: workspace,
        executionRoot: workspace,
        workingFilePath,
        stepIndex: 1,
        parallelGroupId: groups[0].id,
      } as const;
      const invoke = async (
        mode: "native" | "skill",
        name: string,
        args: Record<string, unknown>
      ) => {
        // The run file has three concurrent writers here: this nudge, the
        // executor's WorkingFileManager, and RunContinuationService's atomic
        // write-temp-then-rename. Take the same lock they do — an unlocked
        // read-modify-write leaves the destination open and the rename fails
        // with EPERM on Windows.
        await withFileLock(workingFilePath, async () => {
          const addressedWorkingFile = await readWorkingFile(workingFilePath);
          if (addressedWorkingFile._runtime) {
            addressedWorkingFile._runtime.currentIndex = 1;
            await fs.writeFile(
              workingFilePath,
              JSON.stringify(addressedWorkingFile),
              "utf8"
            );
          }
        });
        if (mode === "native") {
          assert.ok(
            server
              .getToolDefinitions({ attested: true, groupMember: true })
              .some((tool) => tool.name === name),
            `${name} is missing from native MCP`
          );
        } else {
          const skill = McpToolSkillGenerator.generateBuiltInSkillContent(
            MCP_SKILL_NAMES.TOOLS,
            "# ctrlyoke MCP tools",
            skillContext
          );
          assert.ok(
            skill?.includes(`### ${name}`),
            `${name} is missing from MCP-as-skill`
          );
        }
        return responseJson(await server.invokeTool(name, args));
      };

      const implementation = new MockHarnessIntegration(undefined, false);
      const orchestrator = new MockHarnessIntegration(undefined, false);
      const joined = new MockHarnessIntegration(undefined, false);
      const future = new MockHarnessIntegration(undefined, false);
      let mutationError: unknown;
      let signalImplementationStarted!: () => void;
      const implementationReady = new Promise<void>((resolve) => {
        signalImplementationStarted = resolve;
      });
      implementation.onSend = async () => {
        signalImplementationStarted();
        await implementationMayFinish;
        return { responseText: "implementation complete" };
      };
      orchestrator.onSend = async () => {
        await implementationReady;
        try {
          const appended = await invoke("native", MCP_APPEND_STEP_TOOL_NAME, {
            position: QUEUE_POSITION.NEXT,
            steps: [
              { prompt: "future-to-remove" },
              { prompt: "future-to-edit" },
            ],
          });
          assert.strictEqual(appended.insertIndex, 2);
          await queue.mergeStepsFromDisk();

          const joinedResult = await invoke(
            "skill",
            MCP_APPEND_STEP_TOOL_NAME,
            {
              position: QUEUE_POSITION.PARALLEL_WITH_CURRENT,
              steps: [{ prompt: "late sibling" }],
            }
          );
          assert.strictEqual(joinedResult.destination, "activeParallelGroup");
          assert.strictEqual(joinedResult.insertIndex, 2);
          await queue.mergeStepsFromDisk();

          // The live join shifted both future IDs right by one. Address the edit
          // and remove using the returned placement, not the stale pre-join 2/3.
          const futureEditIndex = joinedResult.insertIndex + 2;
          const edited = await invoke("native", MCP_EDIT_STEP_TOOL_NAME, {
            index: futureEditIndex,
            updates: { prompt: "future-edited" },
          });
          assert.strictEqual(edited.index, futureEditIndex);
          await queue.mergeStepsFromDisk();
          const removed = await invoke("skill", MCP_REMOVE_STEP_TOOL_NAME, {
            index: joinedResult.insertIndex + 1,
          });
          assert.strictEqual(removed.index, joinedResult.insertIndex + 1);
          await queue.mergeStepsFromDisk();
          return { responseText: "orchestrator complete" };
        } catch (error) {
          mutationError = error;
          throw error;
        } finally {
          releaseImplementation();
        }
      };

      const context = createContext(
        workspace,
        new Map([
          [0, implementation],
          [1, orchestrator],
          [2, joined],
          [3, future],
        ])
      );
      await createExecutor(queue, workspace).execute(implementation, context);
      assert.ifError(mutationError);

      const persisted = await readWorkingFile(workingFilePath);
      assert.deepStrictEqual(
        persisted.steps?.map((step) => (step as PromptStep).prompt),
        ["implementation", "orchestrator", "late sibling", "future-edited"]
      );
      assert.deepStrictEqual(persisted.parallelGroups, [
        {
          id: groups[0].id,
          startIndex: 0,
          endIndex: 2,
          failFast: false,
        },
      ]);
      assert.deepStrictEqual(implementation.sentPrompts, ["implementation"]);
      assert.deepStrictEqual(orchestrator.sentPrompts, ["orchestrator"]);
      assert.deepStrictEqual(joined.sentPrompts, ["late sibling"]);
      assert.deepStrictEqual(future.sentPrompts, ["future-edited"]);
    } finally {
      releaseImplementation?.();
      await restoreEnvironment(environment);
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
      assert.strictEqual(queue.getState().currentIndex, 2);
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

  test("keeps output, snapshot, PTY, and coordination attribution on started members after pending mutations", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-parallel-attribution-")
    );
    let releaseScript!: () => void;
    try {
      const queue = new PromptQueue();
      const prompt = new MockHarnessIntegration(undefined, false);
      const script = new MockHarnessIntegration(undefined, false);
      const scriptMayFinish = new Promise<void>((resolve) => {
        releaseScript = resolve;
      });
      const steps = [
        { prompt: "prompt member" },
        {
          type: STEP_TYPES.SCRIPT,
          script: "echo script member",
          executionMode: EXECUTION_MODES.INTERACTIVE,
        },
        { prompt: "pending member" },
      ] as const;
      const groups: ParallelGroupDefinition[] = [
        {
          id: "attribution-group",
          startIndex: 0,
          endIndex: 1,
          failFast: false,
        },
      ];
      queue.loadPrompts({ steps: [...steps], parallelGroups: groups });

      const snapshotService = new PromotionSnapshotService();
      const context = createContext(
        workspace,
        new Map([
          [0, prompt],
          [1, script],
        ]),
        snapshotService,
        undefined,
        new MockHarnessIntegration(undefined, false)
      );
      context.hostCanProvidePty = true;
      const outputTargets: number[] = [];
      const snapshotTargets: number[] = [];
      const ptyTargets: number[] = [];
      const coordinationTargets: number[] = [];
      const activityTargets: number[] = [];
      context.captureOutputInit = (stepIndex) => outputTargets.push(stepIndex);
      context.captureCompletedOutput = (stepIndex) =>
        outputTargets.push(stepIndex);
      context.onSnapshotCaptured = (target, snapshot) => {
        if (
          target.kind === FINAL_STEP_PHASES.QUEUE &&
          snapshot.parallelGroupId === groups[0].id
        ) {
          snapshotTargets.push(target.stepIndex);
        }
      };
      context.registerTargetPtySession = (target, sessionId) => {
        assert.strictEqual(sessionId, "pty-1");
        if (target.kind === FINAL_STEP_PHASES.QUEUE)
          ptyTargets.push(target.stepIndex);
      };
      context.beginSessionActivityTargetCapture = (_integration, target) => {
        if (target.kind === FINAL_STEP_PHASES.QUEUE)
          activityTargets.push(target.stepIndex);
      };
      context.closeCoordinationParticipant = async (target) => {
        if (target.kind === FINAL_STEP_PHASES.QUEUE)
          coordinationTargets.push(target.stepIndex);
      };
      context.spawnScriptPty = async (options) => {
        options.onSessionCreated?.("pty-1");
        options.onOutput("script output");
        await scriptMayFinish;
        options.onSessionEnded?.();
        return 0;
      };
      prompt.onSend = async () => {
        await queue.appendSteps([{ prompt: "appended pending member" }]);
        await queue.replaceStep(3, { prompt: "edited appended member" });
        releaseScript();
        return { responseText: "prompt output" };
      };

      await createExecutor(queue, workspace).execute(prompt, context);

      assert.ok(outputTargets.includes(0));
      assert.ok(snapshotTargets.includes(0));
      assert.deepStrictEqual(ptyTargets, [1]);
      assert.deepStrictEqual(
        activityTargets.filter((index) => index <= 1),
        [0]
      );
      assert.deepStrictEqual(
        coordinationTargets.filter((index) => index <= 1).sort(),
        [0, 1]
      );
      assert.deepStrictEqual(
        queue
          .getState()
          .steps.map((step) => ("prompt" in step ? step.prompt : step.script)),
        [
          "prompt member",
          "echo script member",
          "pending member",
          "edited appended member",
        ]
      );
    } finally {
      releaseScript?.();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("recovers only surviving unclaimed members and never claims settled IDs twice", async () => {
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
      const settledClaim = await recoveredQueue.claimStepById(anchorId);
      assert.strictEqual(settledClaim.status, STEP_CLAIM_OUTCOMES.TERMINAL);
      const recoveredSiblingId =
        recoveredQueue.getState().steps[1]._runtime?.stepId;
      assert.ok(recoveredSiblingId);
      const rerunClaim = await recoveredQueue.claimStepById(recoveredSiblingId);
      assert.strictEqual(rerunClaim.status, STEP_CLAIM_OUTCOMES.TERMINAL);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
