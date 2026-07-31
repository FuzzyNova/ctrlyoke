import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { suite, test } from "mocha";
import { renderHostedStandaloneShimScript } from "../../server/HostedStandaloneShimScript";

type WebSocketEventListener = Parameters<WebSocket["addEventListener"]>[1];
type WebSocketEventListenerOptions = Parameters<
  WebSocket["addEventListener"]
>[2];

type StorageSeed = Record<string, string>;

class FakeStorage implements Pick<Storage, "setItem" | "removeItem"> {
  private readonly values = new Map<string, string>();

  constructor(seed: StorageSeed = {}) {
    for (const [key, value] of Object.entries(seed)) {
      this.values.set(key, value);
    }
  }

  getItem(key: string): string | null {
    return this.values.has(key) ? this.values.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

class FakeWebSocket implements Pick<
  WebSocket,
  "addEventListener" | "send" | "close"
> {
  static readonly OPEN = 1;
  readonly readyState = FakeWebSocket.OPEN;

  constructor(readonly url: string) {}

  addEventListener(
    _type: string,
    _listener: WebSocketEventListener,
    _options?: WebSocketEventListenerOptions
  ): void {
    // The state tests do not need to drive socket lifecycle events.
  }

  send(_data: string | ArrayBufferLike | Blob | ArrayBufferView): void {}

  close(_code?: number, _reason?: string): void {}
}

function loadShim(options: {
  localStorage?: StorageSeed;
  sessionStorage?: StorageSeed;
  random?: number;
}) {
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const shimPath = path.join(repoRoot, "src", "server", "standalone-shim.js");
  const source = renderHostedStandaloneShimScript(
    fs.readFileSync(shimPath, "utf8")
  );
  const localStorage = new FakeStorage(options.localStorage);
  const sessionStorage = new FakeStorage(options.sessionStorage);
  const windowListeners: Record<string, () => void> = {};
  const context = {
    console,
    localStorage,
    sessionStorage,
    location: {
      protocol: "https:",
      host: "localhost:4747",
      search: "?token=test-token",
    },
    URLSearchParams,
    encodeURIComponent,
    Math: { ...Math, random: () => options.random ?? 0.123456789 },
    WebSocket: FakeWebSocket,
    setInterval: () => 1,
    clearInterval: () => undefined,
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    queueMicrotask: (fn: () => void) => fn(),
    document: {
      visibilityState: "visible",
      documentElement: { style: { setProperty: () => undefined } },
      body: { classList: { remove: () => undefined, add: () => undefined } },
      addEventListener: () => undefined,
      getElementById: () => null,
      createElement: () => ({
        style: {},
        appendChild: () => undefined,
        addEventListener: () => undefined,
      }),
    },
    window: {
      addEventListener: (event: string, handler: () => void) => {
        windowListeners[event] = handler;
      },
      dispatchEvent: () => true,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      setInterval: () => 1,
    },
  } as any;
  context.window.window = context.window;
  context.window.localStorage = localStorage;
  context.window.sessionStorage = sessionStorage;
  context.window.document = context.document;
  context.window.location = context.location;

  vm.runInNewContext(source, context, { filename: shimPath });
  return { api: context.window.vscodeApi, localStorage, sessionStorage };
}

suite("standalone-shim state persistence", () => {
  test("restores the most recent state when a browser close loses sessionStorage", () => {
    const lastState = { editorState: { editorText: "unsent prompt" } };
    const { api, localStorage, sessionStorage } = loadShim({
      localStorage: {
        fpLastTabId: "tab-1",
        "fpState-last": JSON.stringify(lastState),
      },
    });

    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(api.getState())),
      lastState
    );
    assert.strictEqual(sessionStorage.getItem("fpTabId"), "tab-1");

    const nextState = { editorState: { editorText: "updated prompt" } };
    api.setState(nextState);

    assert.deepStrictEqual(
      JSON.parse(localStorage.getItem("fpState-tab-1")!),
      nextState
    );
    assert.deepStrictEqual(
      JSON.parse(localStorage.getItem("fpState-last")!),
      nextState
    );
  });

  test("prefers the current tab state over the fallback snapshot", () => {
    const currentTabState = { editorState: { editorText: "current tab" } };
    const lastState = { editorState: { editorText: "older tab" } };
    const { api } = loadShim({
      sessionStorage: { fpTabId: "tab-2" },
      localStorage: {
        "fpState-tab-2": JSON.stringify(currentTabState),
        "fpState-last": JSON.stringify(lastState),
      },
    });

    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(api.getState())),
      currentTabState
    );
  });
});
