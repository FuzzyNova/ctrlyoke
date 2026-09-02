import * as assert from "assert";
import { suite, test } from "mocha";
import {
  RUNNER_IDS,
  WORKFLOW_LOCK_LIVENESS,
  WORKFLOW_LOCK_LOCALITIES,
  type RunnerId,
  type WorkflowLockLocality,
} from "../../types/DashboardConstants";
import type {
  RunRef,
  RunnerHostIdentity,
  WorkflowKey,
  WorkflowRunnerLock,
} from "../../types/CtrlYokeTypes";
import {
  inspectWorkflowLockOwnership,
  isActiveLock,
  isExternalOwnedLock,
  isSelfOwnedLock,
  type WorkflowLockInspection,
} from "../../utils/WorkflowLockInspector";

const NOW = 100_000;

interface LockCase {
  name: string;
  lock: unknown;
  observer: RunnerHostIdentity;
  expected: {
    liveness: WorkflowLockInspection["liveness"];
    locality?: WorkflowLockLocality;
    diagnostic?: boolean;
  };
}

function makeObserver(
  runner: RunnerId = RUNNER_IDS.VSCODE,
  overrides: Partial<RunnerHostIdentity> = {}
): RunnerHostIdentity {
  return {
    runner,
    hostInstanceId: "observer-host",
    pid: 101,
    ...overrides,
  };
}

function makeLock(
  overrides: Partial<WorkflowRunnerLock> = {}
): WorkflowRunnerLock {
  return {
    schemaVersion: 2,
    workflowKey: "workflow-key" as WorkflowKey,
    runRef: "run-2026-08-28T00-00-00-000Z" as RunRef,
    runner: RUNNER_IDS.VSCODE,
    pid: 101,
    hostInstanceId: "observer-host",
    executionInstanceId: "execution-id",
    ownerToken: "owner-token",
    startedAt: NOW - 1_000,
    lastHeartbeat: NOW,
    ...overrides,
  };
}

function inspect(
  lock: unknown,
  observer: RunnerHostIdentity,
  onIdentityDiagnostic?: () => void
) {
  return inspectWorkflowLockOwnership(lock, observer, {
    now: () => NOW,
    isProcessAlive: (pid) => pid !== 999,
    onIdentityDiagnostic,
  });
}

