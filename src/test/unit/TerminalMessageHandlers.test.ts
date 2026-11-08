import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import type { IEvent, IPty } from "node-pty";
import { suite, teardown, test } from "mocha";
import {
  PtyProcessManager,
  claimTerminalsOnReplay,
  setPtyPostMessage,
} from "../../core/harness/PtyProcessManager";
import {
  MESSAGE_TYPES,
  PANEL_CLIENT_ID,
  SESSION_KINDS,
} from "../../types/DashboardConstants";
import { TerminalMessageHandlers } from "../../ui/TerminalMessageHandlers";
import { createWebviewClientContext } from "../../ui/WebviewClientContext";

class FakePty implements IPty {
  readonly pid = 1;
  readonly cols = 80;
  readonly rows = 24;
  readonly process = "fake";
  handleFlowControl = false;
  readonly onData: IEvent<string> = () => ({ dispose: () => {} });
  readonly onExit: IEvent<{ exitCode: number; signal?: number }> = () => ({
    dispose: () => {},
  });
  resize(): void {}
  clear(): void {}
  write(): void {}
  kill(): void {}
  pause(): void {}
  resume(): void {}
}

class FakePtyProcessManager extends PtyProcessManager {
  protected override loadNodePty(): Pick<typeof import("node-pty"), "spawn"> {
    return { spawn: () => new FakePty() };
  }
}

suite("TerminalMessageHandlers panel reconnect", () => {
  test("replays the shared reconnect buffer on every reconnect", () => {
    const manager = new FakePtyProcessManager();
    const session = manager.spawnPty({
      workflowId: "workflow-1",
      stepName: "Step 1",
      stepIndex: 0,
      kind: SESSION_KINDS.AI_CLI,
      command: "fake-cli",
      args: [],
      cwd: process.cwd(),
      onData: () => {},
      onExit: () => {},
    });
    session.controllerClientId = "panel";
    session.bufferChunk("buffered terminal output");

    const emitted: unknown[] = [];
    const context = createWebviewClientContext("panel", (message) => {
      emitted.push(message);
    });
    const handlers = new TerminalMessageHandlers(
      () => undefined,
      () => manager
    );

    handlers.reconnectPanel(context);
    handlers.reconnectPanel(context);

    const outputMessages = emitted.filter(
      (message): message is { type: string; data: string } =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === MESSAGE_TYPES.TERMINAL_OUTPUT &&
        "data" in message &&
        typeof message.data === "string"
    );
    assert.deepStrictEqual(
      outputMessages.map((message) => message.data),
      ["buffered terminal output", "buffered terminal output"]
    );
    assert.deepStrictEqual(session.reconnectBuffer, [
      "buffered terminal output",
    ]);
  });
});

suite("TerminalMessageHandlers shell spawn cwd", () => {
  teardown(() => setPtyPostMessage(() => {}));

  test("starts the shell where the host resolver says, ignoring a client cwd", () => {
    const manager = new FakePtyProcessManager();
    const worktreeRoot = os.tmpdir();
    const resolvedFor: string[] = [];
    const handlers = new TerminalMessageHandlers(
      () => undefined,
      () => manager,
      (workflowId) => {
        resolvedFor.push(workflowId);
        return worktreeRoot;
      }
    );

    handlers.handleSpawnShell(
      createWebviewClientContext("panel", () => {}),
      {
        workflowId: "workflow-1",
        cwd: path.join(worktreeRoot, "client-chosen"),
      }
    );

    const [session] = manager.getAllSessions();
    assert.deepStrictEqual(resolvedFor, ["workflow-1"]);
    assert.strictEqual(
      path.resolve(session.cwd ?? "").toLowerCase(),
      path.resolve(worktreeRoot).toLowerCase()
    );
  });
});

