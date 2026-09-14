import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import {
  WorkflowExecutor,
  WorkflowExecutionContext,
} from "../../core/WorkflowExecutor";
import { PromptQueue } from "../../core/PromptQueue";
import {
  EndConditionEvaluator,
  type EvaluationResult,
} from "../../core/EndConditionEvaluator";
import { EndConditionHandler } from "../../core/EndConditionHandler";
import { StatusMessageReporter } from "../../core/orchestration/StatusMessageReporter";
import {
  PromptFile,
  PromptStep,
  type ScriptProperties,
} from "../../types/CtrlYokeTypes";
import {
  CLI_EVENT_TYPES,
  HARNESS_IDS,
  CONTEXT_RESOLUTION_FAILURE_MODES,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  PROMPT_DIAGNOSTIC_CODES,
  isContextResolutionDiagnostic,
  STEP_STATUS,
  CONDITION_ACTIONS,
  TOKEN_TOTAL_CONFIDENCE,
} from "../../types/DashboardConstants";
import { configService } from "../../config/CtrlYokeConfigService";
import type { CompatibilityDiagnostic } from "../../types/CompatibilityTypes";
import { CliEvent } from "../../types/WebviewMessageTypes";
import type { CliOutput } from "../../types/WebviewMessageTypes";
import type { UniversalCliOutput } from "../../types/CliOutputTypes";
import { createNoWorktreeExecutionWorkspace } from "../../platform/PlatformAdapter";
import { Log } from "../../utils/Log";
import { calculateAttemptCost } from "../../utils/ModelPricing";
import {
  WorkspaceSnapshotService,
  type RawWorkspaceState,
} from "../../utils/WorkspaceSnapshotService";
import type { WorkspaceSnapshot } from "../../types/OutputHistoryTypes";
import { MockHarnessIntegration, MockPlatform } from "../helpers/mockHarness";

function makeContext(
  integration: MockHarnessIntegration
): WorkflowExecutionContext {
  let context: WorkflowExecutionContext;
  context = {
    executionWorkspace: createNoWorktreeExecutionWorkspace(new MockPlatform()),
    workspaceFolderPath: process.cwd(),
    currentPromptFilePath: "workflow.ctrlyoke.yaml",
    shouldShowCliCommand: false,
    dynamicQueueConfig: {
      maxQueueSize: 100,
      maxParallelSteps: 6,
      maxWorkflowExecutionTime: 3600,
      unlimitedMode: false,
      notifyOnExtension: false,
    },
    getIntegrationForPrompt: () => integration,
    historyFilePath: "",
    statusReporter: new StatusMessageReporter(
      () => context.dashboardProvider,
      () =>
        context.historyFilePath && context.outputHistoryManager
          ? {
              filePath: context.historyFilePath,
              manager: context.outputHistoryManager,
            }
          : undefined,
      (target, message, severity) => {
        if (target.kind === FINAL_STEP_PHASES.QUEUE) {
          if (target.stepIndex === undefined) {
            throw new Error("Queue status message target requires stepIndex");
          }
          context.onStatusMessage?.(target.stepIndex, message, severity);
        } else {
          if (target.loopIndex === undefined) {
            throw new Error(
              "Final-step status message target requires loopIndex"
            );
          }
          context.onFinalStepStatusMessage?.(
            target.loopIndex,
            message,
            severity
          );
        }
      }
    ),
  };
  return context;
}

function makeParallelContext(
  integrations: ReadonlyMap<number, MockHarnessIntegration>
): WorkflowExecutionContext {
  const fallback = integrations.values().next().value;
  if (!fallback) {
    throw new Error("Parallel test requires at least one integration");
  }
  const context = makeContext(fallback);
  context.parallelGroupFanOutEnabled = true;
  context.getIntegrationForPrompt = (_prompt, _harness, target) => {
    if (target?.kind !== FINAL_STEP_PHASES.QUEUE) {
      return fallback;
    }
    const integration = integrations.get(target.stepIndex);
    if (!integration) {
      throw new Error(`Missing integration for step ${target.stepIndex}`);
    }
    return integration;
  };
  context.cancelTarget = async (target) => {
    if (target.kind === FINAL_STEP_PHASES.QUEUE) {
      await integrations.get(target.stepIndex)?.cancel();
    }
  };
  context.releaseTargetResources = async () => undefined;
  return context;
}

function makeExecutor(
  queue: PromptQueue,
  evaluator?: EndConditionEvaluator
): WorkflowExecutor {
  const platform = new MockPlatform();
  const conditionEvaluator = evaluator ?? new EndConditionEvaluator(platform);
  const handler = new EndConditionHandler(
    conditionEvaluator,
    queue,
    new StatusMessageReporter(
      () => undefined,
      () => undefined
    )
  );
  return new WorkflowExecutor(queue, handler, conditionEvaluator, platform);
}

class InspectableWorkflowExecutor extends WorkflowExecutor {
  resolveTokens(parsedOutput: UniversalCliOutput): CliOutput["tokens"] {
    return this.resolveTokenCounts(parsedOutput);
  }
}

function makeInspectableExecutor(): InspectableWorkflowExecutor {
  const platform = new MockPlatform();
  const conditionEvaluator = new EndConditionEvaluator(platform);
  const handler = new EndConditionHandler(
    conditionEvaluator,
    new PromptQueue(),
    new StatusMessageReporter(
      () => undefined,
      () => undefined
    )
  );
  return new InspectableWorkflowExecutor(
    new PromptQueue(),
    handler,
    conditionEvaluator,
    platform
  );
}

class FixedEvaluationEvaluator extends EndConditionEvaluator {
  constructor(
    platform: MockPlatform,
    private readonly fixedResult: EvaluationResult
  ) {
    super(platform);
  }

  override async evaluateCondition(
    _condition: ScriptProperties
  ): Promise<EvaluationResult> {
    return this.fixedResult;
  }
}

class RecordingSnapshotService extends WorkspaceSnapshotService {
  captureCount = 0;

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

