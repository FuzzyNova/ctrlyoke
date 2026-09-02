import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, setup, teardown, test } from "mocha";
import {
  EXTERNAL_EXECUTION_REASONS,
  EXTERNAL_EXECUTION_RESOLUTION_KINDS,
  EXECUTION_STATES,
  RUNNER_IDS,
  WORKFLOW_LOCK_LIVENESS,
  WORKFLOW_LOCK_LOCALITIES,
  type WorkflowLockLiveness,
  type WorkflowLockLocality,
  type ExecutionState,
} from "../../types/DashboardConstants";
import type {
  RunRef,
  RunnerHostIdentity,
  WorkflowKey,
  WorkflowRunnerLock,
  WorkingFile,
} from "../../types/CtrlYokeTypes";
import {
  ExternalExecutionResolver,
  type ExternalExecutionResolution,
  type ExternalExecutionDecisionLog,
  type ExternalExecutionResolverOptions,
} from "../../core/orchestration/ExternalExecutionResolver";
import { inspectWorkflowLockOwnership } from "../../utils/WorkflowLockInspector";

const NOW = 100_000;
const WORKFLOW_KEY = "resolver-fixture-2026-08-28T00-00-00-000Z" as WorkflowKey;
const MATCHING_RUN_REF = "run-2026-08-28T00-00-00-000Z" as RunRef;
const DIFFERENT_RUN_REF = "run-2026-08-28T00-00-00-001Z" as RunRef;

type LockLiveness = WorkflowLockLiveness;
type Locality = WorkflowLockLocality;

let fixtureRoot: string;

function makeObserver(): RunnerHostIdentity {
  return {
    runner: RUNNER_IDS.VSCODE,
    hostInstanceId: "observer-host",
    pid: 101,
  };
}

function makeWorkingFile(executionState?: ExecutionState): WorkingFile {
  return {
    workflowName: "Resolver fixture",
    startedAt: NOW - 1_000,
    definitionRevision: 1,
    steps: [{ prompt: "fixture" }],
    ...(executionState
      ? { _runtime: { currentIndex: 0, executionState } }
      : {}),
  };
}

function makeLock(
  locality: Locality,
  runRef: RunRef = MATCHING_RUN_REF,
  ownerToken = "owner-token"
): WorkflowRunnerLock {
  return {
    schemaVersion: 2,
    workflowKey: WORKFLOW_KEY,
    runRef,
    runner: RUNNER_IDS.CLI,
    pid: locality === WORKFLOW_LOCK_LOCALITIES.SELF ? 101 : 202,
    hostInstanceId:
      locality === WORKFLOW_LOCK_LOCALITIES.SELF
        ? "observer-host"
        : locality === WORKFLOW_LOCK_LOCALITIES.EXTERNAL
          ? "external-host"
          : "observer-host",
    executionInstanceId: "execution-id",
    ownerToken,
    startedAt: NOW - 1_000,
    lastHeartbeat: NOW,
  };
}

function getWorkingFilePath(runRef: RunRef = MATCHING_RUN_REF): string {
  return path.join(fixtureRoot, WORKFLOW_KEY, runRef, "workflow.ctrlyoke.json");
}

function injectLockInspection(
  lockFactory: () => unknown
): NonNullable<ExternalExecutionResolverOptions["inspectLock"]> {
  return async (_workspaceRoot, _workflowKey, observer, options) =>
    inspectWorkflowLockOwnership(lockFactory(), observer, options);
}

async function writeWorkingFile(
  runRef: RunRef,
  executionState?: ExecutionState
): Promise<string> {
  const workingFilePath = getWorkingFilePath(runRef);
  await fs.mkdir(path.dirname(workingFilePath), { recursive: true });
  await fs.writeFile(
    workingFilePath,
    JSON.stringify(makeWorkingFile(executionState)),
    "utf8"
  );
  return workingFilePath;
}

function expectedResolutionKind(
  executionState: ExecutionState | undefined,
  lockLiveness: LockLiveness,
  locality: Locality,
  addressMatches: boolean,
  acquisitionStable: boolean
): ExternalExecutionResolution["kind"] {
  return executionState !== undefined &&
    executionState !== EXECUTION_STATES.COMPLETED &&
    lockLiveness === WORKFLOW_LOCK_LIVENESS.ACTIVE &&
    locality === WORKFLOW_LOCK_LOCALITIES.EXTERNAL &&
    addressMatches &&
    acquisitionStable
    ? EXTERNAL_EXECUTION_RESOLUTION_KINDS.EXTERNAL_ACTIVE_RUN
    : EXTERNAL_EXECUTION_RESOLUTION_KINDS.NOT_EXTERNAL;
}