suite("TerminalMessageHandlers controller hand-back on reconnect", () => {
  const WORKFLOW_ID = "workflow-1";
  const PHONE = "browser-phone";

  interface ControllerChange {
    sessionId: string;
    controllerClientId: string | undefined;
  }

  function createHarness() {
    const manager = new FakePtyProcessManager();
    const handlers = new TerminalMessageHandlers(
      () => undefined,
      () => manager
    );
    const changes: ControllerChange[] = [];
    setPtyPostMessage((message) => {
      const msg = message as {
        type?: string;
        sessionId: string;
        controllerClientId?: string;
      };
      if (msg.type === MESSAGE_TYPES.TERMINAL_CONTROLLER_CHANGED) {
        changes.push({
          sessionId: msg.sessionId,
          controllerClientId: msg.controllerClientId,
        });
      }
    });
    const spawn = (stepIndex: number) =>
      manager.spawnPty({
        workflowId: WORKFLOW_ID,
        stepName: `Step ${stepIndex + 1}`,
        stepIndex,
        kind: SESSION_KINDS.AI_CLI,
        command: "fake-cli",
        args: [],
        cwd: process.cwd(),
        onData: () => {},
        onExit: () => {},
      });
    const ctx = (clientId: string) =>
      createWebviewClientContext(clientId, () => {});
    const claim = (clientId: string, sessionId: string) =>
      handlers.handleClaimControl(ctx(clientId), {
        workflowId: WORKFLOW_ID,
        sessionId,
      });
    const input = (clientId: string, sessionId: string, data: string) =>
      handlers.handleInput(ctx(clientId), { sessionId, data });
    /** The phone's PWA closes; the panel auto-claims the empty slot. */
    const phoneLeavesAndPanelAutoClaims = (sessionId: string) => {
      manager.releaseControllerForClient(PHONE);
      claim(PANEL_CLIENT_ID, sessionId);
    };
    /** The phone reopens and its workflow view replays the terminals. */
    const phoneReturns = () =>
      claimTerminalsOnReplay(manager, WORKFLOW_ID, PHONE);
    return {
      manager,
      changes,
      spawn,
      claim,
      input,
      phoneLeavesAndPanelAutoClaims,
      phoneReturns,
    };
  }

  teardown(() => setPtyPostMessage(() => {}));

  test("hands control back to the phone when the panel only auto-claimed it", () => {
    const h = createHarness();
    const session = h.spawn(0);
    h.manager.assignController(session.id, PHONE);

    h.phoneLeavesAndPanelAutoClaims(session.id);
    assert.strictEqual(session.controllerClientId, PANEL_CLIENT_ID);

    h.changes.length = 0;
    h.phoneReturns();
    assert.strictEqual(session.controllerClientId, PHONE);
    assert.deepStrictEqual(h.changes, [
      { sessionId: session.id, controllerClientId: PHONE },
    ]);
    assert.strictEqual(h.manager.getExpectedController(WORKFLOW_ID), PHONE);
  });

  test("hands back later steps the panel inherited while the phone was away", () => {
    const h = createHarness();
    const step1 = h.spawn(0);
    h.manager.assignController(step1.id, PHONE);
    h.phoneLeavesAndPanelAutoClaims(step1.id);

    const step2 = h.spawn(1);
    assert.strictEqual(step2.controllerClientId, PANEL_CLIENT_ID);

    h.phoneReturns();
    assert.strictEqual(step1.controllerClientId, PHONE);
    assert.strictEqual(step2.controllerClientId, PHONE);
  });

  test("keeps control with the panel once someone types in it", () => {
    const h = createHarness();
    const session = h.spawn(0);
    h.manager.assignController(session.id, PHONE);
    h.phoneLeavesAndPanelAutoClaims(session.id);

    h.input(PANEL_CLIENT_ID, session.id, "y\r");
    h.phoneReturns();
    assert.strictEqual(session.controllerClientId, PANEL_CLIENT_ID);
  });

  test("ignores xterm's automatic replies and focus reports as panel activity", () => {
    const h = createHarness();
    const session = h.spawn(0);
    h.manager.assignController(session.id, PHONE);
    h.phoneLeavesAndPanelAutoClaims(session.id);

    h.input(PANEL_CLIENT_ID, session.id, "\x1b[12;40R\x1b[?62;22c");
    h.input(PANEL_CLIENT_ID, session.id, "\x1b]11;rgb:1e1e/1e1e/1e1e\x07");
    h.input(PANEL_CLIENT_ID, session.id, "\x1b[O");
    h.phoneReturns();
    assert.strictEqual(session.controllerClientId, PHONE);
  });

  test("keeps control with whoever deliberately took it from another client", () => {
    const h = createHarness();
    const session = h.spawn(0);
    h.manager.assignController(session.id, PHONE);
    h.manager.releaseControllerForClient(PHONE);
    // Another browser tab auto-claims first; the panel then presses Take Control.
    h.claim("browser-laptop", session.id);
    h.claim(PANEL_CLIENT_ID, session.id);

    h.phoneReturns();
    assert.strictEqual(session.controllerClientId, PANEL_CLIENT_ID);
  });

  test("a new run drops the pending hand-back", () => {
    const h = createHarness();
    const session = h.spawn(0);
    h.manager.assignController(session.id, PHONE);
    h.phoneLeavesAndPanelAutoClaims(session.id);

    h.manager.setPendingController(WORKFLOW_ID, PANEL_CLIENT_ID);
    h.phoneReturns();
    assert.strictEqual(session.controllerClientId, PANEL_CLIENT_ID);
  });

  test("does not take control from the panel for a client that never had it", () => {
    const h = createHarness();
    const session = h.spawn(0);
    h.manager.assignController(session.id, PANEL_CLIENT_ID);

    h.changes.length = 0;
    h.phoneReturns();
    assert.strictEqual(session.controllerClientId, PANEL_CLIENT_ID);
    assert.deepStrictEqual(h.changes, []);
  });

  test("hands back only once", () => {
    const h = createHarness();
    const session = h.spawn(0);
    h.manager.assignController(session.id, PHONE);
    h.phoneLeavesAndPanelAutoClaims(session.id);
    h.phoneReturns();

    // The panel takes control deliberately; the phone's next view must not undo it.
    h.claim(PANEL_CLIENT_ID, session.id);
    h.phoneReturns();
    assert.strictEqual(session.controllerClientId, PANEL_CLIENT_ID);
  });
});