  override async computeSnapshotChanges(): Promise<
    WorkspaceSnapshot["changedFiles"]
  > {
    return [
      {
        path: `member-${this.captureCount}`,
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

async function requestQueuePause(queue: PromptQueue): Promise<void> {
  if (queue.getRuntimeStateMachine().pause()) {
    await queue.commitRuntimeTransition({ persist: false });
  }
}

async function requestQueueStop(queue: PromptQueue): Promise<void> {
  if (!queue.getRuntimeStateMachine().requestStop()) {
    return;
  }

  queue.markInFlightPromptCancelled();
  await queue.commitRuntimeTransition({ persist: false });
}

async function confirmQueueStopped(queue: PromptQueue): Promise<void> {
  if (!queue.getRuntimeStateMachine().confirmStopped()) {
    return;
  }

  queue.finalizeCancelledPromptAfterStop();
  await queue.commitRuntimeTransition({ persist: false });
}

async function resumeQueueExecution(queue: PromptQueue): Promise<void> {
  if (queue.getRuntimeStateMachine().resume()) {
    await queue.commitRuntimeTransition({ persist: false });
  }
}

function parsedTokenOutput(
  harness: (typeof HARNESS_IDS)[keyof typeof HARNESS_IDS],
  usage: NonNullable<UniversalCliOutput["metadata"]["usage"]>,
  model?: string
): UniversalCliOutput {
  return {
    events: [],
    metadata: { harness, model, usage },
  };
}

suite("WorkflowExecutor token totals", () => {
  test("nets cache-subset totals for Codex and Qwen", () => {
    const executor = makeInspectableExecutor();

    for (const harness of [HARNESS_IDS.CODEX_CLI, HARNESS_IDS.QWEN_CLI]) {
      const tokens = executor.resolveTokens(
        parsedTokenOutput(harness, {
          inputTokens: 1_000,
          outputTokens: 100,
          totalTokens: 1_100,
          cachedInputTokens: 900,
          totalConfidence: TOKEN_TOTAL_CONFIDENCE.PROVIDER,
        })
      );

      assert.strictEqual(tokens?.prompt, 1_000);
      assert.strictEqual(tokens?.cached, 900);
      assert.strictEqual(tokens?.completion, 100);
      assert.strictEqual(tokens?.total, 200);
      assert.strictEqual(
        tokens?.totalConfidence,
        TOKEN_TOTAL_CONFIDENCE.ACCUMULATED
      );
    }
  });

  test("leaves disjoint harness totals unchanged", () => {
    const executor = makeInspectableExecutor();

    for (const harness of [
      HARNESS_IDS.CLAUDE_CLI,
      HARNESS_IDS.ANTIGRAVITY_CLI,
      HARNESS_IDS.OPENCODE_CLI,
    ]) {
      const tokens = executor.resolveTokens(
        parsedTokenOutput(harness, {
          inputTokens: 100,
          outputTokens: 5,
          totalTokens: 105,
          cachedInputTokens: 200,
          cacheCreatedTokens: 17,
          reasoningOutputTokens: 3,
          totalConfidence: TOKEN_TOTAL_CONFIDENCE.PROVIDER,
        })
      );

      assert.strictEqual(tokens?.prompt, 100);
      assert.strictEqual(tokens?.completion, 5);
      assert.strictEqual(tokens?.cached, 200);
      assert.strictEqual(tokens?.cacheCreated, 17);
      assert.strictEqual(tokens?.reasoning, 3);
      assert.strictEqual(tokens?.total, 105);
      assert.strictEqual(
        tokens?.totalConfidence,
        TOKEN_TOTAL_CONFIDENCE.PROVIDER
      );
    }
  });

  test("keeps raw prompt and cache counts for cost calculation", () => {
    const executor = makeInspectableExecutor();
    const usage = {
      inputTokens: 1_000,
      outputTokens: 100,
      totalTokens: 1_100,
      cachedInputTokens: 900,
      cacheCreatedTokens: 40,
      totalConfidence: TOKEN_TOTAL_CONFIDENCE.PROVIDER,
    };
    const tokens = executor.resolveTokens(
      parsedTokenOutput(HARNESS_IDS.QWEN_CLI, usage, "qwen3.5-plus")
    );
    const expectedCost = calculateAttemptCost({
      harnessId: HARNESS_IDS.QWEN_CLI,
      modelId: "qwen3.5-plus",
      prompt: usage.inputTokens,
      completion: usage.outputTokens,
      cached: usage.cachedInputTokens,
      cacheCreated: usage.cacheCreatedTokens,
      totalConfidence: usage.totalConfidence,
    });

    assert.ok(expectedCost.cost);
    assert.deepStrictEqual(tokens?.cost, expectedCost.cost);
    assert.strictEqual(tokens?.prompt, usage.inputTokens);
    assert.strictEqual(tokens?.cached, usage.cachedInputTokens);
    assert.strictEqual(tokens?.cacheCreated, usage.cacheCreatedTokens);
    assert.strictEqual(tokens?.total, 200);
  });
});

suite("WorkflowExecutor finalStep phase 2", () => {
  test("claims each sequential step before sending it to the harness", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    integration.onSend = async (prompt) => {
      assert.ok(prompt._runtime?.startedAt);
      return { responseText: "sent after claim" };
    };
    queue.loadPrompts({ steps: [{ prompt: "sequential" }] });

    await makeExecutor(queue).execute(integration, makeContext(integration));

    assert.deepStrictEqual(integration.sentPrompts, ["sequential"]);
  });

  test("claims every parallel member before sending it to the harness", async () => {
    const queue = new PromptQueue();
    const integrations = new Map<number, MockHarnessIntegration>();
    for (let stepIndex = 0; stepIndex < 2; stepIndex += 1) {
      const integration = new MockHarnessIntegration(undefined, false);
      integration.onSend = async (prompt) => {
        assert.ok(prompt._runtime?.startedAt);
        return { responseText: `sent-${stepIndex}` };
      };
      integrations.set(stepIndex, integration);
    }
    queue.loadPrompts({
      steps: [{ prompt: "parallel-one" }, { prompt: "parallel-two" }],
      parallelGroups: [
        {
          id: "claim-before-launch",
          startIndex: 0,
          endIndex: 1,
          failFast: true,
        },
      ],
    });

    await makeExecutor(queue).execute(
      integrations.get(0)!,
      makeParallelContext(integrations)
    );

    assert.deepStrictEqual(integrations.get(0)?.sentPrompts, ["parallel-one"]);
    assert.deepStrictEqual(integrations.get(1)?.sentPrompts, ["parallel-two"]);
  });

  test("preflights a pending member from its edited definition after claiming", async () => {
    const queue = new PromptQueue();
    const first = new MockHarnessIntegration(undefined, false);
    const second = new MockHarnessIntegration(undefined, false);
    first.onSend = async () => {
      await queue.updatePrompt(1, { prompt: "edited-before-dispatch" });
      return { responseText: "first" };
    };
    const integrations = new Map<number, MockHarnessIntegration>([
      [0, first],
      [1, second],
    ]);
    queue.loadPrompts({
      steps: [{ prompt: "first" }, { prompt: "original" }],
      parallelGroups: [
        { id: "fresh-preflight", startIndex: 0, endIndex: 1, failFast: false },
      ],
    });

    const context = makeParallelContext(integrations);
    context.dynamicQueueConfig.maxParallelSteps = 1;
    await makeExecutor(queue).execute(first, context);

    assert.deepStrictEqual(second.sentPrompts, ["edited-before-dispatch"]);
  });

  test("joins on the group's current bounds after a pending member is removed", async () => {
    const queue = new PromptQueue();
    const first = new MockHarnessIntegration(undefined, false);
    const second = new MockHarnessIntegration(undefined, false);
    const after = new MockHarnessIntegration(undefined, false);
    // Shrink the group mid-run. A join that reused the fork-time endIndex
    // would advance currentIndex past "after" and silently skip it.
    first.onSend = async () => {
      await queue.deletePrompt(2);
      return { responseText: "first" };
    };
    const integrations = new Map<number, MockHarnessIntegration>([
      [0, first],
      [1, second],
      [2, after],
    ]);
    queue.loadPrompts({
      steps: [
        { prompt: "member-one" },
        { prompt: "member-two" },
        { prompt: "member-three" },
        { prompt: "after-group" },
      ],
      parallelGroups: [
        { id: "shrinking", startIndex: 0, endIndex: 2, failFast: false },
      ],
    });

    const context = makeParallelContext(integrations);
    context.dynamicQueueConfig.maxParallelSteps = 1;
    await makeExecutor(queue).execute(first, context);

    assert.deepStrictEqual(queue.getState().parallelGroups, [
      { id: "shrinking", startIndex: 0, endIndex: 1, failFast: false },
    ]);
    assert.deepStrictEqual(after.sentPrompts, ["after-group"]);
  });

  test("captures cumulative group snapshots at the group target", async () => {
    const queue = new PromptQueue();
    const integrations = new Map<number, MockHarnessIntegration>();
    for (let stepIndex = 0; stepIndex < 3; stepIndex += 1) {
      const integration = new MockHarnessIntegration(undefined, false);
      integration.onSend = async () => {
        await new Promise((resolve) =>
          setTimeout(resolve, (2 - stepIndex) * 5)
        );
        return { responseText: `ok-${stepIndex}` };
      };
      integrations.set(stepIndex, integration);
    }
    queue.loadPrompts({
      steps: [{ prompt: "one" }, { prompt: "two" }, { prompt: "three" }],
      parallelGroups: [
        { id: "snapshots", startIndex: 0, endIndex: 2, failFast: true },
      ],
    });
    const context = makeParallelContext(integrations);
    const snapshotService = new RecordingSnapshotService();
    const captured: Array<{
      target: number;
      snapshot: WorkspaceSnapshot;
    }> = [];
    context.snapshotService = snapshotService;
    context.onSnapshotCaptured = (target, snapshot) => {
      if (target.kind === FINAL_STEP_PHASES.QUEUE) {
        captured.push({ target: target.stepIndex, snapshot });
      }
    };

    await makeExecutor(queue).execute(integrations.get(0)!, context);

    assert.strictEqual(snapshotService.captureCount, 4);
    assert.strictEqual(captured.length, 3);
    assert.deepStrictEqual(
      captured.map(({ target }) => target),
      [0, 0, 0]
    );
    assert.ok(
      captured.every(({ snapshot }) => snapshot.parallelGroupId === "snapshots")
    );
  });

  test("keeps ordinary per-step snapshots when effective width is one", async () => {
    const queue = new PromptQueue();
    const integrations = new Map<number, MockHarnessIntegration>();
    for (let stepIndex = 0; stepIndex < 3; stepIndex += 1) {
      integrations.set(stepIndex, new MockHarnessIntegration(undefined, false));
    }
    queue.loadPrompts({
      steps: [{ prompt: "one" }, { prompt: "two" }, { prompt: "three" }],
      parallelGroups: [
        { id: "sequential", startIndex: 0, endIndex: 2, failFast: true },
      ],
    });
    const context = makeParallelContext(integrations);
    context.dynamicQueueConfig.maxParallelSteps = 1;
    const snapshotService = new RecordingSnapshotService();
    const captured: Array<{ target: number; snapshot: WorkspaceSnapshot }> = [];
    context.snapshotService = snapshotService;
    context.onSnapshotCaptured = (target, snapshot) => {
      if (target.kind === FINAL_STEP_PHASES.QUEUE) {
        captured.push({ target: target.stepIndex, snapshot });
      }
    };

    await makeExecutor(queue).execute(integrations.get(0)!, context);

    assert.deepStrictEqual(
      captured.map(({ target }) => target),
      [0, 1, 2]
    );
    assert.ok(
      captured.every(({ snapshot }) => snapshot.parallelGroupId === undefined)
    );
  });

  test("closes settled participants and releases group claims at the join", async () => {
    const queue = new PromptQueue();
    const integrations = new Map<number, MockHarnessIntegration>([
      [0, new MockHarnessIntegration(undefined, false)],
      [1, new MockHarnessIntegration(undefined, false)],
    ]);
    queue.loadPrompts({
      steps: [{ prompt: "one" }, { prompt: "two" }],
      parallelGroups: [
        { id: "coordination", startIndex: 0, endIndex: 1, failFast: true },
      ],
    });
    const context = makeParallelContext(integrations);
    const settled: number[] = [];
    const joined: string[] = [];
    context.closeCoordinationParticipant = async (target) => {
      if (target.kind === FINAL_STEP_PHASES.QUEUE)
        settled.push(target.stepIndex);
    };
    context.releaseCoordinationGroupClaims = async (group) => {
      joined.push(group.id);
    };

    await makeExecutor(queue).execute(integrations.get(0)!, context);

    assert.deepStrictEqual(settled.sort(), [0, 1]);
    assert.deepStrictEqual(joined, ["coordination"]);
  });

  test("joins parallel members completed in reverse order without advancing currentIndex early", async () => {
    const queue = new PromptQueue();
    const observedCurrentIndices: number[] = [];
    const integrations = new Map<number, MockHarnessIntegration>();
    for (const [stepIndex, delay] of [60, 30, 5].entries()) {
      const integration = new MockHarnessIntegration(undefined, false);
      integration.onSend = async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        observedCurrentIndices.push(queue.getState().currentIndex);
        return { responseText: `step-${stepIndex}` };
      };
      integrations.set(stepIndex, integration);
    }
    queue.loadPrompts({
      steps: [{ prompt: "slow" }, { prompt: "medium" }, { prompt: "fast" }],
      parallelGroups: [
        {
          id: "reverse",
          startIndex: 0,
          endIndex: 2,
          failFast: false,
        },
      ],
    });

    await makeExecutor(queue).execute(
      integrations.get(0)!,
      makeParallelContext(integrations)
    );

    assert.deepStrictEqual(observedCurrentIndices, [0, 0, 0]);
    assert.strictEqual(queue.getState().currentIndex, 3);
    assert.deepStrictEqual(
      queue.getState().results.map((result) => result.status),
      [STEP_STATUS.COMPLETED, STEP_STATUS.COMPLETED, STEP_STATUS.COMPLETED]
    );
  });

  test("failFast cancels running siblings and never launches waiting members", async () => {
    const queue = new PromptQueue();
    let releaseSibling: (() => void) | undefined;
    const integrations = new Map<number, MockHarnessIntegration>();
    const failing = new MockHarnessIntegration(undefined, false);
    failing.onSend = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      (failing as any).lastFailureReason = "first member failed";
      return { success: false };
    };
    integrations.set(0, failing);
    const sibling = new MockHarnessIntegration(undefined, false);
    sibling.onSend = async () => {
      await new Promise<void>((resolve) => {
        releaseSibling = resolve;
      });
      return { success: false };
    };
    integrations.set(1, sibling);
    integrations.set(2, new MockHarnessIntegration(undefined, false));
    const context = makeParallelContext(integrations);
    context.dynamicQueueConfig.maxParallelSteps = 2;
    context.cancelTarget = async (target) => {
      if (target.kind === FINAL_STEP_PHASES.QUEUE && target.stepIndex === 1) {
        releaseSibling?.();
      }
      await integrations
        .get(target.kind === FINAL_STEP_PHASES.QUEUE ? target.stepIndex : 0)
        ?.cancel();
    };
    queue.loadPrompts({
      steps: [{ prompt: "fail" }, { prompt: "running" }, { prompt: "waiting" }],
      parallelGroups: [
        { id: "fail-fast", startIndex: 0, endIndex: 2, failFast: true },
      ],
    });

    await makeExecutor(queue).execute(failing, context);

    assert.deepStrictEqual(integrations.get(2)?.sentPrompts, []);
    assert.deepStrictEqual(
      queue.getState().results.map((result) => result.status),
      [STEP_STATUS.FAILED, STEP_STATUS.CANCELLED, STEP_STATUS.CANCELLED]
    );
    assert.strictEqual(queue.getState().status, EXECUTION_STATES.ERROR);
  });

  test("fail-after-settle drains waiting members before failing the workflow", async () => {
    const queue = new PromptQueue();
    const integrations = new Map<number, MockHarnessIntegration>();
    for (let stepIndex = 0; stepIndex < 3; stepIndex += 1) {
      const integration = new MockHarnessIntegration(undefined, false);
      integration.onSend = async () => {
        if (stepIndex === 0) {
          (integration as any).lastFailureReason = "member failed";
          return { success: false };
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { responseText: `ok-${stepIndex}` };
      };
      integrations.set(stepIndex, integration);
    }
    queue.loadPrompts({
      steps: [{ prompt: "fail" }, { prompt: "first" }, { prompt: "waiting" }],
      parallelGroups: [
        { id: "settle", startIndex: 0, endIndex: 2, failFast: false },
      ],
    });

    const context = makeParallelContext(integrations);
    context.dynamicQueueConfig.maxParallelSteps = 2;
    await makeExecutor(queue).execute(integrations.get(0)!, context);

    assert.deepStrictEqual(integrations.get(2)?.sentPrompts, ["waiting"]);
    assert.deepStrictEqual(
      queue.getState().results.map((result) => result.status),
      [STEP_STATUS.FAILED, STEP_STATUS.COMPLETED, STEP_STATUS.COMPLETED]
    );
    assert.strictEqual(queue.getState().status, EXECUTION_STATES.ERROR);
  });

  test("does not fail the group when a member error policy continues", async () => {
    const queue = new PromptQueue();
    const continuedFailure = new MockHarnessIntegration(undefined, false);
    continuedFailure.processExitFailure = true;
    continuedFailure.onSend = async () => {
      (continuedFailure as any).lastFailureReason = "resolved member failure";
      return { success: false };
    };
    const sibling = new MockHarnessIntegration(undefined, false);
    const waiting = new MockHarnessIntegration(undefined, false);
    const integrations = new Map<number, MockHarnessIntegration>([
      [0, continuedFailure],
      [1, sibling],
      [2, waiting],
    ]);
    queue.loadPrompts({
      steps: [
        {
          prompt: "continue-after-error",
          errorBehavior: { onError: "continue" },
        },
        { prompt: "sibling" },
        { prompt: "waiting" },
      ],
      parallelGroups: [
        { id: "continued-failure", startIndex: 0, endIndex: 2, failFast: true },
      ],
    });

    const context = makeParallelContext(integrations);
    context.dynamicQueueConfig.maxParallelSteps = 1;
    await makeExecutor(queue).execute(continuedFailure, context);

    assert.deepStrictEqual(
      queue.getState().results.map((result) => result.status),
      [STEP_STATUS.FAILED, STEP_STATUS.COMPLETED, STEP_STATUS.COMPLETED]
    );
    assert.deepStrictEqual(waiting.sentPrompts, ["waiting"]);
    assert.strictEqual(
      queue.getState().steps[0]._runtime?.terminalFailure,
      false
    );
    assert.strictEqual(queue.getState().status, EXECUTION_STATES.COMPLETED);
  });

  test("pauses at the group join and resumes only unfinished members", async () => {
    const queue = new PromptQueue();
    const integrations = new Map<number, MockHarnessIntegration>();
    for (let stepIndex = 0; stepIndex < 3; stepIndex += 1) {
      const integration = new MockHarnessIntegration(undefined, false);
      integration.onSend = async () => {
        await new Promise((resolve) =>
          setTimeout(resolve, stepIndex === 0 ? 5 : 25)
        );
        return {
          responseText: `ok-${stepIndex}`,
          ...(stepIndex === 0
            ? { afterResponse: () => requestQueuePause(queue) }
            : {}),
        };
      };
      integrations.set(stepIndex, integration);
    }
    queue.loadPrompts({
      steps: [
        { prompt: "pause" },
        { prompt: "in-flight" },
        { prompt: "later" },
      ],
      parallelGroups: [
        { id: "pause", startIndex: 0, endIndex: 2, failFast: false },
      ],
    });
    const context = makeParallelContext(integrations);
    context.dynamicQueueConfig.maxParallelSteps = 2;

    await makeExecutor(queue).execute(integrations.get(0)!, context);

    assert.strictEqual(queue.getState().status, EXECUTION_STATES.PAUSED);
    assert.strictEqual(queue.getState().currentIndex, 0);
    assert.deepStrictEqual(integrations.get(2)?.sentPrompts, []);
    assert.deepStrictEqual(
      queue.getState().results.map((result) => result.status),
      [STEP_STATUS.COMPLETED, STEP_STATUS.COMPLETED, STEP_STATUS.PENDING]
    );

    await resumeQueueExecution(queue);
    await makeExecutor(queue).execute(integrations.get(0)!, context);

    assert.deepStrictEqual(integrations.get(0)?.sentPrompts, ["pause"]);
    assert.deepStrictEqual(integrations.get(1)?.sentPrompts, ["in-flight"]);
    assert.deepStrictEqual(integrations.get(2)?.sentPrompts, ["later"]);
    assert.strictEqual(queue.getState().status, EXECUTION_STATES.COMPLETED);
    assert.strictEqual(queue.getState().currentIndex, 3);
  });

  test("recovery schedules only members without terminal runtime", async () => {
    const queue = new PromptQueue();
    const integrations = new Map<number, MockHarnessIntegration>([
      [0, new MockHarnessIntegration(undefined, false)],
      [1, new MockHarnessIntegration(undefined, false)],
      [2, new MockHarnessIntegration(undefined, false)],
    ]);
    queue.loadPrompts({
      steps: [
        { prompt: "completed" },
        { prompt: "cancelled" },
        { prompt: "resume" },
      ],
      parallelGroups: [
        { id: "recovery", startIndex: 0, endIndex: 2, failFast: false },
      ],
    });
    await queue.completeStep(0);
    await queue.cancelStep(1);

    await makeExecutor(queue).execute(
      integrations.get(0)!,
      makeParallelContext(integrations)
    );

    assert.deepStrictEqual(integrations.get(0)?.sentPrompts, []);
    assert.deepStrictEqual(integrations.get(1)?.sentPrompts, []);
    assert.deepStrictEqual(integrations.get(2)?.sentPrompts, ["resume"]);
    assert.deepStrictEqual(
      queue.getState().results.map((result) => result.status),
      [STEP_STATUS.COMPLETED, STEP_STATUS.CANCELLED, STEP_STATUS.COMPLETED]
    );
    assert.strictEqual(queue.getState().currentIndex, 3);
  });

  test("joins an all-disabled parallel group as skipped", async () => {
    const queue = new PromptQueue();
    const integrations = new Map<number, MockHarnessIntegration>([
      [0, new MockHarnessIntegration(undefined, false)],
      [1, new MockHarnessIntegration(undefined, false)],
    ]);
    queue.loadPrompts({
      steps: [
        { prompt: "disabled-one", enabled: false },
        { prompt: "disabled-two", enabled: false },
      ],
      parallelGroups: [
        { id: "disabled", startIndex: 0, endIndex: 1, failFast: true },
      ],
    });

    await makeExecutor(queue).execute(
      integrations.get(0)!,
      makeParallelContext(integrations)
    );

    assert.deepStrictEqual(integrations.get(0)?.sentPrompts, []);
    assert.deepStrictEqual(integrations.get(1)?.sentPrompts, []);
    assert.deepStrictEqual(
      queue.getState().results.map((result) => result.status),
      [STEP_STATUS.SKIPPED, STEP_STATUS.SKIPPED]
    );
    assert.strictEqual(queue.getState().status, EXECUTION_STATES.COMPLETED);
  });

  test("resolves pre-condition skip and stop outcomes before group failure", async () => {
    const queue = new PromptQueue();
    const integrations = new Map<number, MockHarnessIntegration>([
      [0, new MockHarnessIntegration(undefined, false)],
      [1, new MockHarnessIntegration(undefined, false)],
      [2, new MockHarnessIntegration(undefined, false)],
    ]);
    queue.loadPrompts({
      steps: [
        {
          prompt: "skip",
          preCondition: {
            script: `node -e "process.exit(1)"`,
            onFail: CONDITION_ACTIONS.SKIP_PROMPT,
          },
        },
        {
          prompt: "stop",
          preCondition: {
            script: `node -e "process.exit(1)"`,
            onFail: CONDITION_ACTIONS.STOP_WORKFLOW,
          },
        },
        { prompt: "complete" },
      ],
      parallelGroups: [
        { id: "preconditions", startIndex: 0, endIndex: 2, failFast: false },
      ],
    });

    await makeExecutor(queue).execute(
      integrations.get(0)!,
      makeParallelContext(integrations)
    );

    assert.deepStrictEqual(integrations.get(0)?.sentPrompts, []);
    assert.deepStrictEqual(integrations.get(1)?.sentPrompts, []);
    assert.deepStrictEqual(integrations.get(2)?.sentPrompts, ["complete"]);
    assert.deepStrictEqual(
      queue.getState().results.map((result) => result.status),
      [STEP_STATUS.SKIPPED, STEP_STATUS.FAILED, STEP_STATUS.COMPLETED]
    );
    assert.strictEqual(queue.getState().status, EXECUTION_STATES.ERROR);
  });

  test("keeps end-condition retries inside one parallel member contract", async () => {
    const queue = new PromptQueue();
    const retrying = new MockHarnessIntegration(undefined, false);
    const sibling = new MockHarnessIntegration(undefined, false);
    const integrations = new Map<number, MockHarnessIntegration>([
      [0, retrying],
      [1, sibling],
    ]);
    queue.loadPrompts({
      steps: [
        {
          prompt: "retry-member",
          endCondition: {
            script: `node -e "process.stdout.write('ok')"`,
            compareSource: "stdout",
            returns: "ok",
            onPass: CONDITION_ACTIONS.RETRY,
            onFail: CONDITION_ACTIONS.STOP_WORKFLOW,
            maxRetries: 1,
            passRetryPrompt: "retry-member-again",
          },
        },
        { prompt: "sibling" },
      ],
      parallelGroups: [
        { id: "retry", startIndex: 0, endIndex: 1, failFast: true },
      ],
    });

    await makeExecutor(queue).execute(
      retrying,
      makeParallelContext(integrations)
    );

    assert.deepStrictEqual(retrying.sentPrompts, [
      "retry-member",
      "retry-member-again",
    ]);
    assert.deepStrictEqual(sibling.sentPrompts, ["sibling"]);
    assert.strictEqual(queue.getState().currentIndex, 2);
    assert.strictEqual(queue.getState().status, EXECUTION_STATES.COMPLETED);
  });

  test("preflights inherited/default session collisions before any group member launches", async () => {
    const queue = new PromptQueue();
    queue.loadPrompts({
      resumeSession: true,
      sessionId: "shared-session",
      steps: [
        { name: "alpha", prompt: "one" },
        { name: "beta", prompt: "two" },
      ],
      parallelGroups: [
        {
          id: "group",
          startIndex: 0,
          endIndex: 1,
          failFast: true,
        },
      ],
    });
    const integration = new MockHarnessIntegration(undefined, false);
    await assert.rejects(
      makeExecutor(queue).execute(integration, makeContext(integration)),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Step 1 \("alpha"\).*Step 2 \("beta"\)/s);
        return true;
      }
    );
    assert.deepStrictEqual(integration.sentPrompts, []);
  });

  test("gates unknown MCP references in fail mode but reports and continues in warn mode", async () => {
    const promptText = "Use /mcp:missing-for-strict-resolution-test";
    const failQueue = new PromptQueue();
    failQueue.loadPrompts({ steps: [{ prompt: promptText }] });
    const failIntegration = new MockHarnessIntegration(undefined, false);
    const failDiagnostics: CompatibilityDiagnostic[] = [];
    let failIntegrationLookups = 0;

    configService.setCliOverlay({
      execution: {
        strictContextResolution: CONTEXT_RESOLUTION_FAILURE_MODES.FAIL,
      },
    });
    try {
      await assert.rejects(
        makeExecutor(failQueue).execute(failIntegration, {
          ...makeContext(failIntegration),
          getIntegrationForPrompt: () => {
            failIntegrationLookups += 1;
            return failIntegration;
          },
          reportCompatibilityDiagnostics: (diagnostics) =>
            failDiagnostics.push(...diagnostics),
        }),
        /Step blocked by execution\.strictContextResolution="fail"/u
      );
      assert.strictEqual(failIntegration.sentPrompts.length, 0);
      assert.strictEqual(failIntegrationLookups, 0);
      assert.strictEqual(failDiagnostics.length, 1);
      assert.strictEqual(
        failDiagnostics[0].code,
        PROMPT_DIAGNOSTIC_CODES.UNKNOWN_MCP_REFERENCE
      );
    } finally {
      configService.setCliOverlay({});
    }

    const warnQueue = new PromptQueue();
    warnQueue.loadPrompts({ steps: [{ prompt: promptText }] });
    const warnIntegration = new MockHarnessIntegration(undefined, false);
    const warnDiagnostics: CompatibilityDiagnostic[] = [];
    configService.setCliOverlay({
      execution: {
        strictContextResolution: CONTEXT_RESOLUTION_FAILURE_MODES.WARN,
      },
    });
    try {
      await makeExecutor(warnQueue).execute(warnIntegration, {
        ...makeContext(warnIntegration),
        reportCompatibilityDiagnostics: (diagnostics) =>
          warnDiagnostics.push(...diagnostics),
      });
      assert.deepStrictEqual(warnIntegration.sentPrompts, [promptText]);
      assert.strictEqual(warnDiagnostics.length, 1);
      assert.strictEqual(
        warnDiagnostics[0].code,
        PROMPT_DIAGNOSTIC_CODES.UNKNOWN_MCP_REFERENCE
      );
    } finally {
      configService.setCliOverlay({});
    }
  });

  test("gates a missing declared secret in fail mode but reports and continues in warn mode", async () => {
    const promptText = "Use !MISSING_TEST_SECRET_XYZ for auth";
    const failQueue = new PromptQueue();
    failQueue.loadPrompts({ steps: [{ prompt: promptText }] });
    const failIntegration = new MockHarnessIntegration(undefined, false);

    configService.setCliOverlay({
      execution: {
        strictContextResolution: CONTEXT_RESOLUTION_FAILURE_MODES.FAIL,
      },
    });
    try {
      await assert.rejects(
        makeExecutor(failQueue).execute(
          failIntegration,
          makeContext(failIntegration)
        ),
        /MISSING_TEST_SECRET_XYZ/u
      );
      assert.strictEqual(failIntegration.sentPrompts.length, 0);
    } finally {
      configService.setCliOverlay({});
    }

    const warnQueue = new PromptQueue();
    warnQueue.loadPrompts({ steps: [{ prompt: promptText }] });
    const warnIntegration = new MockHarnessIntegration(undefined, false);
    const warnStatusMessages: Array<{ message: string; severity: string }> = [];
    const dashboardProvider = new Proxy(
      {
        updateStatusMessage: (
          _stepIndex: number,
          message: string,
          severity: string
        ) => warnStatusMessages.push({ message, severity }),
      },
      {
        get: (target, property) =>
          Reflect.get(target, property) ?? (() => undefined),
      }
    );

    configService.setCliOverlay({
      execution: {
        strictContextResolution: CONTEXT_RESOLUTION_FAILURE_MODES.WARN,
      },
    });
    try {
      const warnContext = makeContext(warnIntegration);
      warnContext.dashboardProvider = dashboardProvider as any;
      await makeExecutor(warnQueue).execute(warnIntegration, warnContext);
      assert.deepStrictEqual(warnIntegration.sentPrompts, [promptText]);
      assert.ok(
        warnStatusMessages.some((status) =>
          status.message.includes("MISSING_TEST_SECRET_XYZ")
        ),
        "expected a warning status row naming the unresolved secret"
      );
    } finally {
      configService.setCliOverlay({});
    }
  });

  test("reports prompt-text secret interpolation as an advisory without blocking, even in fail mode", async () => {
    // A prompt that merely quotes ${secret:NAME} — plans and instruction files
    // legitimately document the syntax — must never block the step.
    const promptText =
      "Explain why ${secret:X} is never substituted into prompt text";
    const queue = new PromptQueue();
    queue.loadPrompts({ steps: [{ prompt: promptText }] });
    const integration = new MockHarnessIntegration(undefined, false);
    const diagnostics: CompatibilityDiagnostic[] = [];

    configService.setCliOverlay({
      execution: {
        strictContextResolution: CONTEXT_RESOLUTION_FAILURE_MODES.FAIL,
      },
    });
    try {
      await makeExecutor(queue).execute(integration, {
        ...makeContext(integration),
        reportCompatibilityDiagnostics: (reported) =>
          diagnostics.push(...reported),
      });
    } finally {
      configService.setCliOverlay({});
    }

    assert.deepStrictEqual(integration.sentPrompts, [promptText]);
    const advisories = diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === PROMPT_DIAGNOSTIC_CODES.SECRET_INTERPOLATION_IGNORED
    );
    assert.strictEqual(advisories.length, 1);
    assert.ok(advisories[0].message.includes("${secret:X}"));
    assert.strictEqual(
      isContextResolutionDiagnostic(advisories[0].code),
      false,
      "the advisory must stay outside the blocking set"
    );
  });

