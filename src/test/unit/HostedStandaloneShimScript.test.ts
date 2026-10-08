import * as assert from "assert";
import * as vm from "vm";
import { suite, test } from "mocha";
import {
  HOSTED_CONNECTION_LIVENESS,
  MESSAGE_TYPES,
} from "../../types/DashboardConstants";
import {
  buildHostedStandaloneShimScript,
  renderHostedStandaloneShimScript,
} from "../../server/HostedStandaloneShimScript";

/** Minimal Storage stand-in — the shim only uses get/set/removeItem. */
function makeStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) =>
      void values.set(key, String(value)),
    removeItem: (key: string) => void values.delete(key),
  } as unknown as Storage;
}

interface FakeSocket {
  url: string;
  readyState: number;
  sent: any[];
  listeners: Map<string, WebSocketEventListener[]>;
  emit(event: string, payload?: any): void;
}

type WebSocketEventListener = Parameters<WebSocket["addEventListener"]>[1];
type WebSocketEventListenerOptions = Parameters<
  WebSocket["addEventListener"]
>[2];

/**
 * Evaluates the rendered shim against just enough browser surface to reach
 * `window.vscodeApi`. Returns the sockets it opened so a test can drive the
 * connect/reconnect lifecycle by hand.
 */
function loadShim(): {
  api: any;
  sockets: FakeSocket[];
  dispatched: any[];
} {
  const sockets: FakeSocket[] = [];
  const dispatched: any[] = [];

  class FakeWebSocket
    implements
      FakeSocket,
      Pick<WebSocket, "addEventListener" | "send" | "close">
  {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = FakeWebSocket.CONNECTING;
    sent: any[] = [];
    listeners = new Map<string, WebSocketEventListener[]>();
    constructor(public url: string) {
      sockets.push(this);
    }
    addEventListener(
      event: string,
      handler: WebSocketEventListener,
      _options?: WebSocketEventListenerOptions
    ): void {
      const handlers = this.listeners.get(event) ?? [];
      handlers.push(handler);
      this.listeners.set(event, handlers);
    }
    send(raw: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      this.sent.push(JSON.parse(raw as string));
    }
    close(): void {
      this.readyState = FakeWebSocket.CLOSED;
    }
    emit(event: string, payload?: any): void {
      for (const handler of this.listeners.get(event) ?? []) {
        if (typeof handler === "function") {
          handler(payload);
        } else {
          handler.handleEvent(payload);
        }
      }
    }
  }

  const noop = () => {};
  const context: any = {
    console,
    JSON,
    Math,
    Date,
    URLSearchParams,
    WebSocket: FakeWebSocket,
    MessageEvent: class {
      constructor(
        public type: string,
        public init: any
      ) {
        Object.assign(this, init);
      }
    },
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    location: {
      protocol: "https:",
      host: "127.0.0.1:4747",
      search: "?token=t",
    },
    document: {
      visibilityState: "visible",
      addEventListener: noop,
      getElementById: () => null,
      createElement: () => ({ setAttribute: noop, querySelector: () => null }),
      body: null,
      documentElement: { style: { setProperty: noop } },
      querySelector: () => null,
    },
    // Timers are inert: every test drives the socket lifecycle explicitly.
    setTimeout: () => 0,
    clearTimeout: noop,
    setInterval: () => 0,
    clearInterval: noop,
    queueMicrotask: (fn: () => void) => fn(),
  };
  context.window = context;
  context.window.addEventListener = noop;
  context.window.dispatchEvent = (event: { type: string; data: unknown }) => {
    dispatched.push({ type: event.type, data: event.data });
    return true;
  };
  context.window.setTimeout = context.setTimeout;
  context.window.clearTimeout = context.clearTimeout;
  context.window.setInterval = context.setInterval;

  vm.runInNewContext(
    buildHostedStandaloneShimScript("test-workspace"),
    context
  );
  return { api: context.window.vscodeApi, sockets, dispatched };
}

/** Brings the shim's current socket to OPEN, which flushes pendingOutbound. */
function openSocket(socket: FakeSocket): void {
  socket.readyState = 1;
  socket.emit("open");
}

