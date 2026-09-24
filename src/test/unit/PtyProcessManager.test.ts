import * as assert from "assert";
import { suite, test } from "mocha";
import type { IEvent, IPty } from "node-pty";
import {
  PtyProcessManager,
  PtySession,
  buildTerminalEndedMessage,
  resolveEndedTerminalStatus,
  type PtyDimensionsPersistence,
} from "../../core/harness/PtyProcessManager";
import {
  MESSAGE_TYPES,
  SESSION_KINDS,
  TERMINAL_END_REASONS,
  TERMINAL_SESSION_STATUS,
} from "../../types/DashboardConstants";

suite("PtyProcessManager spawn dimensions", () => {
  test("defaults to 220x50 when no size has been persisted or observed", () => {
    const manager = new PtyProcessManager();
    assert.deepStrictEqual(manager.getSpawnDimensions(), {
      cols: 220,
      rows: 50,
    });
  });

  test("applies a persisted controller size as the spawn size", () => {
    const persistence: PtyDimensionsPersistence = {
      loadDimensions: () => ({ cols: 56, rows: 29 }),
      saveDimensions: () => {},
    };
    const manager = new PtyProcessManager();
    manager.setDimensionsPersistence(persistence);
    assert.deepStrictEqual(manager.getSpawnDimensions(), {
      cols: 56,
      rows: 29,
    });
  });

  test("ignores absent or non-positive persisted dimensions", () => {
    const manager = new PtyProcessManager();
    manager.setDimensionsPersistence({
      loadDimensions: () => undefined,
      saveDimensions: () => {},
    });
    assert.deepStrictEqual(manager.getSpawnDimensions(), {
      cols: 220,
      rows: 50,
    });

    manager.setDimensionsPersistence({
      loadDimensions: () => ({ cols: 0, rows: 0 }),
      saveDimensions: () => {},
    });
    assert.deepStrictEqual(manager.getSpawnDimensions(), {
      cols: 220,
      rows: 50,
    });
  });

  test("setSpawnDimensions updates a client's size and ignores non-positive values", () => {
    const manager = new PtyProcessManager();
    manager.setSpawnDimensions("client-1", 80, 24);
    assert.deepStrictEqual(manager.getSpawnDimensions("client-1"), {
      cols: 80,
      rows: 24,
    });
    // Non-positive dimensions (e.g. a 0×0 collapsed container) are ignored.
    manager.setSpawnDimensions("client-1", 0, 24);
    manager.setSpawnDimensions("client-1", 80, -1);
    assert.deepStrictEqual(manager.getSpawnDimensions("client-1"), {
      cols: 80,
      rows: 24,
    });
  });

  test("keys spawn size by clientId — one client's size never leaks to another", () => {
    const manager = new PtyProcessManager();
    // Thin phone controls workflow A; wide desktop controls workflow B.
    manager.setSpawnDimensions("thin-tab", 40, 20);
    manager.setSpawnDimensions("wide-tab", 200, 50);
    assert.deepStrictEqual(manager.getSpawnDimensions("thin-tab"), {
      cols: 40,
      rows: 20,
    });
    assert.deepStrictEqual(manager.getSpawnDimensions("wide-tab"), {
      cols: 200,
      rows: 50,
    });
    // An unknown/absent client resolves to the cold-start fallback, not another
    // client's size.
    assert.deepStrictEqual(manager.getSpawnDimensions("never-seen"), {
      cols: 200,
      rows: 50, // last-reported fallback
    });
  });

  test("setSpawnDimensions persists the fallback only on an actual change", () => {
    const saved: Array<{ cols: number; rows: number }> = [];
    const manager = new PtyProcessManager();
    manager.setDimensionsPersistence({
      loadDimensions: () => undefined,
      saveDimensions: (dims) => saved.push(dims),
    });
    manager.setSpawnDimensions("c1", 100, 30); // change → persist
    manager.setSpawnDimensions("c1", 100, 30); // no change → no persist
    manager.setSpawnDimensions("c1", 120, 30); // change → persist
    assert.deepStrictEqual(saved, [
      { cols: 100, rows: 30 },
      { cols: 120, rows: 30 },
    ]);
  });
});

suite("PtyProcessManager terminal end status", () => {
  test("a recorded end reason wins over a nonzero exit code", () => {
    assert.strictEqual(
      resolveEndedTerminalStatus(1, TERMINAL_END_REASONS.STOPPED),
      TERMINAL_SESSION_STATUS.STOPPED
    );
    assert.strictEqual(
      resolveEndedTerminalStatus(130, TERMINAL_END_REASONS.WORKTREE_RELEASED),
      TERMINAL_SESSION_STATUS.STOPPED
    );
  });

  test("a timeout kill still resolves to FAILED", () => {
    assert.strictEqual(
      resolveEndedTerminalStatus(1, TERMINAL_END_REASONS.TIMED_OUT),
      TERMINAL_SESSION_STATUS.FAILED
    );
  });

  test("without a reason the exit code decides", () => {
    assert.strictEqual(
      resolveEndedTerminalStatus(0, undefined),
      TERMINAL_SESSION_STATUS.COMPLETED
    );
    assert.strictEqual(
      resolveEndedTerminalStatus(3, undefined),
      TERMINAL_SESSION_STATUS.FAILED
    );
  });

  test("buildTerminalEndedMessage carries status and omits an absent reason", () => {
    const failed = buildTerminalEndedMessage(
      {
        workflowId: "wf",
        id: "sess",
        kind: SESSION_KINDS.AI_CLI,
        status: TERMINAL_SESSION_STATUS.FAILED,
      },
      1
    );
    assert.deepStrictEqual(failed, {
      type: MESSAGE_TYPES.TERMINAL_ENDED,
      workflowId: "wf",
      sessionId: "sess",
      kind: SESSION_KINDS.AI_CLI,
      exitCode: 1,
      status: TERMINAL_SESSION_STATUS.FAILED,
    });
    assert.ok(!("endReason" in failed));

    const stopped = buildTerminalEndedMessage(
      {
        workflowId: "wf",
        id: "sess",
        kind: SESSION_KINDS.AI_CLI,
        status: TERMINAL_SESSION_STATUS.STOPPED,
        endReason: TERMINAL_END_REASONS.STOPPED,
      },
      1
    );
    assert.strictEqual(stopped.endReason, TERMINAL_END_REASONS.STOPPED);
  });
});

