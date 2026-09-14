import * as assert from "assert";
import { suite, test } from "mocha";
import { ParallelGroupRun } from "../../core/ParallelGroupRun";
import {
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  HARNESS_IDS,
  PROMPT_TERMINAL_STATUS,
  STEP_CLAIM_OUTCOMES,
} from "../../types/DashboardConstants";
import type {
  ParallelGroupDefinition,
  StepExecutionOutcome,
  WorkflowAttemptTarget,
  WorkflowStep,
} from "../../types/CtrlYokeTypes";
import type { ResolvedProperties } from "../../types/ExecutionPropertyTypes";

interface TestContext {
  readonly abortSignal?: AbortSignal;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function step(stepId: string): WorkflowStep {
  return { prompt: stepId, _runtime: { stepId } };
}

function resolvedProperties(): ResolvedProperties {
  return {
    harness: HARNESS_IDS.COPILOT_CLI,
    model: "test-model",
    executionMode: "headless",
    resumeSession: false,
    mcpServers: [],
    hooks: null,
    toolPermissions: null,
  };
}

function makeRun(options: {
  readonly ids: readonly string[];
  readonly pendingIds?: readonly string[];
  readonly width: number;
  readonly failFast?: boolean;
  readonly execute?: (
    stepId: string,
    target: WorkflowAttemptTarget
  ) => Promise<StepExecutionOutcome>;
  readonly reconcileAndClose?: (
    options: Parameters<
      NonNullable<
        import("../../core/ParallelGroupRun").ParallelGroupRunOptions<TestContext>["reconcileAndClose"]
      >
    >[0]
  ) => Promise<{
    readonly joined: boolean;
    readonly group?: ParallelGroupDefinition;
  }>;
  readonly onCancel?: () => void;
}) {
  const steps = new Map(options.ids.map((id) => [id, step(id)]));
  const indices = new Map(options.ids.map((id, index) => [id, index]));
  const pendingIds = options.pendingIds ?? options.ids;
  const group: ParallelGroupDefinition = {
    id: "group",
    startIndex: 0,
    endIndex: Math.max(1, options.ids.length - 1),
    failFast: options.failFast ?? true,
  };
  let status: string = EXECUTION_STATES.RUNNING;
  let joinCount = 0;
  let stopListener: (() => void) | undefined;

  const run = new ParallelGroupRun<TestContext>({
    group,
    pendingIds,
    effectiveWidth: options.width,
    context: {},
    snapshotStrategy: undefined,
    resolveStepById: (stepId) => {
      const value = steps.get(stepId);
      const stepIndex = indices.get(stepId);
      return value && stepIndex !== undefined
        ? { step: value, stepIndex }
        : undefined;
    },
    claimStepById: async (stepId) => {
      const value = steps.get(stepId);
      const stepIndex = indices.get(stepId);
      if (!value || stepIndex === undefined) {
        return { status: STEP_CLAIM_OUTCOMES.MISSING };
      }
      return {
        status: STEP_CLAIM_OUTCOMES.CLAIMED,
        step: value,
        stepIndex,
      };
    },
    preflightMember: async ({ step: memberStep, stepIndex }) => {
      const properties = resolvedProperties();
      return {
        member: {
          stepIndex,
          step: memberStep,
          resolvedTarget: { properties, sources: {} },
          resolvedProperties: properties,
          variables: {},
        },
        issues: [],
        failureMessage: "preflight failed",
      };
    },
    executeMember: async (target, memberStep) => {
      const stepId =
        "prompt" in memberStep ? memberStep.prompt : memberStep.script;
      return (
        (await options.execute?.(stepId, target)) ?? {
          target,
          status: PROMPT_TERMINAL_STATUS.COMPLETED,
        }
      );
    },
    persistSettlement: async () => undefined,
    cancelTarget: async () => {
      options.onCancel?.();
    },
    getRuntimeStatus: () => status,
    subscribeToStop: (listener) => {
      stopListener = listener;
      return {
        dispose: () => {
          stopListener = undefined;
        },
      };
    },
    getCurrentGroup: () => group,
    commitJoin: async (_joinGroup, outcomes) => {
      joinCount += 1;
      void outcomes;
    },
    reconcileAndClose: options.reconcileAndClose,
  });

  return {
    run,
    get joinCount(): number {
      return joinCount;
    },
    setStatus(nextStatus: string) {
      status = nextStatus;
      if (
        nextStatus === EXECUTION_STATES.CANCELLING ||
        nextStatus === EXECUTION_STATES.STOPPED
      ) {
        stopListener?.();
      }
    },
  };
}

suite("ParallelGroupRun", () => {
  test("drains a member admitted mid-fan-out before joining", async () => {
    const firstStarted = deferred();
    const firstRelease = deferred();
    const lateStarted = deferred();
    const lateRelease = deferred();
    const harness = makeRun({
      ids: ["first", "late"],
      pendingIds: ["first"],
      width: 2,
      execute: async (stepId, target) => {
        if (stepId === "first") {
          firstStarted.resolve();
          await firstRelease.promise;
        } else {
          lateStarted.resolve();
          await lateRelease.promise;
        }
        return { target, status: PROMPT_TERMINAL_STATUS.COMPLETED };
      },
    });

    const completion = harness.run.run();
    await firstStarted.promise;
    assert.strictEqual(harness.run.isAdmissionOpen, true);
    assert.strictEqual(harness.run.admit("first"), false);
    assert.strictEqual(harness.run.admit("late"), true);
    await lateStarted.promise;
    firstRelease.resolve();
    await Promise.resolve();
    assert.strictEqual(harness.joinCount, 0);
    lateRelease.resolve();
    const outcome = await completion;

    assert.strictEqual(harness.joinCount, 1);
    assert.strictEqual(outcome.settledCount, 2);
    assert.deepStrictEqual(
      outcome.outcomes.map((memberOutcome) => memberOutcome.target),
      [
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 },
      ]
    );
  });

  test("queues an admission while saturated and dispatches it after a slot frees", async () => {
    const started = new Map<string, Deferred<void>>();
    const release = new Map<string, Deferred<void>>();
    let lateStarted = false;
    for (const id of ["first", "second", "late"]) {
      started.set(id, deferred());
      release.set(id, deferred());
    }
    const harness = makeRun({
      ids: ["first", "second", "late"],
      pendingIds: ["first", "second"],
      width: 2,
      execute: async (stepId, target) => {
        if (stepId === "late") lateStarted = true;
        started.get(stepId)?.resolve();
        await release.get(stepId)!.promise;
        return { target, status: PROMPT_TERMINAL_STATUS.COMPLETED };
      },
    });

    const completion = harness.run.run();
    await Promise.all([
      started.get("first")!.promise,
      started.get("second")!.promise,
    ]);
    assert.strictEqual(harness.run.admit("late"), true);
    await Promise.resolve();
    assert.strictEqual(lateStarted, false);

    release.get("first")!.resolve();
    await started.get("late")!.promise;
    assert.strictEqual(lateStarted, true);
    release.get("second")!.resolve();
    release.get("late")!.resolve();
    const outcome = await completion;
    assert.strictEqual(outcome.settledCount, 3);
  });

  test("rejects admission after the drain closes", async () => {
    const harness = makeRun({ ids: ["only"], width: 2 });
    await harness.run.run();

    assert.strictEqual(harness.run.isAdmissionOpen, false);
    assert.strictEqual(harness.run.admit("late"), false);
    assert.deepStrictEqual(harness.run.pendingIds, ["only"]);
  });

  test("reconciles surviving members idempotently", async () => {
    const firstStarted = deferred();
    const firstRelease = deferred();
    const harness = makeRun({
      ids: ["first", "late"],
      pendingIds: ["first"],
      width: 1,
      execute: async (stepId, target) => {
        if (stepId === "first") {
          firstStarted.resolve();
          await firstRelease.promise;
        }
        return { target, status: PROMPT_TERMINAL_STATUS.COMPLETED };
      },
    });

    const completion = harness.run.run();
    await firstStarted.promise;

    assert.deepStrictEqual(
      harness.run.reconcileMembers(["first", "late", "late"]),
      ["late"]
    );
    assert.deepStrictEqual(harness.run.reconcileMembers(["late"]), []);

    firstRelease.resolve();
    await completion;
  });

  test("refuses reconciliation after admission closes", async () => {
    const harness = makeRun({ ids: ["only", "late"], width: 1 });
    await harness.run.run();

    assert.deepStrictEqual(harness.run.reconcileMembers(["late"]), []);
  });

  test("returns to draining when the locked close discovers a late member", async () => {
    let closeAttempts = 0;
    const executed: string[] = [];
    const group: ParallelGroupDefinition = {
      id: "group",
      startIndex: 0,
      endIndex: 1,
      failFast: true,
    };
    const harness = makeRun({
      ids: ["first", "late"],
      pendingIds: ["first"],
      width: 1,
      execute: async (stepId, target) => {
        executed.push(stepId);
        return { target, status: PROMPT_TERMINAL_STATUS.COMPLETED };
      },
      reconcileAndClose: ({ reconcileMembers }) => {
        closeAttempts += 1;
        if (closeAttempts === 1) {
          assert.deepStrictEqual(reconcileMembers(["late"]), ["late"]);
          return Promise.resolve({ joined: false, group });
        }
        return Promise.resolve({ joined: true, group });
      },
    });

    const outcome = await harness.run.run();

    assert.deepStrictEqual(executed, ["first", "late"]);
    assert.strictEqual(closeAttempts, 2);
    assert.strictEqual(outcome.settledCount, 2);
  });

  test("rejects admission during stop and settles the group", async () => {
    const started = deferred();
    const release = deferred();
    const harness = makeRun({
      ids: ["running", "late"],
      pendingIds: ["running"],
      width: 2,
      execute: async (_stepId, target) => {
        started.resolve();
        await release.promise;
        return { target, status: PROMPT_TERMINAL_STATUS.COMPLETED };
      },
      onCancel: () => release.resolve(),
    });

    const completion = harness.run.run();
    await started.promise;
    harness.setStatus(EXECUTION_STATES.CANCELLING);
    assert.strictEqual(harness.run.admit("late"), false);
    const outcome = await completion;
    assert.strictEqual(harness.run.isAdmissionOpen, false);
    assert.strictEqual(outcome.stopped, true);
  });

  test("rejects admission during pause and settles the group", async () => {
    const started = deferred();
    const release = deferred();
    const harness = makeRun({
      ids: ["running", "late"],
      pendingIds: ["running"],
      width: 2,
      execute: async (_stepId, target) => {
        started.resolve();
        await release.promise;
        return { target, status: PROMPT_TERMINAL_STATUS.COMPLETED };
      },
    });

    const completion = harness.run.run();
    await started.promise;
    harness.setStatus(EXECUTION_STATES.PAUSING);
    assert.strictEqual(harness.run.admit("late"), false);
    release.resolve();
    const outcome = await completion;
    assert.strictEqual(outcome.paused, true);
    assert.strictEqual(harness.run.isAdmissionOpen, false);
  });

  test("rejects admission after fail-fast and settles the remaining member", async () => {
    const secondStarted = deferred();
    const secondRelease = deferred();
    let rejected = false;
    const harness = makeRun({
      ids: ["failed", "running"],
      width: 2,
      execute: async (stepId, target) => {
        if (stepId === "running") {
          secondStarted.resolve();
          await secondRelease.promise;
        }
        return {
          target,
          status:
            stepId === "failed"
              ? PROMPT_TERMINAL_STATUS.FAILED
              : PROMPT_TERMINAL_STATUS.COMPLETED,
        };
      },
      onCancel: () => {
        rejected = !harness.run.admit("late");
        secondRelease.resolve();
      },
    });

    const completion = harness.run.run();
    await secondStarted.promise;
    const outcome = await completion;
    assert.strictEqual(rejected, true);
    assert.strictEqual(outcome.terminalFailure, true);
    assert.strictEqual(harness.run.isAdmissionOpen, false);
  });

  test("retains the existing behavior when no member is admitted late", async () => {
    const harness = makeRun({ ids: ["first", "second"], width: 2 });
    const outcome = await harness.run.run();

    assert.strictEqual(outcome.paused, false);
    assert.strictEqual(outcome.stopped, false);
    assert.strictEqual(outcome.terminalFailure, false);
    assert.strictEqual(outcome.settledCount, 2);
    assert.strictEqual(harness.run.isAdmissionOpen, false);
  });
});