suite("HostedStandaloneShimScript", () => {
  test("renders shared liveness configuration into the template", () => {
    const rendered = renderHostedStandaloneShimScript(
      'const config = "__CTRLYOKE_HOSTED_CONNECTION_CONFIG__";',
      "test-workspace"
    );

    assert.ok(
      rendered.includes(
        JSON.stringify(MESSAGE_TYPES.HOSTED_CONNECTION_HEARTBEAT)
      )
    );
    assert.ok(
      rendered.includes(
        JSON.stringify(MESSAGE_TYPES.HOSTED_CONNECTION_HEARTBEAT_ACK)
      )
    );
    assert.ok(rendered.includes(JSON.stringify(MESSAGE_TYPES.READY)));
    assert.ok(rendered.includes('"workspaceKey":"test-workspace"'));
    assert.ok(
      rendered.includes(
        `"CLIENT_STALE_TIMEOUT_MS":${HOSTED_CONNECTION_LIVENESS.CLIENT_STALE_TIMEOUT_MS}`
      )
    );
  });

  test("loads the standalone shim without placeholder tokens", () => {
    const rendered = buildHostedStandaloneShimScript("test-workspace");

    assert.match(rendered, /function checkInboundLiveness\(\)/);
    assert.ok(!rendered.includes("__CTRLYOKE_HOSTED_CONNECTION_CONFIG__"));
  });

  // pendingOutbound is flushed the instant a socket opens, and a socket opens
  // right after the extension host restarts. Queuing user commands there
  // replayed a pre-outage "Re-run" click into the freshly started extension and
  // launched a workflow nobody asked for.
  test("drops commands posted while disconnected instead of replaying them on reconnect", () => {
    const { api, sockets } = loadShim();
    assert.strictEqual(sockets.length, 1, "shim connects on load");

    api.postMessage({ type: MESSAGE_TYPES.SEED_NEW_RUN, address: {} });
    api.postMessage({ type: MESSAGE_TYPES.RESUME_RUN, address: {} });
    openSocket(sockets[0]);

    const replayedTypes = sockets[0].sent.map((message) => message.type);
    assert.ok(
      !replayedTypes.includes(MESSAGE_TYPES.SEED_NEW_RUN),
      `re-run must not be replayed on connect, got ${replayedTypes.join(", ")}`
    );
    assert.ok(!replayedTypes.includes(MESSAGE_TYPES.RESUME_RUN));
  });

  test("still delivers the READY handshake posted before the socket opened", () => {
    const { api, sockets } = loadShim();

    api.postMessage({ type: MESSAGE_TYPES.READY });
    openSocket(sockets[0]);

    assert.ok(
      sockets[0].sent.some((message) => message.type === MESSAGE_TYPES.READY),
      "READY is the one message allowed to wait for a socket"
    );
  });

  test("sends commands normally once the socket is open", () => {
    const { api, sockets } = loadShim();
    openSocket(sockets[0]);

    api.postMessage({ type: MESSAGE_TYPES.SEED_NEW_RUN, address: {} });

    assert.ok(
      sockets[0].sent.some(
        (message) => message.type === MESSAGE_TYPES.SEED_NEW_RUN
      )
    );
  });

  test("preserves capability snapshots and harness changes across the hosted WebSocket", () => {
    const { api, sockets, dispatched } = loadShim();
    openSocket(sockets[0]);
    api.postMessage({ type: MESSAGE_TYPES.READY });

    const capabilitySnapshot = {
      schemaVersion: 1,
      enabledDomains: ["permissions"],
      harnesses: {
        "copilot-cli": { available: true },
        "claude-cli": { available: true },
        "codex-cli": { available: true },
        "opencode-cli": { available: true },
        "qwen-cli": { available: true },
        "antigravity-cli": { available: true },
      },
    };
    const snapshotMessage = {
      type: MESSAGE_TYPES.HARNESS_CAPABILITY_SNAPSHOT,
      data: { snapshot: capabilitySnapshot },
    };

    api.postMessage({
      type: MESSAGE_TYPES.CHANGE_HARNESS,
      harness: "claude-cli",
    });
    assert.ok(
      sockets[0].sent.some(
        (message) =>
          message.type === MESSAGE_TYPES.CHANGE_HARNESS &&
          message.harness === "claude-cli"
      )
    );

    sockets[0].emit("message", {
      currentTarget: sockets[0],
      data: JSON.stringify(snapshotMessage),
    });
    assert.deepStrictEqual(dispatched, [
      { type: "message", data: snapshotMessage },
    ]);
    assert.deepStrictEqual(
      dispatched[0].data.data.snapshot,
      capabilitySnapshot,
      "hosted clients receive the same capability snapshot used by the VS Code webview"
    );
  });
});
