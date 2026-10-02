import * as assert from "assert";
import type { IEvent, IPty } from "node-pty";
import { suite, test } from "mocha";
import { PtyProcessManager } from "../../core/harness/PtyProcessManager";
import { MESSAGE_TYPES, SESSION_KINDS } from "../../types/DashboardConstants";
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
