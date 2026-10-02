import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import { suite, test } from "mocha";
import {
  EXECUTION_STATES,
  PROMPT_TERMINAL_STATUS,
  RUNNER_IDS,
} from "../../types/DashboardConstants";
import { WorkflowLockManager } from "../../utils/WorkflowLockManager";
import { readWorkflowLock } from "../../utils/WorkflowLockInspector";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";
import * as path from "path";

suite("WorkflowLockManager stale-run recovery", () => {
  test("reads legacy lock objects without requiring schema-v2 identity fields", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-lock-legacy-read-")
    );
    const workflowKey = "legacy-read-2026-01-01T00-00-00" as WorkflowKey;
    try {
      const lockPath = WorkflowLockManager.getLockPath(
        workspaceRoot,
        workflowKey
      );
      const legacyLock = {
        workflowKey,
        runRef: "run-2026-01-01T00-00-00-000Z",
        runner: RUNNER_IDS.VSCODE,
        pid: process.pid,
        ownerToken: "legacy-owner",
        startedAt: Date.now(),
        lastHeartbeat: Date.now(),
      };
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      await fs.writeFile(lockPath, JSON.stringify(legacyLock), "utf8");

      assert.deepStrictEqual(
        await readWorkflowLock(workspaceRoot, workflowKey),
        legacyLock
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("skips a malformed lock and still recovers later stale lineages", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-lock-malformed-")
    );
    const malformedKey = "a-bad" as WorkflowKey;
    const recoverableKey = "b-good" as WorkflowKey;
    const runRef = "run-2026-01-01T00-00-00-000Z" as RunRef;
    const runFilePath = WorkflowPaths.runFilePath(
      workspaceRoot,
      recoverableKey,
      runRef
    );
    const malformedLockPath = WorkflowLockManager.getLockPath(
      workspaceRoot,
      malformedKey
    );

    try {
      await fs.mkdir(path.dirname(malformedLockPath), { recursive: true });
      await fs.writeFile(
        malformedLockPath,
        JSON.stringify({ workflowKey: malformedKey }),
        "utf8"
      );

      await fs.mkdir(path.dirname(runFilePath), { recursive: true });
      await fs.writeFile(
        runFilePath,
        JSON.stringify({
          steps: [{ prompt: "recover this run" }],
          _runtime: { currentIndex: 0, executionState: EXECUTION_STATES.RUNNING },
        }),
        "utf8"
      );
      await fs.writeFile(
        WorkflowLockManager.getLockPath(workspaceRoot, recoverableKey),
        JSON.stringify({
          workflowKey: recoverableKey,
          runRef,
          pid: 999_999,
          lastHeartbeat: 0,
        }),
        "utf8"
      );

      const result = await WorkflowLockManager.normalizeStaleLocks(
        workspaceRoot,
        [malformedKey, recoverableKey]
      );
      const recoveredRun = JSON.parse(await fs.readFile(runFilePath, "utf8")) as {
        _runtime: { executionState: string };
      };

      assert.deepStrictEqual(result.activeRunFiles, []);
      assert.deepStrictEqual(result.recoveredRunFiles, [runFilePath]);
      assert.strictEqual(
        recoveredRun._runtime.executionState,
        EXECUTION_STATES.STOPPED
      );
      assert.deepStrictEqual(
        JSON.parse(await fs.readFile(malformedLockPath, "utf8")),
        { workflowKey: malformedKey }
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("leaves live VS Code-owned runs and locks untouched", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-lock-live-vscode-")
    );
    const cases = [
      EXECUTION_STATES.RUNNING,
      EXECUTION_STATES.PAUSING,
      EXECUTION_STATES.CANCELLING,
    ].map((executionState, index) => ({
      executionState,
      workflowKey: `live-vscode-${index}` as WorkflowKey,
      runRef: `run-2026-01-01T00-00-0${index}-000Z` as RunRef,
    }));

    try {
      const expectedRuntimes = new Map<string, Record<string, unknown>>();
      const expectedLocks = new Map<string, Record<string, unknown>>();

      for (const { executionState, workflowKey, runRef } of cases) {
        const runFilePath = WorkflowPaths.runFilePath(
          workspaceRoot,
          workflowKey,
          runRef
        );
        const runtime = {
          currentIndex: 0,
          executionState,
          sessionId: "session-survives",
          customRuntimeValue: "preserve-me",
        };
        const lock = {
          schemaVersion: 2 as const,
          workflowKey,
          runRef,
          runner: RUNNER_IDS.VSCODE,
          pid: process.pid,
          ownerToken: `live-owner-${executionState}`,
          hostInstanceId: "live-extension-host",
          executionInstanceId: "live-execution",
          startedAt: Date.now(),
          lastHeartbeat: Date.now(),
        };

        await fs.mkdir(path.dirname(runFilePath), { recursive: true });
        await fs.writeFile(
          runFilePath,
          JSON.stringify({
            steps: [{ prompt: "keep this run" }],
            _runtime: runtime,
          }),
          "utf8"
        );
        await fs.writeFile(
          WorkflowLockManager.getLockPath(workspaceRoot, workflowKey),
          JSON.stringify(lock),
          "utf8"
        );
        expectedRuntimes.set(runFilePath, runtime);
        expectedLocks.set(workflowKey, lock);
      }

      const result = await WorkflowLockManager.normalizeStaleLocks(
        workspaceRoot,
        cases.map(({ workflowKey }) => workflowKey)
      );

      assert.deepStrictEqual(result.activeRunFiles, [
        ...expectedRuntimes.keys(),
      ]);
      assert.deepStrictEqual(result.recoveredRunFiles, []);
      for (const { workflowKey, runRef } of cases) {
        const runFilePath = WorkflowPaths.runFilePath(
          workspaceRoot,
          workflowKey,
          runRef
        );
        const unchangedRun = JSON.parse(
          await fs.readFile(runFilePath, "utf8")
        ) as {
          _runtime: Record<string, unknown>;
        };
        assert.deepStrictEqual(
          unchangedRun._runtime,
          expectedRuntimes.get(runFilePath)
        );
        assert.deepStrictEqual(
          JSON.parse(
            await fs.readFile(
              WorkflowLockManager.getLockPath(workspaceRoot, workflowKey),
              "utf8"
            )
          ),
          expectedLocks.get(workflowKey)
        );
      }
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("marks the interrupted step cancelled and removes a stale VS Code lock", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-lock-recovery-")
    );
    const workflowKey = "interrupted-2026-01-01T00-00-00" as WorkflowKey;
    const runRef = "run-2026-01-01T00-00-00-000Z" as RunRef;
    const runFilePath = WorkflowPaths.runFilePath(
      workspaceRoot,
      workflowKey,
      runRef
    );

    try {
      await fs.mkdir(path.dirname(runFilePath), { recursive: true });
      await fs.writeFile(
        runFilePath,
        JSON.stringify({
          steps: [
            {
              prompt: "continue later",
              _runtime: {
                startedAt: 100,
                sessionId: "session-survives",
              },
            },
          ],
          _runtime: {
            currentIndex: 0,
            executionState: EXECUTION_STATES.RUNNING,
          },
        }),
        "utf8"
      );
      // A stale lock: dead PID (impossible on a live system) and a long-expired heartbeat.
      await WorkflowLockManager.acquireLock(workspaceRoot, workflowKey, {
        schemaVersion: 2,
        workflowKey,
        runRef,
        runner: RUNNER_IDS.VSCODE,
        pid: 999_999,
        ownerToken: "old-owner-token",
        hostInstanceId: "old-extension-host",
        executionInstanceId: "old-execution",
        startedAt: 0,
        lastHeartbeat: 0,
      });

      const result = await WorkflowLockManager.normalizeStaleLocks(
        workspaceRoot,
        [workflowKey]
      );
      const recovered = JSON.parse(await fs.readFile(runFilePath, "utf8")) as {
        steps: Array<{
          _runtime: {
            sessionId: string;
            completedAt?: number;
            terminalStatus?: string;
          };
        }>;
        _runtime: { currentIndex: number; executionState: string };
      };

      assert.deepStrictEqual(result.activeRunFiles, []);
      assert.deepStrictEqual(result.recoveredRunFiles, [runFilePath]);
      assert.strictEqual(
        recovered._runtime.executionState,
        EXECUTION_STATES.STOPPED
      );
      assert.strictEqual(recovered._runtime.currentIndex, 1);
      assert.strictEqual(
        recovered.steps[0]._runtime.terminalStatus,
        PROMPT_TERMINAL_STATUS.CANCELLED
      );
      assert.strictEqual(
        typeof recovered.steps[0]._runtime.completedAt,
        "number"
      );
      assert.strictEqual(
        recovered.steps[0]._runtime.sessionId,
        "session-survives"
      );
      await assert.rejects(
        fs.access(WorkflowLockManager.getLockPath(workspaceRoot, workflowKey))
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("keeps a paused run paused and removes its stale lock", async () => {
    // A user pause must survive a host restart: the paused owner exits with its
    // lock still on disk, and startup must not rewrite the run to STOPPED.
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-lock-paused-")
    );
    const workflowKey = "paused-2026-01-01T00-00-00" as WorkflowKey;
    const runRef = "run-2026-01-01T00-00-00-000Z" as RunRef;
    const runFilePath = WorkflowPaths.runFilePath(
      workspaceRoot,
      workflowKey,
      runRef
    );
    const pausedRun = {
      steps: [
        {
          prompt: "done before pause",
          _runtime: { startedAt: 100, completedAt: 200 },
        },
        { prompt: "next after resume" },
      ],
      _runtime: {
        currentIndex: 1,
        executionState: EXECUTION_STATES.PAUSED,
      },
    };

    try {
      await fs.mkdir(path.dirname(runFilePath), { recursive: true });
      await fs.writeFile(runFilePath, JSON.stringify(pausedRun), "utf8");
      await WorkflowLockManager.acquireLock(workspaceRoot, workflowKey, {
        schemaVersion: 2,
        workflowKey,
        runRef,
        runner: RUNNER_IDS.VSCODE,
        pid: 999_999,
        ownerToken: "paused-owner-token",
        hostInstanceId: "old-extension-host",
        executionInstanceId: "old-execution",
        startedAt: 0,
        lastHeartbeat: 0,
      });

      const result = await WorkflowLockManager.normalizeStaleLocks(
        workspaceRoot,
        [workflowKey]
      );

      assert.deepStrictEqual(result.activeRunFiles, []);
      assert.deepStrictEqual(result.recoveredRunFiles, []);
      assert.deepStrictEqual(
        JSON.parse(await fs.readFile(runFilePath, "utf8")),
        pausedRun
      );
      await assert.rejects(
        fs.access(WorkflowLockManager.getLockPath(workspaceRoot, workflowKey))
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("preserves a live active-CLI run and lock", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-lock-live-cli-")
    );
    const workflowKey = "live-cli-2026-01-01T00-00-00" as WorkflowKey;
    const runRef = "run-2026-01-01T00-00-00-000Z" as RunRef;
    const runFilePath = WorkflowPaths.runFilePath(
      workspaceRoot,
      workflowKey,
      runRef
    );
    const runtime = {
      currentIndex: 0,
      executionState: EXECUTION_STATES.RUNNING,
      sessionId: "cli-session-survives",
    };
    const lock = {
      schemaVersion: 2 as const,
      workflowKey,
      runRef,
      runner: RUNNER_IDS.CLI,
      pid: process.pid,
      ownerToken: "live-cli-owner-token",
      hostInstanceId: "cli-process",
      executionInstanceId: "cli-execution",
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
    };

    try {
      await fs.mkdir(path.dirname(runFilePath), { recursive: true });
      await fs.writeFile(
        runFilePath,
        JSON.stringify({
          steps: [{ prompt: "keep this CLI run" }],
          _runtime: runtime,
        }),
        "utf8"
      );
      const lockPath = WorkflowLockManager.getLockPath(
        workspaceRoot,
        workflowKey
      );
      await fs.writeFile(lockPath, JSON.stringify(lock), "utf8");

      const result = await WorkflowLockManager.normalizeStaleLocks(
        workspaceRoot,
        [workflowKey]
      );

      assert.deepStrictEqual(result.activeRunFiles, [runFilePath]);
      assert.deepStrictEqual(result.recoveredRunFiles, []);
      assert.deepStrictEqual(
        JSON.parse(await fs.readFile(runFilePath, "utf8")),
        { steps: [{ prompt: "keep this CLI run" }], _runtime: runtime }
      );
      assert.deepStrictEqual(
        JSON.parse(await fs.readFile(lockPath, "utf8")),
        lock
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

suite("WorkflowLockManager exclusive acquire / ownerToken", () => {
  let workspaceRoot: string;
  const workflowKey = "exclusive-2026-01-01T00-00-00" as WorkflowKey;
  const runRef = "run-2026-01-01T00-00-00-000Z" as RunRef;

  function makeLock(overrides: { pid?: number; ownerToken?: string } = {}) {
    return {
      schemaVersion: 2 as const,
      workflowKey,
      runRef,
      runner: RUNNER_IDS.VSCODE,
      pid: overrides.pid ?? process.pid,
      ownerToken:
        overrides.ownerToken ?? WorkflowLockManager.generateOwnerToken(),
      hostInstanceId: "host-1",
      executionInstanceId: "execution-1",
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
    };
  }

  test("a live, fresh-heartbeat lock cannot be acquired by a second owner", async function () {
    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-lock-exclusive-")
    );
    try {
      const firstLock = makeLock();
      await WorkflowLockManager.acquireLock(
        workspaceRoot,
        workflowKey,
        firstLock
      );

      await assert.rejects(
        WorkflowLockManager.acquireLock(workspaceRoot, workflowKey, makeLock()),
        /Timed out waiting for runner lock/
      );

      const stillOwned = await readWorkflowLock(workspaceRoot, workflowKey);
      assert.strictEqual(stillOwned?.ownerToken, firstLock.ownerToken);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("a release issued while an acquire is spinning hands the lock over", async function () {
    // Regression: `acquireLock` used to hold the `runner.json` file mutex for
    // its entire retry window, so the outgoing owner's `releaseLock` — which
    // takes that same mutex — could not run until the acquire had already
    // thrown. Every legitimate hand-off (a Re-run while the previous run is
    // still tearing down its retained PTY) therefore failed with "held by a
    // live owner", with the release landing milliseconds after the rejection.
    this.timeout(15_000);
    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-lock-handover-")
    );
    try {
      const outgoing = makeLock();
      await WorkflowLockManager.acquireLock(
        workspaceRoot,
        workflowKey,
        outgoing
      );

      const incoming = makeLock();
      const acquire = WorkflowLockManager.acquireLock(
        workspaceRoot,
        workflowKey,
        incoming
      );
      // Well inside the acquire's 5s retry window, and long enough that the
      // spin is definitely under way.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await WorkflowLockManager.releaseLock(
        workspaceRoot,
        workflowKey,
        outgoing.ownerToken
      );

      await acquire;
      const owner = await readWorkflowLock(workspaceRoot, workflowKey);
      assert.strictEqual(owner?.ownerToken, incoming.ownerToken);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("a stale owner cannot heartbeat or release a successor's lock", async () => {
    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-lock-ownertoken-")
    );
    try {
      const staleToken = "stale-owner-token";
      // Seed a stale lock directly (dead pid), then let a successor take it over.
      const staleLockPath = WorkflowLockManager.getLockPath(
        workspaceRoot,
        workflowKey
      );
      await fs.mkdir(path.dirname(staleLockPath), { recursive: true });
      await fs.writeFile(
        staleLockPath,
        JSON.stringify(
          makeLock({ pid: 999_999, ownerToken: staleToken }),
          null,
          2
        ),
        "utf8"
      );

      const successorLock = makeLock();
      await WorkflowLockManager.acquireLock(
        workspaceRoot,
        workflowKey,
        successorLock
      );

      // The stale owner's token can no longer heartbeat or release.
      await WorkflowLockManager.updateHeartbeat(
        workspaceRoot,
        workflowKey,
        staleToken
      );
      const afterStaleHeartbeat = await readWorkflowLock(
        workspaceRoot,
        workflowKey
      );
      assert.strictEqual(
        afterStaleHeartbeat?.ownerToken,
        successorLock.ownerToken
      );
      assert.strictEqual(
        afterStaleHeartbeat?.lastHeartbeat,
        successorLock.lastHeartbeat
      );

      await WorkflowLockManager.releaseLock(
        workspaceRoot,
        workflowKey,
        staleToken
      );
      const stillPresent = await readWorkflowLock(workspaceRoot, workflowKey);
      assert.ok(stillPresent, "successor's lock must survive a stale release");
      assert.strictEqual(stillPresent?.ownerToken, successorLock.ownerToken);

      // The real owner can still release its own lock.
      await WorkflowLockManager.releaseLock(
        workspaceRoot,
        workflowKey,
        successorLock.ownerToken
      );
      await assert.rejects(fs.access(staleLockPath));
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