/**
 * Stands in for a node-pty process. Like a real CLI, it reports a nonzero
 * exit code when killed or interrupted with Ctrl+C.
 */
class FakePty implements IPty {
  readonly pid = 1;
  readonly cols = 80;
  readonly rows = 24;
  readonly process = "fake";
  handleFlowControl = false;
  readonly written: string[] = [];
  private exitListener?: (e: { exitCode: number }) => void;

  readonly onData: IEvent<string> = () => ({ dispose: () => {} });
  readonly onExit: IEvent<{ exitCode: number; signal?: number }> = (
    listener
  ) => {
    this.exitListener = listener;
    return { dispose: () => {} };
  };

  /** Simulate the process ending, on its own or in response to a signal. */
  exit(exitCode: number): void {
    // A process exits once; later signals reach nothing.
    const listener = this.exitListener;
    this.exitListener = undefined;
    listener?.({ exitCode });
  }

  resize(): void {}
  clear(): void {}
  write(data: string | Buffer): void {
    this.written.push(data.toString());
    // A CLI usually exits on the Ctrl+C itself, before any hard kill.
    if (data === "\x03") this.exit(130);
  }
  kill(): void {
    this.exit(1);
  }
  pause(): void {}
  resume(): void {}
}

class FakePtyProcessManager extends PtyProcessManager {
  readonly ptys: FakePty[] = [];

  protected override loadNodePty(): Pick<typeof import("node-pty"), "spawn"> {
    return {
      spawn: () => {
        const pty = new FakePty();
        this.ptys.push(pty);
        return pty;
      },
    };
  }
}

suite("PtyProcessManager intentional kills", () => {
  function spawn(manager: PtyProcessManager): {
    session: PtySession;
    exits: number[];
  } {
    const exits: number[] = [];
    const session = manager.spawnPty({
      workflowId: "wf-end-reason",
      stepName: "Step 1",
      stepIndex: 0,
      kind: SESSION_KINDS.AI_CLI,
      command: "fake-cli",
      args: [],
      cwd: process.cwd(),
      onData: () => {},
      onExit: (_session, exitCode) => exits.push(exitCode),
    });
    return { session, exits };
  }

  test("killSession ends a live process as STOPPED despite its exit code", () => {
    const manager = new FakePtyProcessManager();
    const { session, exits } = spawn(manager);
    manager.killSession(session.id, TERMINAL_END_REASONS.STOPPED);
    assert.deepStrictEqual(exits, [1]);
    assert.strictEqual(session.status, TERMINAL_SESSION_STATUS.STOPPED);
    assert.strictEqual(session.endReason, TERMINAL_END_REASONS.STOPPED);
  });

  test("a graceful kill is labelled even when the CLI exits on the Ctrl+C", async () => {
    const manager = new FakePtyProcessManager();
    const { session, exits } = spawn(manager);
    await manager.gracefulKillAiCliSession(
      session.id,
      TERMINAL_END_REASONS.WORKTREE_RELEASED
    );
    assert.deepStrictEqual(exits, [130]);
    assert.strictEqual(session.status, TERMINAL_SESSION_STATUS.STOPPED);
    assert.strictEqual(
      session.endReason,
      TERMINAL_END_REASONS.WORKTREE_RELEASED
    );
  });

  test("a timeout kill is still a failure", () => {
    const manager = new FakePtyProcessManager();
    const { session } = spawn(manager);
    manager.killSession(session.id, TERMINAL_END_REASONS.TIMED_OUT);
    assert.strictEqual(session.status, TERMINAL_SESSION_STATUS.FAILED);
  });

  test("a process failing on its own is still FAILED", () => {
    const manager = new FakePtyProcessManager();
    const { session } = spawn(manager);
    manager.ptys[0].exit(3);
    assert.strictEqual(session.status, TERMINAL_SESSION_STATUS.FAILED);
    assert.strictEqual(session.endReason, undefined);
  });

  test("the first recorded reason wins over a later teardown", () => {
    const session = new PtySession(
      "sess",
      "wf",
      "Step 1",
      0,
      SESSION_KINDS.AI_CLI,
      new FakePty()
    );
    session.markEnding(TERMINAL_END_REASONS.STOPPED);
    session.markEnding(TERMINAL_END_REASONS.STEP_COMPLETE);
    assert.strictEqual(session.endReason, TERMINAL_END_REASONS.STOPPED);
  });
});