  test("leaves unresolved variables literal, reports their fields, and does not block in fail mode", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const diagnostics: CompatibilityDiagnostic[] = [];
    queue.loadPrompts({
      vars: { known: "value" },
      steps: [
        {
          name: "Document variables",
          prompt: "Explain {{unknownPrompt}} and ```\n{{fenced}}\n```",
          model: "{{unknownModel}}",
          additionalArgs: "--value {{unknownArgs}}",
          hooks: [
            {
              event: "stop",
              command: "notify {{unknownHookCommand}}",
              env: { HOOK_VALUE: "{{unknownHookEnv}}" },
            },
          ],
          preCondition: {
            script: `node -e "process.stdout.write('0')" # {{unknownPreScript}}`,
            env: { PRE_VALUE: "{{unknownPreEnv}}" },
            returns: "0",
          },
          endCondition: {
            script: `node -e "process.stdout.write('0')" # {{unknownEndScript}}`,
            env: { END_VALUE: "{{unknownEndEnv}}" },
            returns: "0",
            retryPrompt: "Retry {{unknownRetryPrompt}}",
            passRetryPrompt: "Pass {{unknownPassRetryPrompt}}",
          },
        },
      ],
    });

    configService.setCliOverlay({
      execution: {
        strictContextResolution: CONTEXT_RESOLUTION_FAILURE_MODES.FAIL,
      },
    });
    try {
      await makeExecutor(queue).execute(integration, {
        ...makeContext(integration),
        reportCompatibilityDiagnostics: (reported) =>
          diagnostics.push(...reported),
      });
    } finally {
      configService.setCliOverlay({});
    }

    assert.deepStrictEqual(integration.sentPrompts, [
      "Explain {{unknownPrompt}} and ```\n{{fenced}}\n```",
    ]);
    assert.strictEqual(queue.getState().status, EXECUTION_STATES.COMPLETED);
    const variableAdvisories = diagnostics.filter(
      (diagnostic) =>
        diagnostic.code ===
        PROMPT_DIAGNOSTIC_CODES.VARIABLE_SUBSTITUTION_IGNORED
    );
    assert.strictEqual(variableAdvisories.length, 2);
    const diagnosticText = variableAdvisories
      .map((item) => item.message)
      .join(" ");
    for (const field of [
      "prompt text",
      "model",
      "additionalArgs",
      "hook[0].command",
      "hook[0].env.HOOK_VALUE",
      "preCondition.script",
      "preCondition.env.PRE_VALUE",
      "endCondition.script",
      "endCondition.env.END_VALUE",
      "endCondition.retryPrompt",
      "endCondition.passRetryPrompt",
    ]) {
      assert.ok(diagnosticText.includes(field), `missing field ${field}`);
    }
    assert.ok(diagnosticText.includes('step 1 ("Document variables")'));
    assert.strictEqual(
      variableAdvisories.some((diagnostic) =>
        isContextResolutionDiagnostic(diagnostic.code)
      ),
      false,
      "variable advisories must stay outside the blocking set"
    );
  });

  test("runs prompts documenting every reference syntax without blocking", async () => {
    const promptText = [
      "Document these ctrlyoke reference syntaxes:",
      "```text",
      "!NAME",
      "${secret:NAME}",
      "{{var}}",
      "@src/example.ts",
      "#sym:src/example.ts:Example:1-2",
      "~diff",
      "/skill:name",
      "/mcp:name",
      "$step:1,3-5",
      "```",
    ].join("\n");

    const run = async (strictContextResolution: boolean): Promise<void> => {
      const queue = new PromptQueue();
      queue.loadPrompts({ steps: [{ prompt: promptText }] });
      const integration = new MockHarnessIntegration(undefined, false);
      const diagnostics: CompatibilityDiagnostic[] = [];

      configService.setCliOverlay(
        strictContextResolution
          ? {
              execution: {
                strictContextResolution: CONTEXT_RESOLUTION_FAILURE_MODES.FAIL,
              },
            }
          : {}
      );
      try {
        await makeExecutor(queue).execute(integration, {
          ...makeContext(integration),
          reportCompatibilityDiagnostics: (reported) =>
            diagnostics.push(...reported),
        });
      } finally {
        configService.setCliOverlay({});
      }

      assert.strictEqual(queue.getState().status, EXECUTION_STATES.COMPLETED);
      assert.deepStrictEqual(integration.sentPrompts, [promptText]);
      assert.strictEqual(
        diagnostics.some((diagnostic) =>
          isContextResolutionDiagnostic(diagnostic.code)
        ),
        false,
        "fenced reference examples must not produce blocking diagnostics"
      );
    };

    await run(false);
    await run(true);
  });

  test("leaves unresolved script-step variables literal and reports script fields", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const diagnostics: CompatibilityDiagnostic[] = [];
    queue.loadPrompts({
      vars: { known: "value" },
      steps: [
        {
          type: "script",
          name: "Document script variables",
          script: `node -e "process.exit(0)" # {{unknownScript}}`,
          env: { SCRIPT_VALUE: "{{unknownScriptEnv}}" },
        },
      ],
    });

    await makeExecutor(queue).execute(integration, {
      ...makeContext(integration),
      reportCompatibilityDiagnostics: (reported) =>
        diagnostics.push(...reported),
    });

    assert.strictEqual(queue.getState().status, EXECUTION_STATES.COMPLETED);
    const advisory = diagnostics.find(
      (diagnostic) =>
        diagnostic.code ===
        PROMPT_DIAGNOSTIC_CODES.VARIABLE_SUBSTITUTION_IGNORED
    );
    assert.ok(advisory);
    assert.ok(
      advisory.message.includes('step 1 ("Document script variables")')
    );
    assert.ok(advisory.message.includes("script-step.script"));
    assert.ok(advisory.message.includes("script-step.env.SCRIPT_VALUE"));
  });

  test("resolves prompt-file references at execution time without replacing queue state", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-executor-prompt-file-")
    );
    try {
      const sourceDefinitionPath = path.join(root, "workflow.ctrlyoke.json");
      const promptFilePath = path.join(root, "current.prompt.md");
      await fs.writeFile(promptFilePath, "first contents", "utf8");

      const integration = new MockHarnessIntegration(undefined, false);
      const queue = new PromptQueue();
      queue.loadPrompts({ steps: [{ prompt: "inline" }] });
      await queue.updatePrompt(0, { prompt: "./current.prompt.md" });

      await makeExecutor(queue).execute(integration, {
        ...makeContext(integration),
        workspaceFolderPath: root,
        sourceDefinitionPath,
      });

      assert.deepStrictEqual(integration.sentPrompts, ["first contents"]);
      assert.strictEqual(
        (queue.getState().steps[0] as PromptStep).prompt,
        "./current.prompt.md"
      );

      const secondIntegration = new MockHarnessIntegration(undefined, false);
      const secondQueue = new PromptQueue();
      await fs.writeFile(promptFilePath, "updated contents", "utf8");
      secondQueue.loadPrompts({ steps: [{ prompt: "./current.prompt.md" }] });
      await makeExecutor(secondQueue).execute(secondIntegration, {
        ...makeContext(secondIntegration),
        workspaceFolderPath: root,
        sourceDefinitionPath,
      });

      assert.deepStrictEqual(secondIntegration.sentPrompts, [
        "updated contents",
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("substitutes variables before resolving prompt-file references", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-executor-variable-prompt-file-")
    );
    try {
      await fs.writeFile(
        path.join(root, "current.prompt.md"),
        "variable contents",
        "utf8"
      );
      const integration = new MockHarnessIntegration(undefined, false);
      const queue = new PromptQueue();
      queue.loadPrompts({
        vars: { name: "current" },
        steps: [{ prompt: "./{{name}}.prompt.md" }],
      });

      await makeExecutor(queue).execute(integration, {
        ...makeContext(integration),
        workspaceFolderPath: root,
        sourceDefinitionPath: path.join(root, "workflow.ctrlyoke.json"),
      });

      assert.deepStrictEqual(integration.sentPrompts, ["variable contents"]);
      assert.strictEqual(
        (queue.getState().steps[0] as PromptStep).prompt,
        "./{{name}}.prompt.md"
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("substitutes {{var}} in a preCondition's script and env before running it", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    queue.loadPrompts({
      vars: { token: "pre-output" },
      steps: [
        {
          prompt: "after-precondition",
          preCondition: {
            script: `node -e "process.stdout.write(process.env.CHECK_TOKEN === '{{token}}' ? '{{token}}' : 'mismatch')"`,
            env: { CHECK_TOKEN: "{{token}}" },
            compareSource: "stdout",
            returns: "pre-output",
          },
        },
      ],
    });

    await executor.execute(integration, makeContext(integration));

    // If {{token}} were not substituted, the script's stdout would compare
    // against the literal placeholder text and fail, so the default
    // onFail (skipPrompt) would leave sentPrompts empty.
    assert.deepStrictEqual(integration.sentPrompts, ["after-precondition"]);
    assert.strictEqual(
      queue.getState().results[0].status,
      STEP_STATUS.COMPLETED
    );
  });

  test("substitutes {{var}} in a script step's script and env before running it", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    queue.loadPrompts({
      vars: { greeting: "hello-world" },
      steps: [
        {
          type: "script",
          script: `node -e "process.stdout.write(process.env.GREETING || '')"`,
          env: { GREETING: "{{greeting}}" },
          compareSource: "stdout",
          returns: "hello-world",
        },
      ],
    });

    await executor.execute(integration, makeContext(integration));

    assert.strictEqual(queue.getState().status, EXECUTION_STATES.COMPLETED);
    assert.strictEqual(
      queue.getState().results[0].status,
      STEP_STATUS.COMPLETED
    );
  });

  test("fails before sending missing or empty prompt-file references", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-executor-invalid-prompt-file-")
    );
    try {
      const sourceDefinitionPath = path.join(root, "workflow.ctrlyoke.json");
      const cases = [
        {
          name: "missing.prompt.md",
          content: undefined,
          error: /could not be found/,
        },
        { name: "empty.prompt.md", content: " \n\t", error: /Prompt is empty/ },
      ];
      for (const currentCase of cases) {
        if (currentCase.content !== undefined) {
          await fs.writeFile(
            path.join(root, currentCase.name),
            currentCase.content,
            "utf8"
          );
        }
        const integration = new MockHarnessIntegration(undefined, false);
        const queue = new PromptQueue();
        queue.loadPrompts({ steps: [{ prompt: `./${currentCase.name}` }] });

        await assert.rejects(
          makeExecutor(queue).execute(integration, {
            ...makeContext(integration),
            workspaceFolderPath: root,
            sourceDefinitionPath,
          }),
          currentCase.error
        );
        assert.deepStrictEqual(integration.sentPrompts, []);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("logs the effective next-step harness instead of the default integration", async () => {
    const queue = new PromptQueue();
    const defaultIntegration = new MockHarnessIntegration(undefined, false);
    const effectiveIntegration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);
    const requestedHarnesses: Array<string | undefined> = [];
    const messages: string[] = [];

    queue.loadPrompts({
      steps: [
        {
          prompt: "uses an override",
          harness: HARNESS_IDS.ANTIGRAVITY_CLI,
        },
      ],
    });
    const context: WorkflowExecutionContext = {
      ...makeContext(effectiveIntegration),
      getIntegrationForPrompt: (_prompt, harnessOverride) => {
        requestedHarnesses.push(harnessOverride);
        return effectiveIntegration;
      },
    };
    const originalInfo = Log.info;
    Log.info = (message: string) => {
      messages.push(message);
    };

    try {
      await executor.execute(defaultIntegration, context);
    } finally {
      Log.info = originalInfo;
    }

    const startMessage = messages.find((message) =>
      message.includes("Workflow started -")
    );
    assert.ok(startMessage);
    assert.ok(
      startMessage.includes(`next harness: ${HARNESS_IDS.ANTIGRAVITY_CLI}`),
      startMessage
    );
    assert.deepStrictEqual(requestedHarnesses, [HARNESS_IDS.ANTIGRAVITY_CLI]);
  });

  test("preserves behavior when finalStep is absent", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    const promptFile: PromptFile = {
      steps: [{ prompt: "queue-1" }, { prompt: "queue-2" }],
    };
    queue.loadPrompts(promptFile);

    await executor.execute(integration, makeContext(integration));

    assert.deepStrictEqual(integration.sentPrompts, ["queue-1", "queue-2"]);
    assert.strictEqual(queue.getState().status, EXECUTION_STATES.COMPLETED);
    assert.strictEqual(queue.getFinalStepRuntime(), undefined);
  });

  test("publishes and persists pre- and end-condition output", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);
    const liveStatuses: Array<{
      stepIndex: number;
      message: string;
      severity: string;
    }> = [];
    const persistedStatuses: Array<{
      target: unknown;
      message: string;
      severity: string;
    }> = [];

    const outputHistoryManager = new Proxy(
      {
        appendStatusMessage: async (
          _historyFilePath: string,
          target: unknown,
          statusMessage: { message: string; severity: string }
        ) => {
          persistedStatuses.push({
            target,
            message: statusMessage.message,
            severity: statusMessage.severity,
          });
        },
      },
      {
        get: (target, property) =>
          Reflect.get(target, property) ?? (async () => undefined),
      }
    );

    queue.loadPrompts({
      steps: [
        {
          prompt: "condition-output",
          preCondition: {
            script: `node -e "process.stdout.write('pre-output')"`,
            compareSource: "stdout",
            returns: "pre-output",
          },
          endCondition: {
            script: `node -e "process.stdout.write('end-output')"`,
            compareSource: "stdout",
            returns: "end-output",
          },
        },
      ],
    });

    const context = makeContext(integration);
    context.historyFilePath = "manifest.json";
    context.outputHistoryManager = outputHistoryManager as any;
    context.onStatusMessage = (stepIndex, message, severity) => {
      liveStatuses.push({ stepIndex, message, severity });
    };
    await executor.execute(integration, context);

    const preResult = liveStatuses.find((status) =>
      status.message.startsWith("Pre-condition passed")
    );
    assert.ok(preResult);
    assert.match(preResult.message, /stdout = "pre-output"/);
    assert.match(preResult.message, /→ continue/);
    assert.strictEqual(preResult.severity, "info");

    const endResult = liveStatuses.find((status) =>
      status.message.startsWith("End condition passed")
    );
    assert.ok(endResult);
    assert.match(endResult.message, /stdout = "end-output"/);
    assert.strictEqual(endResult.severity, "info");

    assert.deepStrictEqual(
      persistedStatuses.map(({ message, severity }) => ({
        message,
        severity,
      })),
      liveStatuses.map(({ message, severity }) => ({ message, severity }))
    );
    assert.ok(
      persistedStatuses.every(
        ({ target }) =>
          JSON.stringify(target) ===
          JSON.stringify({
            kind: FINAL_STEP_PHASES.QUEUE,
            stepIndex: 0,
          })
      )
    );

    assert.deepStrictEqual(queue.getState().results[0].preCondition, {
      passed: true,
      action: CONDITION_ACTIONS.CONTINUE,
      script: `node -e "process.stdout.write('pre-output')"`,
      expected: "pre-output",
      compareSource: "stdout",
      actual: "pre-output",
      actualSource: "stdout",
      stdout: "pre-output",
      stderr: "",
      exitCode: 0,
      durationMs: queue.getState().results[0].preCondition?.durationMs,
    });
    assert.strictEqual(queue.getState().results[0].endCondition?.passed, true);
    assert.strictEqual(
      queue.getState().results[0].endCondition?.stdout,
      "end-output"
    );
  });

  test("round-trips a passing end-condition retry through history before advancing", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);
    const retryRecords: Array<{
      target: unknown;
      runIndex: number;
      attemptIndex: number;
      previousAttemptIndex: number;
      retryPrompt: string;
    }> = [];
    const outputHistoryManager = new Proxy(
      {
        recordRetryScheduled: async (
          _historyFilePath: string,
          target: unknown,
          runIndex: number,
          attemptIndex: number,
          previousAttemptIndex: number,
          retryPrompt: string
        ) => {
          retryRecords.push({
            target,
            runIndex,
            attemptIndex,
            previousAttemptIndex,
            retryPrompt,
          });
        },
      },
      {
        get: (target, property) =>
          Reflect.get(target, property) ?? (async () => undefined),
      }
    );

    queue.loadPrompts({
      steps: [
        {
          prompt: "write the regression test",
          endCondition: {
            script: `node -e "process.stdout.write('ok')"`,
            compareSource: "stdout",
            returns: "ok",
            onPass: "retry",
            onFail: "stopWorkflow",
            maxRetries: 1,
            passRetryPrompt: "strengthen the regression test",
          },
        },
        { prompt: "continue the workflow" },
      ],
    });

    await executor.execute(integration, {
      ...makeContext(integration),
      historyFilePath: "history.json",
      outputHistoryManager: outputHistoryManager as any,
    });

    assert.deepStrictEqual(integration.sentPrompts, [
      "write the regression test",
      "strengthen the regression test",
      "continue the workflow",
    ]);
    assert.deepStrictEqual(retryRecords, [
      {
        target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        runIndex: 0,
        attemptIndex: 1,
        previousAttemptIndex: 0,
        retryPrompt: "strengthen the regression test",
      },
    ]);
    assert.strictEqual(queue.getState().status, EXECUTION_STATES.COMPLETED);
    assert.strictEqual(queue.getState().currentIndex, 2);
    assert.strictEqual(
      queue.getState().results[0].status,
      STEP_STATUS.COMPLETED
    );
    assert.strictEqual(
      queue.getState().results[1].status,
      STEP_STATUS.COMPLETED
    );
  });

  test("skips disabled queue steps without sending them to the harness", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    queue.loadPrompts({
      steps: [
        { prompt: "disabled-step", enabled: false },
        { prompt: "enabled-step" },
      ],
    });

    await executor.execute(integration, makeContext(integration));

    assert.deepStrictEqual(integration.sentPrompts, ["enabled-step"]);
    assert.strictEqual(queue.getState().results[0].status, STEP_STATUS.SKIPPED);
    assert.strictEqual(
      queue.getState().steps[0]._runtime?.terminalStatus,
      STEP_STATUS.SKIPPED
    );
    assert.strictEqual(queue.getState().status, EXECUTION_STATES.COMPLETED);
  });

  test("records a failed pre-condition that skips the prompt", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    queue.loadPrompts({
      steps: [
        {
          prompt: "should be skipped",
          preCondition: {
            script: `node -e "process.exit(1)"`,
            onFail: CONDITION_ACTIONS.SKIP_PROMPT,
          },
        },
      ],
    });

    await executor.execute(integration, makeContext(integration));

    assert.deepStrictEqual(integration.sentPrompts, []);
    assert.strictEqual(queue.getState().results[0].status, STEP_STATUS.SKIPPED);
    assert.strictEqual(queue.getState().results[0].preCondition?.passed, false);
    assert.strictEqual(
      queue.getState().results[0].preCondition?.action,
      CONDITION_ACTIONS.SKIP_PROMPT
    );
  });

  test("records a pre-condition evaluator error before continuing", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const platform = new MockPlatform();
    const evaluator = new FixedEvaluationEvaluator(platform, {
      passed: false,
      matchRule: "none",
      actual: "",
      actualSource: "exitCode",
      errored: true,
      stdout: "",
      stderr: "evaluator failed",
      result: "",
      duration: 3,
      error: "evaluator failed",
    });
    const executor = makeExecutor(queue, evaluator);

    queue.loadPrompts({
      steps: [
        {
          prompt: "continues after gate error",
          preCondition: { script: "check-gate.js" },
          errorBehavior: { onError: "continue" },
        },
      ],
    });

    await executor.execute(integration, makeContext(integration));

    assert.deepStrictEqual(integration.sentPrompts, [
      "continues after gate error",
    ]);
    assert.strictEqual(queue.getState().results[0].preCondition?.passed, false);
    assert.strictEqual(
      queue.getState().results[0].preCondition?.action,
      CONDITION_ACTIONS.CONTINUE
    );
    assert.strictEqual(
      queue.getState().results[0].preCondition?.error,
      "evaluator failed"
    );
  });

  test("runs finalStep once after queue drains", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    queue.loadPrompts({
      steps: [{ prompt: "queue-1" }, { prompt: "queue-2" }],
      finalStep: {
        prompt: "final-gate",
        harness: HARNESS_IDS.CODEX_CLI,
        model: "gpt-5.4-mini",
      },
    });

    await executor.execute(integration, makeContext(integration));

    assert.deepStrictEqual(integration.sentPrompts, [
      "queue-1",
      "queue-2",
      "final-gate",
    ]);
    const runtime = queue.getFinalStepRuntime();
    assert.ok(runtime);
    assert.strictEqual(runtime?.phase, FINAL_STEP_PHASES.FINAL_STEP);
    assert.strictEqual(runtime?.loopCount, 0);
    assert.strictEqual(runtime?.status, STEP_STATUS.COMPLETED);
    assert.ok(runtime?.completedAt);
    assert.strictEqual(
      queue.getWorkflowFile().finalStep?._runtime?.harness,
      HARNESS_IDS.CODEX_CLI
    );
    assert.strictEqual(
      queue.getWorkflowFile().finalStep?._runtime?.model,
      "gpt-5.4-mini"
    );
  });

  test("keeps disabled finalStep present but skips execution", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    queue.loadPrompts({
      steps: [{ prompt: "queue-1" }],
      finalStep: { prompt: "final-disabled", enabled: false },
    });

    await executor.execute(integration, makeContext(integration));

    assert.deepStrictEqual(integration.sentPrompts, ["queue-1"]);
    assert.strictEqual(
      queue.getWorkflowFile().finalStep?.enabled,
      false,
      "disabled finalStep should remain in the workflow"
    );
    const runtime = queue.getFinalStepRuntime();
    assert.ok(runtime);
    assert.strictEqual(runtime?.status, STEP_STATUS.SKIPPED);
    assert.strictEqual(runtime?.phase, FINAL_STEP_PHASES.FINAL_STEP);
    assert.strictEqual(queue.getState().status, EXECUTION_STATES.COMPLETED);
  });

  test("repeats loop when finalStep appends queue work", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    let finalRuns = 0;
    integration.onSend = async (prompt, _workflowContext) => {
      if (prompt.prompt === "final-loop") {
        finalRuns++;
        if (finalRuns === 1) {
          await queue.appendSteps([{ prompt: "queue-appended" }], "test");
        }
      }
      return { success: true, responseText: `ok:${prompt.prompt}` };
    };

    queue.loadPrompts({
      steps: [{ prompt: "queue-1" }],
      finalStep: { prompt: "final-loop", mcpServers: ["ctrlyoke"] },
    });

    await executor.execute(integration, makeContext(integration));

    assert.deepStrictEqual(integration.sentPrompts, [
      "queue-1",
      "final-loop",
      "queue-appended",
      "final-loop",
    ]);
    const runtime = queue.getFinalStepRuntime();
    assert.ok(runtime);
    assert.strictEqual(runtime?.loopCount, 1);
    assert.strictEqual(runtime?.phase, FINAL_STEP_PHASES.FINAL_STEP);
  });

  test("does not loop when queue does not grow", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    queue.loadPrompts({
      steps: [{ prompt: "queue-1" }],
      finalStep: { prompt: "final-once" },
    });

    await executor.execute(integration, makeContext(integration));

    assert.deepStrictEqual(integration.sentPrompts, ["queue-1", "final-once"]);
    const finalRuns = integration.sentPrompts.filter(
      (p) => p === "final-once"
    ).length;
    assert.strictEqual(finalRuns, 1);
  });

  test("fully finalizes a finalStep before honoring pause", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    integration.onSend = async (prompt) => {
      if (prompt.prompt === "final-pause") {
        return {
          success: true,
          responseText: "ok",
          afterResponse: async () => {
            await requestQueuePause(queue);
          },
        };
      }
      return { success: true, responseText: "ok" };
    };

    queue.loadPrompts({
      steps: [{ prompt: "queue-1" }],
      finalStep: { prompt: "final-pause" },
    });

    await executor.execute(integration, makeContext(integration));

    assert.strictEqual(queue.getState().status, EXECUTION_STATES.COMPLETED);
    const runtime = queue.getFinalStepRuntime();
    assert.strictEqual(runtime?.phase, FINAL_STEP_PHASES.FINAL_STEP);
    assert.strictEqual(runtime?.loopCount, 0);
    assert.strictEqual(runtime?.status, STEP_STATUS.COMPLETED);
    assert.ok(runtime?.completedAt);
  });

  test("finalizes output, stats, and queue position before pausing", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);
    let completedOutput: { response?: string; elapsed?: number } | undefined;
    const statusUpdates: Array<{ state: string; duration?: number }> = [];
    const dashboardProvider = new Proxy(
      {
        updateStepStatus: (
          _stepIndex: number,
          status: { state: string; duration?: number }
        ) => statusUpdates.push(status),
      },
      {
        get: (target, property) =>
          Reflect.get(target, property) ?? (() => undefined),
      }
    );

    integration.onSend = async (prompt) => ({
      success: true,
      responseText: `done:${prompt.prompt}`,
      afterResponse: async () => requestQueuePause(queue),
    });
    queue.loadPrompts({
      steps: [{ prompt: "pause-after-me" }, { prompt: "not-yet" }],
    });

    await executor.execute(integration, {
      ...makeContext(integration),
      captureCompletedOutput: (_stepIndex, output) => {
        completedOutput = output;
      },
      dashboardProvider: dashboardProvider as any,
    });

    const state = queue.getState();
    assert.strictEqual(state.status, EXECUTION_STATES.PAUSED);
    assert.strictEqual(state.currentIndex, 1);
    assert.strictEqual(state.results[0]?.status, STEP_STATUS.COMPLETED);
    assert.ok(state.steps[0]?._runtime?.completedAt);
    assert.deepStrictEqual(integration.sentPrompts, ["pause-after-me"]);
    assert.strictEqual(completedOutput?.response, "done:pause-after-me");
    assert.strictEqual(typeof completedOutput?.elapsed, "number");
    assert.ok(
      statusUpdates.some((status) => status.state === STEP_STATUS.COMPLETED)
    );
  });

  test("preserves finalStep runtime phase on stop/error during finalStep", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    let run = 0;
    integration.onSend = async (prompt) => {
      if (prompt.prompt === "final-stop-error") {
        run++;
        if (run === 1) {
          await requestQueueStop(queue);
          return { success: false };
        }
        return { success: false };
      }
      return { success: true, responseText: "ok" };
    };

    queue.loadPrompts({
      steps: [{ prompt: "queue-1" }],
      finalStep: { prompt: "final-stop-error" },
    });

    await executor.execute(integration, makeContext(integration));

    const runtimeAfterStop = queue.getFinalStepRuntime();
    assert.strictEqual(runtimeAfterStop?.phase, FINAL_STEP_PHASES.FINAL_STEP);

    // Simulate resume and force an actual error on finalStep send failure
    await confirmQueueStopped(queue);
    await resumeQueueExecution(queue);
    await executor.execute(integration, makeContext(integration));

    assert.strictEqual(queue.getState().status, EXECUTION_STATES.ERROR);
    const runtimeAfterError = queue.getFinalStepRuntime();
    assert.strictEqual(runtimeAfterError?.phase, FINAL_STEP_PHASES.FINAL_STEP);
    assert.strictEqual(runtimeAfterError?.status, STEP_STATUS.FAILED);
  });

  test("persists user-stopped output without an error message and emits a warning status", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    const captureCalls: Array<{ stepIndex: number; output: any }> = [];
    const statusCalls: Array<{
      stepIndex: number;
      message: string;
      severity: string;
    }> = [];

    integration.lastFailureOutput = "partial response before stop";
    integration.onSend = async () => {
      (integration as any).lastFailureReason = "Stopped by user";
      await requestQueueStop(queue);
      return { success: false };
    };

    const context = makeContext(integration);
    context.captureCompletedOutput = (stepIndex, output) => {
      captureCalls.push({ stepIndex, output });
    };
    context.onStatusMessage = (stepIndex, message, severity) => {
      statusCalls.push({ stepIndex, message, severity });
    };

    queue.loadPrompts({
      steps: [{ prompt: "stop-me" }, { prompt: "after-stop" }],
    });

    await executor.execute(integration, context);

    assert.strictEqual(queue.getState().status, EXECUTION_STATES.STOPPED);
    assert.strictEqual(captureCalls.length, 1);
    assert.strictEqual(captureCalls[0].stepIndex, 0);
    assert.strictEqual(
      captureCalls[0].output.response,
      "partial response before stop"
    );
    assert.strictEqual(captureCalls[0].output.errorMessage, undefined);

    assert.deepStrictEqual(statusCalls, [
      {
        stepIndex: 0,
        message: "Stopped by user",
        severity: "warning",
      },
    ]);
  });

  test("reports the execution root (not the source workspace) as the CLI working directory", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    const worktreeRoot = path.join(os.tmpdir(), "ctrlyoke-worktree-root");
    const context = makeContext(integration);
    context.workspaceFolderPath = path.join(
      os.tmpdir(),
      "ctrlyoke-source-root"
    );
    context.executionWorkspace = {
      ...context.executionWorkspace,
      executionRoot: worktreeRoot,
    };

    const captureCalls: Array<{ stepIndex: number; output: any }> = [];
    context.captureCompletedOutput = (stepIndex, output) => {
      captureCalls.push({ stepIndex, output });
    };

    queue.loadPrompts({ steps: [{ prompt: "runs in a worktree" }] });

    await executor.execute(integration, context);

    assert.strictEqual(captureCalls.length, 1);
    assert.strictEqual(captureCalls[0].output.workingDirectory, worktreeRoot);
  });

  test("emits finalStep status and output updates to dashboard sink", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    const statusUpdates: Array<{
      status: string | null;
      loopCount: number;
      phase: string | null;
    }> = [];
    const outputUpdates: Array<{ loopIndex: number; output: unknown }> = [];
    const finalStepStatusMessages: Array<{
      loopIndex: number;
      message: string;
      severity: string;
    }> = [];

    const context = makeContext(integration);
    context.onFinalStepStatusMessage = (loopIndex, message, severity) => {
      finalStepStatusMessages.push({ loopIndex, message, severity });
    };
    context.dashboardProvider = {
      updateStepStatus: () => {},
      updateRetryAttempt: () => {},
      updateProgress: () => {},
      updateCliStreamingChunk: () => {},
      updateCliOutput: () => {},
      updateExecutionCompleted: () => {},
      updateFinalStepStatus: (
        status: string | null,
        loopCount: number,
        phase: string | null
      ) => {
        statusUpdates.push({ status, loopCount, phase });
      },
      updateStatusMessage: () => {},
      updateFinalStepOutput: (loopIndex: number, output: unknown) => {
        outputUpdates.push({ loopIndex, output });
      },
      updateFinalStepStreamingChunk: () => {},
      updateFinalStepStreamingEvents: () => {},
    } as any;

    queue.loadPrompts({
      steps: [{ prompt: "queue-1" }],
      finalStep: {
        prompt: "final-observe",
        preCondition: {
          script: `node -e "process.stdout.write('ok')"`,
          compareSource: "stdout",
          returns: "ok",
        },
      },
    });

    await executor.execute(integration, context);

    assert.ok(
      statusUpdates.some(
        (u) =>
          u.phase === FINAL_STEP_PHASES.FINAL_STEP &&
          u.status === STEP_STATUS.RUNNING &&
          u.loopCount === 0
      )
    );
    assert.ok(
      statusUpdates.some(
        (u) =>
          u.phase === FINAL_STEP_PHASES.FINAL_STEP &&
          u.status === STEP_STATUS.COMPLETED &&
          u.loopCount === 0
      )
    );
    assert.ok(outputUpdates.length >= 1);
    assert.ok(outputUpdates.every((u) => u.loopIndex === 0));
    assert.ok(outputUpdates.some((u: any) => u.output?.isStreaming === false));
    assert.ok(
      finalStepStatusMessages.some(
        (status) =>
          status.loopIndex === 0 &&
          status.message.startsWith("Evaluating pre-condition")
      )
    );
  });

  test("forwards runIndex on queue streaming events", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    const streamingUpdates: Array<{
      stepIndex: number;
      attemptIndex?: number;
      runIndex?: number;
    }> = [];

    integration.onSend = async () => {
      (integration as any).streamingEventsEmitter.fire([
        {
          type: "text",
          data: { text: "streaming body" },
        },
      ]);
      return { success: true, responseText: "done" };
    };

    queue.loadPrompts({
      steps: [{ prompt: "queue-rerun" }],
    });

    const context = makeContext(integration);
    context.targetRunIndices = new Map([["queue:0", 2]]);
    context.dashboardProvider = {
      updateStepStatus: () => {},
      updateRetryAttempt: () => {},
      updateProgress: () => {},
      updateCliStreamingChunk: () => {},
      updateCliOutput: () => {},
      updateExecutionCompleted: () => {},
      updateFinalStepStatus: () => {},
      updateFinalStepOutput: () => {},
      updateFinalStepStreamingChunk: () => {},
      updateFinalStepStreamingEvents: () => {},
      updateCliStreamingEvents: (
        stepIndex: number,
        _events: CliEvent[],
        attemptIndex?: number,
        runIndex?: number
      ) => {
        streamingUpdates.push({ stepIndex, attemptIndex, runIndex });
      },
    } as any;

    await executor.execute(integration, context);

    assert.deepStrictEqual(streamingUpdates, [
      { stepIndex: 0, attemptIndex: 0, runIndex: 2 },
    ]);
  });

  test("captures finalStep output using dedicated replay-safe callbacks", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    const initCalls: Array<{ loopIndex: number; attemptIndex: number }> = [];
    const chunkCalls: Array<{ loopIndex: number; chunk: string }> = [];
    const eventCalls: Array<{ loopIndex: number; events: CliEvent[] }> = [];
    const completedCalls: Array<{ loopIndex: number; output: any }> = [];

    integration.onSend = async (prompt) => {
      if (prompt.prompt === "final-capture") {
        (integration as any).streamingChunkEmitter.fire("final-chunk");
        (integration as any).streamingEventsEmitter.fire([
          {
            type: "text",
            timestamp: new Date().toISOString(),
            data: { text: "structured" },
          },
        ]);
      }

      return { success: true, responseText: `ok:${prompt.prompt}` };
    };

    const context = makeContext(integration);
    context.captureFinalStepOutputInit = (
      loopIndex,
      _prompt,
      _cliCommand,
      _cliCommandWasInjected,
      _workingDirectory,
      _timestampMs,
      attemptIndex
    ) => {
      initCalls.push({ loopIndex, attemptIndex });
    };
    context.captureFinalStepChunk = (loopIndex, chunk) => {
      chunkCalls.push({ loopIndex, chunk });
    };
    context.captureFinalStepEvents = (loopIndex, events) => {
      eventCalls.push({ loopIndex, events });
    };
    context.captureFinalStepCompletedOutput = (loopIndex, output) => {
      completedCalls.push({ loopIndex, output });
    };

    queue.loadPrompts({
      steps: [{ prompt: "queue-1" }],
      finalStep: { prompt: "final-capture" },
    });

    await executor.execute(integration, context);

    assert.ok(initCalls.some((c) => c.loopIndex === 0 && c.attemptIndex === 0));
    assert.ok(
      chunkCalls.some((c) => c.loopIndex === 0 && c.chunk === "final-chunk")
    );
    assert.ok(
      eventCalls.some(
        (c) =>
          c.loopIndex === 0 &&
          c.events.some((e) => e.type === CLI_EVENT_TYPES.TEXT)
      )
    );
    assert.strictEqual(completedCalls.length, 1);
    assert.strictEqual(completedCalls[0].loopIndex, 0);
    assert.strictEqual(completedCalls[0].output.prompt, "final-capture");
    assert.strictEqual(completedCalls[0].output.isStreaming, false);
  });

  test("fails the step on process exit by default and persists warning plus PTY tail", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    const captureCalls: Array<{ stepIndex: number; output: any }> = [];
    const statusCalls: Array<{
      stepIndex: number;
      message: string;
      severity: string;
    }> = [];
    const appendedStatusMessages: Array<{
      target: unknown;
      statusMessage: any;
    }> = [];
    const historySaves: Array<{
      target: unknown;
      cliOutputs: any[];
    }> = [];
    const historyCallOrder: string[] = [];

    integration.processExitFailure = true;
    integration.lastFailureOutput = [
      "copilot: starting interactive session",
      "error: unknown option '--poopy'",
    ].join("\n");
    integration.lastCliCommandValue = "copilot --poopy";
    integration.onSend = async () => {
      (integration as any).lastFailureReason =
        "CLI process exited unexpectedly while waiting for SessionStart hook (exit code 0)";
      return { success: false };
    };

    const context = makeContext(integration);
    context.captureCompletedOutput = (stepIndex, output) => {
      captureCalls.push({ stepIndex, output });
    };
    context.onStatusMessage = (stepIndex, message, severity) => {
      statusCalls.push({ stepIndex, message, severity });
    };
    context.historyFilePath = "history.json";
    context.outputHistoryManager = {
      startStreamingExecutionOutput: async () => {
        historyCallOrder.push("start");
      },
      appendStatusMessage: async (
        _historyFilePath: string,
        target: unknown,
        statusMessage: any
      ) => {
        historyCallOrder.push("status");
        appendedStatusMessages.push({ target, statusMessage });
      },
      saveExecutionOutput: async (
        _historyFilePath: string,
        target: unknown,
        cliOutputs: any[]
      ) => {
        historyCallOrder.push("output");
        historySaves.push({ target, cliOutputs });
      },
    } as any;

    queue.loadPrompts({
      steps: [{ prompt: "bad-args" }, { prompt: "next-step" }],
    });

    await executor.execute(integration, context);

    const finalState = queue.getState();
    assert.strictEqual(finalState.status, EXECUTION_STATES.ERROR);
    assert.strictEqual(finalState.currentIndex, 1);
    assert.strictEqual(finalState.results[0].status, STEP_STATUS.FAILED);
    assert.strictEqual(finalState.results[1].status, STEP_STATUS.PENDING);

    assert.strictEqual(statusCalls.length, 1);
    assert.strictEqual(statusCalls[0].stepIndex, 0);
    assert.strictEqual(statusCalls[0].severity, "error");
    assert.match(statusCalls[0].message, /Stopping workflow/);

    assert.strictEqual(captureCalls.length, 1);
    assert.strictEqual(captureCalls[0].stepIndex, 0);
    assert.strictEqual(
      captureCalls[0].output.errorMessage,
      "CLI process exited unexpectedly while waiting for SessionStart hook (exit code 0)"
    );
    assert.match(captureCalls[0].output.response, /unknown option '--poopy'/);
    assert.strictEqual(captureCalls[0].output.rawTextOutput, true);

    assert.strictEqual(historySaves.length, 1);
    assert.strictEqual(appendedStatusMessages.length, 1);
    assert.deepStrictEqual(appendedStatusMessages[0].target, {
      kind: FINAL_STEP_PHASES.QUEUE,
      stepIndex: 0,
    });
    assert.strictEqual(
      appendedStatusMessages[0].statusMessage.severity,
      "error"
    );
    assert.match(
      appendedStatusMessages[0].statusMessage.message,
      /Stopping workflow/
    );
    assert.deepStrictEqual(historyCallOrder, ["start", "status", "output"]);
    assert.deepStrictEqual(historySaves[0].target, {
      kind: FINAL_STEP_PHASES.QUEUE,
      stepIndex: 0,
    });
    assert.strictEqual(historySaves[0].cliOutputs.length, 1);
    assert.match(
      historySaves[0].cliOutputs[0].response,
      /unknown option '--poopy'/
    );
  });

  test("continues to the next step when errorBehavior.onError is continue", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    integration.harnessErrorFailure = true;
    integration.onSend = async (prompt) => {
      if (prompt.prompt === "first-step") {
        (integration as any).lastFailureReason = "Claude StopFailure";
        return { success: false };
      }
      return { success: true, responseText: `ok:${prompt.prompt}` };
    };

    queue.loadPrompts({
      steps: [
        {
          prompt: "first-step",
          errorBehavior: { onError: "continue" },
        },
        { prompt: "second-step" },
      ],
    });

    await executor.execute(integration, makeContext(integration));

    assert.deepStrictEqual(integration.sentPrompts, [
      "first-step",
      "second-step",
    ]);
    assert.strictEqual(queue.getState().status, EXECUTION_STATES.COMPLETED);
    assert.strictEqual(queue.getState().results[0].status, STEP_STATUS.FAILED);
    assert.strictEqual(
      queue.getState().results[1].status,
      STEP_STATUS.COMPLETED
    );
  });

  test("routes errored script steps through errorBehavior", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);

    queue.loadPrompts({
      steps: [
        {
          type: "script",
          script: `node -e "setTimeout(() => {}, 1000)"`,
          timeout: 0.01,
          errorBehavior: { onError: "continue" },
        },
        { prompt: "after-script-error" },
      ],
    });

    await executor.execute(integration, makeContext(integration));

    assert.deepStrictEqual(integration.sentPrompts, ["after-script-error"]);
    assert.strictEqual(queue.getState().status, EXECUTION_STATES.COMPLETED);
    assert.strictEqual(
      queue.getState().results[0].status,
      STEP_STATUS.COMPLETED
    );
  });

  test("retries the same step when errorBehavior.onError is retry", async () => {
    const queue = new PromptQueue();
    const integration = new MockHarnessIntegration(undefined, false);
    const executor = makeExecutor(queue);
    let firstStepAttempts = 0;

    integration.processExitFailure = true;
    integration.onSend = async (prompt) => {
      if (prompt.prompt === "retry-step") {
        firstStepAttempts++;
        if (firstStepAttempts === 1) {
          (integration as any).lastFailureReason =
            "CLI process exited unexpectedly (exit code 1)";
          return { success: false };
        }
        integration.processExitFailure = false;
      }
      return { success: true, responseText: `ok:${prompt.prompt}` };
    };

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-exec-"));
    const marker = path.join(tempDir, "gate-marker.txt");
    const markerCommand = marker.replace(/\\/g, "/");

    queue.loadPrompts({
      steps: [
        {
          prompt: "retry-step",
          preCondition: {
            script: `node -e "require('fs').appendFileSync('${markerCommand}', 'x')"`,
          },
          errorBehavior: { onError: "retry", maxRetries: 1, retryDelayMs: 0 },
        },
        { prompt: "after-retry" },
      ],
    });

    try {
      await executor.execute(integration, makeContext(integration));
    } finally {
      const markerText = await fs.readFile(marker, "utf8");
      assert.strictEqual(
        markerText,
        "xx",
        "a whole-step retry must re-run the pre-condition"
      );
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    assert.deepStrictEqual(integration.sentPrompts, [
      "retry-step",
      "retry-step",
      "after-retry",
    ]);
    assert.strictEqual(queue.getState().status, EXECUTION_STATES.COMPLETED);
    assert.strictEqual(
      queue.getState().results[0].status,
      STEP_STATUS.COMPLETED
    );
    assert.strictEqual(
      queue.getState().results[1].status,
      STEP_STATUS.COMPLETED
    );
  });
});