suite("ExternalExecutionResolver", () => {
  setup(async () => {
    fixtureRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-resolver-")
    );
  });

  teardown(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  test("only the complete resolver matrix intersection is external", async () => {
    const persistedStates: Array<ExecutionState | undefined> = [
      EXECUTION_STATES.RUNNING,
      EXECUTION_STATES.COMPLETED,
      undefined,
    ];
    const lockLivenesses: LockLiveness[] = Object.values(
      WORKFLOW_LOCK_LIVENESS
    );
    const localities: Locality[] = Object.values(WORKFLOW_LOCK_LOCALITIES);
    const addressMatches = [true, false];
    const acquisitionStability = [true, false];

    for (const executionState of persistedStates) {
      for (const lockLiveness of lockLivenesses) {
        for (const locality of localities) {
          for (const addressMatchesCase of addressMatches) {
            for (const acquisitionStable of acquisitionStability) {
              const workingFilePath = await writeWorkingFile(
                MATCHING_RUN_REF,
                executionState
              );
              const firstLock =
                lockLiveness === WORKFLOW_LOCK_LIVENESS.ABSENT
                  ? null
                  : makeLock(
                      locality,
                      addressMatchesCase ? MATCHING_RUN_REF : DIFFERENT_RUN_REF
                    );
              if (lockLiveness === WORKFLOW_LOCK_LIVENESS.STALE && firstLock) {
                firstLock.lastHeartbeat = NOW - 30_001;
              }
              const secondLock =
                acquisitionStable || !firstLock
                  ? firstLock
                  : makeLock(
                      locality,
                      addressMatchesCase ? MATCHING_RUN_REF : DIFFERENT_RUN_REF,
                      "replacement-owner"
                    );
              let reads = 0;
              const resolution = await new ExternalExecutionResolver(
                fixtureRoot,
                makeObserver(),
                {
                  now: () => NOW,
                  isProcessAlive: (pid) => pid !== 999,
                  onDecision: () => undefined,
                  inspectLock: injectLockInspection(() =>
                    reads++ === 0 ? firstLock : secondLock
                  ),
                }
              ).resolve(workingFilePath);

              assert.strictEqual(
                resolution.kind,
                expectedResolutionKind(
                  executionState,
                  lockLiveness,
                  locality,
                  addressMatchesCase,
                  acquisitionStable
                ),
                `${executionState ?? "missing"}/${lockLiveness}/${locality}/${addressMatchesCase ? "matching" : "different"}/${acquisitionStable ? "stable" : "replaced"}`
              );
            }
          }
        }
      }
    }
  });

  test("terminal state wins over a retained active external lock", async () => {
    const workingFilePath = await writeWorkingFile(
      MATCHING_RUN_REF,
      EXECUTION_STATES.COMPLETED
    );
    const resolution = await new ExternalExecutionResolver(
      fixtureRoot,
      makeObserver(),
      {
        now: () => NOW,
        isProcessAlive: () => true,
        onDecision: () => undefined,
        inspectLock: injectLockInspection(() =>
          makeLock(WORKFLOW_LOCK_LOCALITIES.EXTERNAL)
        ),
      }
    ).resolve(workingFilePath);

    assert.deepStrictEqual(resolution, {
      kind: EXTERNAL_EXECUTION_RESOLUTION_KINDS.NOT_EXTERNAL,
      reason: EXTERNAL_EXECUTION_REASONS.TERMINAL_RUN,
    });
  });

  test("rejects a lock that names a different RunRef", async () => {
    const workingFilePath = await writeWorkingFile(
      MATCHING_RUN_REF,
      EXECUTION_STATES.RUNNING
    );
    const resolution = await new ExternalExecutionResolver(
      fixtureRoot,
      makeObserver(),
      {
        now: () => NOW,
        isProcessAlive: () => true,
        onDecision: () => undefined,
        inspectLock: injectLockInspection(() =>
          makeLock(WORKFLOW_LOCK_LOCALITIES.EXTERNAL, DIFFERENT_RUN_REF)
        ),
      }
    ).resolve(workingFilePath);

    assert.deepStrictEqual(resolution, {
      kind: EXTERNAL_EXECUTION_RESOLUTION_KINDS.NOT_EXTERNAL,
      reason: EXTERNAL_EXECUTION_REASONS.RUN_REF_MISMATCH,
    });
  });

  test("rejects owner replacement during resolution", async () => {
    const workingFilePath = await writeWorkingFile(
      MATCHING_RUN_REF,
      EXECUTION_STATES.RUNNING
    );
    let reads = 0;
    const resolution = await new ExternalExecutionResolver(
      fixtureRoot,
      makeObserver(),
      {
        now: () => NOW,
        isProcessAlive: () => true,
        onDecision: () => undefined,
        inspectLock: injectLockInspection(() =>
          reads++ === 0
            ? makeLock(
                WORKFLOW_LOCK_LOCALITIES.EXTERNAL,
                MATCHING_RUN_REF,
                "first-owner"
              )
            : makeLock(
                WORKFLOW_LOCK_LOCALITIES.EXTERNAL,
                MATCHING_RUN_REF,
                "replacement-owner"
              )
        ),
      }
    ).resolve(workingFilePath);

    assert.deepStrictEqual(resolution, {
      kind: EXTERNAL_EXECUTION_RESOLUTION_KINDS.NOT_EXTERNAL,
      reason: EXTERNAL_EXECUTION_REASONS.NO_ACTIVE_LOCK,
    });
  });

  test("rejects a self-owned lock", async () => {
    const workingFilePath = await writeWorkingFile(
      MATCHING_RUN_REF,
      EXECUTION_STATES.RUNNING
    );
    const resolution = await new ExternalExecutionResolver(
      fixtureRoot,
      makeObserver(),
      {
        now: () => NOW,
        isProcessAlive: () => true,
        onDecision: () => undefined,
        inspectLock: injectLockInspection(() =>
          makeLock(WORKFLOW_LOCK_LOCALITIES.SELF)
        ),
      }
    ).resolve(workingFilePath);

    assert.deepStrictEqual(resolution, {
      kind: EXTERNAL_EXECUTION_RESOLUTION_KINDS.NOT_EXTERNAL,
      reason: EXTERNAL_EXECUTION_REASONS.SELF_OWNED,
    });
  });

  test("returns unreadable-working-file for malformed working-file JSON", async () => {
    const workingFilePath = getWorkingFilePath();
    await fs.mkdir(path.dirname(workingFilePath), { recursive: true });
    await fs.writeFile(workingFilePath, "{not-json", "utf8");

    const resolution = await new ExternalExecutionResolver(
      fixtureRoot,
      makeObserver(),
      { onDecision: () => undefined }
    ).resolve(workingFilePath);

    assert.deepStrictEqual(resolution, {
      kind: EXTERNAL_EXECUTION_RESOLUTION_KINDS.NOT_EXTERNAL,
      reason: EXTERNAL_EXECUTION_REASONS.UNREADABLE_WORKING_FILE,
    });
  });

  test("returns the second inspection as the stable owner-token proof", async () => {
    const workingFilePath = await writeWorkingFile(
      MATCHING_RUN_REF,
      EXECUTION_STATES.RUNNING
    );
    const lock = makeLock(
      WORKFLOW_LOCK_LOCALITIES.EXTERNAL,
      MATCHING_RUN_REF,
      "stable-owner"
    );
    let decision: ExternalExecutionDecisionLog | undefined;
    const resolution = await new ExternalExecutionResolver(
      fixtureRoot,
      makeObserver(),
      {
        now: () => NOW,
        isProcessAlive: () => true,
        onDecision: (value) => {
          decision = value;
        },
        inspectLock: injectLockInspection(() => ({ ...lock })),
      }
    ).resolve(workingFilePath);

    assert.strictEqual(
      resolution.kind,
      EXTERNAL_EXECUTION_RESOLUTION_KINDS.EXTERNAL_ACTIVE_RUN
    );
    if (
      resolution.kind ===
      EXTERNAL_EXECUTION_RESOLUTION_KINDS.EXTERNAL_ACTIVE_RUN
    ) {
      assert.strictEqual(resolution.inspection.lock.ownerToken, "stable-owner");
      assert.strictEqual(resolution.inspection.lock.runRef, MATCHING_RUN_REF);
    }
    assert.strictEqual(decision?.externalWatchEligible, true);
    assert.strictEqual(decision ? "ownerToken" in decision : false, false);
  });
});
