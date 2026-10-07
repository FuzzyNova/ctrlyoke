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
  localStorage?: StorageSeed | FakeStorage;
  sessionStorage?: StorageSeed;
  random?: number;
  workspaceKey?: string;
}) {
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const shimPath = path.join(repoRoot, "src", "server", "standalone-shim.js");
  const source = renderHostedStandaloneShimScript(
    fs.readFileSync(shimPath, "utf8"),
    options.workspaceKey ?? "project-a"
  );
  const localStorage =
    options.localStorage instanceof FakeStorage
      ? options.localStorage
      : new FakeStorage(options.localStorage);
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
        "fpLastTabId-project-a": "tab-1",
        "fpState-project-a-last": JSON.stringify({
          ...lastState,
          storageVersion: 1,
        }),
      },
    });

    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(api.getState())),
      { ...lastState, storageVersion: 1 }
    );
    assert.strictEqual(sessionStorage.getItem("fpTabId-project-a"), "tab-1");

    const nextState = { editorState: { editorText: "updated prompt" } };
    api.setState(nextState);

    assert.deepStrictEqual(
      JSON.parse(localStorage.getItem("fpState-project-a-tab-1")!),
      { ...nextState, storageVersion: 1 }
    );
    assert.deepStrictEqual(
      JSON.parse(localStorage.getItem("fpState-project-a-last")!),
      { ...nextState, storageVersion: 1 }
    );
  });

  test("prefers the current tab state over the fallback snapshot", () => {
    const currentTabState = { editorState: { editorText: "current tab" } };
    const lastState = { editorState: { editorText: "older tab" } };
    const { api } = loadShim({
      sessionStorage: { "fpTabId-project-a": "tab-2" },
      localStorage: {
        "fpState-project-a-tab-2": JSON.stringify({
          ...currentTabState,
          storageVersion: 1,
        }),
        "fpState-project-a-last": JSON.stringify({
          ...lastState,
          storageVersion: 1,
        }),
      },
    });

    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(api.getState())),
      { ...currentTabState, storageVersion: 1 }
    );
  });

  test("scopes tab and state keys to the workspace", () => {
    const storage = new FakeStorage();
    const alpha = loadShim({
      workspaceKey: "alpha",
      random: 0.1,
      localStorage: storage,
    });
    const beta = loadShim({
      workspaceKey: "beta",
      random: 0.1,
      localStorage: storage,
    });

    alpha.api.setState({ draft: "alpha" });
    beta.api.setState({ draft: "beta" });
    const alphaTabId = alpha.sessionStorage.getItem("fpTabId-alpha");
    const betaTabId = beta.sessionStorage.getItem("fpTabId-beta");
    assert.ok(alphaTabId);
    assert.ok(betaTabId);

    assert.deepStrictEqual(
      JSON.parse(alpha.localStorage.getItem(`fpState-alpha-${alphaTabId}`)!),
      { draft: "alpha", storageVersion: 1 }
    );
    assert.deepStrictEqual(
      JSON.parse(beta.localStorage.getItem(`fpState-beta-${betaTabId}`)!),
      { draft: "beta", storageVersion: 1 }
    );
    assert.strictEqual(storage.getItem("fpLastTabId-alpha"), alphaTabId);
    assert.strictEqual(storage.getItem("fpLastTabId-beta"), betaTabId);
    const alphaOpenTabs = JSON.parse(
      storage.getItem("fpOpenTabs-alpha")!
    ) as Record<string, number>;
    const betaOpenTabs = JSON.parse(
      storage.getItem("fpOpenTabs-beta")!
    ) as Record<string, number>;
    assert.deepStrictEqual(Object.keys(alphaOpenTabs), [alphaTabId]);
    assert.deepStrictEqual(Object.keys(betaOpenTabs), [betaTabId]);
    assert.deepStrictEqual(
      JSON.parse(storage.getItem("fpState-alpha-last")!),
      { draft: "alpha", storageVersion: 1 }
    );
    assert.deepStrictEqual(
      JSON.parse(storage.getItem("fpState-beta-last")!),
      { draft: "beta", storageVersion: 1 }
    );
  });

  test("starts clean when the persisted root storage version differs", () => {
    const { api, localStorage } = loadShim({
      sessionStorage: { "fpTabId-project-a": "tab-old" },
      localStorage: {
        "fpState-project-a-tab-old": JSON.stringify({
          draft: "old",
          storageVersion: 0,
        }),
        "fpState-project-a-last": JSON.stringify({
          draft: "old fallback",
          storageVersion: 0,
        }),
      },
    });

    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(api.getState())),
      { storageVersion: 1 }
    );
    api.setState({ draft: "new" });
    assert.deepStrictEqual(
      JSON.parse(localStorage.getItem("fpState-project-a-tab-old")!),
      { draft: "new", storageVersion: 1 }
    );
  });

  test("round-trips UI, editor, and workspace file draft state", () => {
    const state = {
      "ctrlyoke-ui-state": JSON.stringify({ state: { outputCollapsed: true } }),
      editorState: { promptText: "unsent prompt" },
      "ctrlyoke-workspace-viewer-state": JSON.stringify({
        state: { fileDrafts: { "src/index.ts": { content: "unsaved edit" } } },
      }),
    };
    const firstTab = loadShim({ workspaceKey: "round-trip" });
    firstTab.api.setState(state);

    const secondTab = loadShim({
      workspaceKey: "round-trip",
      sessionStorage: { "fpTabId-round-trip": "tab-1" },
      localStorage: firstTab.localStorage,
    });

    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(secondTab.api.getState())),
      { ...state, storageVersion: 1 }
    );
  });
});
