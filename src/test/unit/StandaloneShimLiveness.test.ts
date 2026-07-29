import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { suite, test } from "mocha";
import { renderHostedStandaloneShimScript } from "../../server/HostedStandaloneShimScript";
import { MESSAGE_TYPES } from "../../types/DashboardConstants";

type TimerCallback = () => void;
type WebSocketEventListener = Parameters<WebSocket["addEventListener"]>[1];
type WebSocketEventListenerOptions = Parameters<
  WebSocket["addEventListener"]
>[2];

class FakeClock {
  now = 10_000;
  private nextId = 1;
  private readonly timers = new Map<
    number,
    { callback: TimerCallback; at: number; intervalMs?: number }
  >();

  setTimeout(callback: TimerCallback, delayMs = 0): number {
    return this.addTimer(callback, delayMs);
  }

  setInterval(callback: TimerCallback, intervalMs = 0): number {
    return this.addTimer(callback, intervalMs, intervalMs);
  }

  clearTimer(id: number): void {
    this.timers.delete(id);
  }

  advance(ms: number): void {
    const target = this.now + ms;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) break;

      const [id, timer] = next;
      this.now = timer.at;
      if (timer.intervalMs === undefined) {
        this.timers.delete(id);
      } else {
        timer.at += timer.intervalMs;
      }
      timer.callback();
    }
    this.now = target;
  }

  private addTimer(
    callback: TimerCallback,
    delayMs: number,
    intervalMs?: number
  ): number {
    const id = this.nextId++;
    this.timers.set(id, {
      callback,
      at: this.now + delayMs,
      intervalMs,
    });
    return id;
  }
}

interface FakeSocketEvent {
  code?: number;
  reason?: string;
  data?: string;
  currentTarget?: FakeWebSocket;
}

class FakeWebSocket
  implements Pick<WebSocket, "addEventListener" | "send" | "close">
{
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly listeners = new Map<
    string,
    Array<WebSocketEventListener>
  >();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(
    type: string,
    listener: WebSocketEventListener,
    _options?: WebSocketEventListenerOptions
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("Socket is not open");
    }
    this.sent.push(JSON.parse(data as string) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSING;
    // Intentionally do not emit close. This models the iOS half-open failure
    // where the shim must reconnect without receiving a lifecycle event.
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  receive(message: Record<string, unknown>): void {
    this.emit("message", {
      data: JSON.stringify(message),
      currentTarget: this,
    });
  }

  serverClose(code = 1006, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code, reason, currentTarget: this });
  }

  private emit(type: string, event: FakeSocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === "function") {
        listener(event as unknown as Event);
      } else {
        listener.handleEvent(event as unknown as Event);
      }
    }
  }
}

function loadShim() {
  FakeWebSocket.instances = [];
  const clock = new FakeClock();
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const shimPath = path.join(repoRoot, "src", "server", "standalone-shim.js");
  const source = renderHostedStandaloneShimScript(
    fs.readFileSync(shimPath, "utf8")
  );
  const windowListeners = new Map<string, TimerCallback[]>();
  const documentListeners = new Map<string, TimerCallback[]>();
  const storage = new Map<string, string>();
  const storageApi = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  };
  const document = {
    visibilityState: "visible",
    documentElement: { style: { setProperty: () => undefined } },
    body: { classList: { remove: () => undefined, add: () => undefined } },
    addEventListener: (event: string, handler: TimerCallback) => {
      documentListeners.set(event, [
        ...(documentListeners.get(event) ?? []),
        handler,
      ]);
    },
    getElementById: () => null,
    createElement: () => ({
      style: {},
      appendChild: () => undefined,
      addEventListener: () => undefined,
    }),
  };
  const window = {
    addEventListener: (event: string, handler: TimerCallback) => {
      windowListeners.set(event, [
        ...(windowListeners.get(event) ?? []),
        handler,
      ]);
    },
    dispatchEvent: () => true,
    setTimeout: (callback: TimerCallback, delayMs?: number) =>
      clock.setTimeout(callback, delayMs),
    clearTimeout: (id: number) => clock.clearTimer(id),
    setInterval: (callback: TimerCallback, intervalMs?: number) =>
      clock.setInterval(callback, intervalMs),
  };
  const location = {
    protocol: "https:",
    host: "localhost:4747",
    search: "?token=test-token",
  };
  const context = {
    console,
    localStorage: storageApi,
    sessionStorage: storageApi,
    location,
    URLSearchParams,
    encodeURIComponent,
    Math: { min: Math.min, random: () => 0.123456789 },
    Date: { now: () => clock.now },
    WebSocket: FakeWebSocket,
    setInterval: (callback: TimerCallback, intervalMs?: number) =>
      clock.setInterval(callback, intervalMs),
    clearInterval: (id: number) => clock.clearTimer(id),
    setTimeout: (callback: TimerCallback, delayMs?: number) =>
      clock.setTimeout(callback, delayMs),
    clearTimeout: (id: number) => clock.clearTimer(id),
    queueMicrotask: (callback: TimerCallback) => callback(),
    document,
    window,
  } as any;
  context.window.window = context.window;
  context.window.localStorage = context.localStorage;
  context.window.sessionStorage = context.sessionStorage;
  context.window.document = context.document;
  context.window.location = context.location;

  vm.runInNewContext(source, context, { filename: shimPath });
  return {
    clock,
    document,
    location,
    dispatchWindow(event: string) {
      for (const handler of windowListeners.get(event) ?? []) handler();
    },
    dispatchDocument(event: string) {
      for (const handler of documentListeners.get(event) ?? []) handler();
    },
  };
}