suite("WorkflowLockInspector ownership classification", () => {
  const cases: LockCase[] = [
    {
      name: "no file",
      lock: null,
      observer: makeObserver(),
      expected: { liveness: WORKFLOW_LOCK_LIVENESS.ABSENT },
    },
    {
      name: "unreadable or invalid file",
      lock: { not: "a runner lock" },
      observer: makeObserver(),
      expected: { liveness: WORKFLOW_LOCK_LIVENESS.ABSENT },
    },
    {
      name: "dead PID",
      lock: makeLock({ pid: 999 }),
      observer: makeObserver(),
      expected: { liveness: WORKFLOW_LOCK_LIVENESS.STALE },
    },
    {
      name: "expired heartbeat",
      lock: makeLock({ lastHeartbeat: NOW - 30_001 }),
      observer: makeObserver(),
      expected: { liveness: WORKFLOW_LOCK_LIVENESS.STALE },
    },
    {
      name: "same VS Code host and PID",
      lock: makeLock({ runner: RUNNER_IDS.VSCODE }),
      observer: makeObserver(RUNNER_IDS.VSCODE),
      expected: {
        liveness: WORKFLOW_LOCK_LIVENESS.ACTIVE,
        locality: WORKFLOW_LOCK_LOCALITIES.SELF,
      },
    },
    {
      name: "same CLI host and PID",
      lock: makeLock({ runner: RUNNER_IDS.CLI }),
      observer: makeObserver(RUNNER_IDS.CLI),
      expected: {
        liveness: WORKFLOW_LOCK_LIVENESS.ACTIVE,
        locality: WORKFLOW_LOCK_LOCALITIES.SELF,
      },
    },
    {
      name: "different live VS Code host and PID",
      lock: makeLock({
        runner: RUNNER_IDS.VSCODE,
        hostInstanceId: "sibling-vscode-host",
        pid: 202,
      }),
      observer: makeObserver(RUNNER_IDS.VSCODE),
      expected: {
        liveness: WORKFLOW_LOCK_LIVENESS.ACTIVE,
        locality: WORKFLOW_LOCK_LOCALITIES.EXTERNAL,
      },
    },
    {
      name: "CLI lock observed by VS Code",
      lock: makeLock({
        runner: RUNNER_IDS.CLI,
        hostInstanceId: "cli-host",
        pid: 202,
      }),
      observer: makeObserver(RUNNER_IDS.VSCODE),
      expected: {
        liveness: WORKFLOW_LOCK_LIVENESS.ACTIVE,
        locality: WORKFLOW_LOCK_LOCALITIES.EXTERNAL,
      },
    },
    {
      name: "VS Code lock observed by CLI",
      lock: makeLock({
        runner: RUNNER_IDS.VSCODE,
        hostInstanceId: "vscode-host",
        pid: 202,
      }),
      observer: makeObserver(RUNNER_IDS.CLI),
      expected: {
        liveness: WORKFLOW_LOCK_LIVENESS.ACTIVE,
        locality: WORKFLOW_LOCK_LOCALITIES.EXTERNAL,
      },
    },
    {
      name: "same host ID with a contradictory PID",
      lock: makeLock({ pid: 202 }),
      observer: makeObserver(),
      expected: {
        liveness: WORKFLOW_LOCK_LIVENESS.ACTIVE,
        locality: WORKFLOW_LOCK_LOCALITIES.INDETERMINATE,
        diagnostic: true,
      },
    },
    {
      name: "different host IDs with the same PID",
      lock: makeLock({ hostInstanceId: "other-host" }),
      observer: makeObserver(),
      expected: {
        liveness: WORKFLOW_LOCK_LIVENESS.ACTIVE,
        locality: WORKFLOW_LOCK_LOCALITIES.INDETERMINATE,
        diagnostic: true,
      },
    },
    {
      name: "legacy lock with observer PID",
      lock: makeLock({
        hostInstanceId: undefined,
        executionInstanceId: undefined,
      }),
      observer: makeObserver(),
      expected: {
        liveness: WORKFLOW_LOCK_LIVENESS.ACTIVE,
        locality: WORKFLOW_LOCK_LOCALITIES.SELF,
      },
    },
    {
      name: "legacy live lock with a different PID",
      lock: makeLock({
        hostInstanceId: undefined,
        executionInstanceId: undefined,
        pid: 202,
      }),
      observer: makeObserver(),
      expected: {
        liveness: WORKFLOW_LOCK_LIVENESS.ACTIVE,
        locality: WORKFLOW_LOCK_LOCALITIES.INDETERMINATE,
        diagnostic: true,
      },
    },
  ];

  for (const lockCase of cases) {
    test(lockCase.name, () => {
      let diagnosticCount = 0;
      const result = inspect(
        lockCase.lock,
        lockCase.observer,
        () => diagnosticCount++
      );

      assert.strictEqual(result.liveness, lockCase.expected.liveness);
      if (result.liveness === WORKFLOW_LOCK_LIVENESS.ACTIVE) {
        assert.strictEqual(result.locality, lockCase.expected.locality);
      }
      assert.strictEqual(
        diagnosticCount > 0,
        lockCase.expected.diagnostic ?? false
      );
    });
  }

  test("type guards identify active locality without policy flags", () => {
    const self = inspect(makeLock(), makeObserver());
    const external = inspect(
      makeLock({ hostInstanceId: "other-host", pid: 202 }),
      makeObserver()
    );
    const stale = inspect(makeLock({ pid: 999 }), makeObserver());

    assert.ok(isActiveLock(self));
    assert.ok(isSelfOwnedLock(self));
    assert.ok(!isExternalOwnedLock(self));
    assert.ok(isActiveLock(external));
    assert.ok(isExternalOwnedLock(external));
    assert.ok(!isSelfOwnedLock(external));
    assert.ok(!isActiveLock(stale));
  });

  test("a replacement owner token rejects the old inspection proof", () => {
    const observer = makeObserver();
    const firstLock = makeLock({ ownerToken: "first-owner" });
    const replacementLock = makeLock({ ownerToken: "replacement-owner" });
    const firstInspection = inspect(firstLock, observer);
    const replacementInspection = inspect(replacementLock, observer);

    assert.ok(isSelfOwnedLock(firstInspection));
    assert.ok(isSelfOwnedLock(replacementInspection));
    assert.notStrictEqual(
      firstInspection.lock.ownerToken,
      replacementInspection.lock.ownerToken
    );
    assert.strictEqual(
      replacementInspection.lock.ownerToken,
      replacementLock.ownerToken
    );
  });
});