suite("standalone-shim connection liveness", () => {
  test("replaces an OPEN socket after inbound heartbeats go stale", () => {
    const { clock } = loadShim();
    const firstSocket = FakeWebSocket.instances[0];
    firstSocket.open();

    clock.advance(50_000);

    assert.strictEqual(firstSocket.readyState, FakeWebSocket.CLOSING);
    assert.strictEqual(FakeWebSocket.instances.length, 2);

    const replacement = FakeWebSocket.instances[1];
    replacement.open();
    assert.ok(
      replacement.sent.some(
        (message) =>
          message.type === MESSAGE_TYPES.LOG_MESSAGE &&
          String(message.message).includes("inbound watchdog timed out")
      )
    );
  });

  test("foreground probe acknowledgment keeps the current socket", () => {
    const { clock, dispatchWindow } = loadShim();
    const socket = FakeWebSocket.instances[0];
    socket.open();

    dispatchWindow("focus");
    const probe = socket.sent.find(
      (message) => message.type === MESSAGE_TYPES.HOSTED_CONNECTION_HEARTBEAT
    );
    assert.ok(probe);

    socket.receive({
      type: MESSAGE_TYPES.HOSTED_CONNECTION_HEARTBEAT_ACK,
      id: probe.id,
    });
    clock.advance(9_000);

    assert.strictEqual(FakeWebSocket.instances.length, 1);
    assert.strictEqual(
      socket.sent.filter((message) => message.type === MESSAGE_TYPES.READY)
        .length,
      1
    );
  });

  test("foreground probe acknowledgment refreshes READY after the preferred view changes", () => {
    const { location, dispatchWindow } = loadShim();
    const socket = FakeWebSocket.instances[0];
    socket.open();

    location.search =
      "?token=test-token&workflowKey=workflow-1&runRef=run-2026-07-21";
    dispatchWindow("focus");
    const probe = socket.sent.find(
      (message) => message.type === MESSAGE_TYPES.HOSTED_CONNECTION_HEARTBEAT
    );
    assert.ok(probe);

    socket.receive({
      type: MESSAGE_TYPES.HOSTED_CONNECTION_HEARTBEAT_ACK,
      id: probe.id,
    });

    const readyMessages = socket.sent.filter(
      (message) => message.type === MESSAGE_TYPES.READY
    );
    assert.strictEqual(readyMessages.length, 2);
    assert.deepStrictEqual(readyMessages[1].preferredViewAddress, {
      workflowKey: "workflow-1",
      kind: "run",
      runRef: "run-2026-07-21",
    });
  });

  test("a replacement socket receives READY even when the preferred view is unchanged", () => {
    const { clock } = loadShim();
    const firstSocket = FakeWebSocket.instances[0];
    firstSocket.open();

    firstSocket.serverClose();
    clock.advance(250);

    const replacement = FakeWebSocket.instances[1];
    replacement.open();

    assert.strictEqual(
      replacement.sent.filter((message) => message.type === MESSAGE_TYPES.READY)
        .length,
      1
    );
  });

  test("foreground probe timeout replaces a stale OPEN socket", () => {
    const { clock, dispatchWindow } = loadShim();
    const socket = FakeWebSocket.instances[0];
    socket.open();

    dispatchWindow("focus");
    clock.advance(8_001);

    assert.strictEqual(socket.readyState, FakeWebSocket.CLOSING);
    assert.strictEqual(FakeWebSocket.instances.length, 2);
  });

  test("acknowledges server heartbeats without dispatching them to React", () => {
    loadShim();
    const socket = FakeWebSocket.instances[0];
    socket.open();

    socket.receive({
      type: MESSAGE_TYPES.HOSTED_CONNECTION_HEARTBEAT,
      id: "server-1",
      sentAt: 10_000,
    });

    assert.ok(
      socket.sent.some(
        (message) =>
          message.type === MESSAGE_TYPES.HOSTED_CONNECTION_HEARTBEAT_ACK &&
          message.id === "server-1"
      )
    );
  });

  test("reconnects on visibility restore after close was deferred while hidden", () => {
    const { document, dispatchDocument } = loadShim();
    const socket = FakeWebSocket.instances[0];
    socket.open();

    document.visibilityState = "hidden";
    dispatchDocument("visibilitychange");
    socket.serverClose();
    assert.strictEqual(FakeWebSocket.instances.length, 1);

    document.visibilityState = "visible";
    dispatchDocument("visibilitychange");
    assert.strictEqual(FakeWebSocket.instances.length, 2);
  });
});
