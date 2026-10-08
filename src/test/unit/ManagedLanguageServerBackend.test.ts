import * as assert from "assert";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PassThrough } from "stream";
import { pathToFileURL } from "url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "../../types/CtrlYokeSettings";
import {
  LANGUAGE_SERVER_REQUEST_ORIGINS,
  LSP_SESSION_INVALIDATION_CLOSE,
} from "../../types/DashboardConstants";
import { ManagedLanguageServerBackend } from "../../server/lsp/ManagedLanguageServerBackend";
import { LanguageIntelligenceHost } from "../../server/lsp/LanguageIntelligenceHost";
import type { UserInteractionPort } from "../../ui/UserInteractionPort";

suite("ManagedLanguageServerBackend", () => {
  const root = "/workspace";
  const roots = { workspaceRoot: root, namedRoots: [] };

  test("trust gate prevents resolution and spawning", async () => {
    let spawnCount = 0;
    const backend = createBackend({
      trusted: false,
      onSpawn: () => {
        spawnCount += 1;
      },
    });
    const result = await backend.resolveForPath(
      "src/app.ts",
      roots,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    assert.deepStrictEqual(result, { reason: "untrusted" });
    assert.strictEqual(spawnCount, 0);
    await backend.dispose();
  });

  test("keeps background unresolved lookups quiet while explicit lookup reports status", async () => {
    const backend = createBackend({ installed: false });
    const statuses: string[] = [];
    backend.onStatusChanged((event) => statuses.push(event.status));
    try {
      assert.deepStrictEqual(
        await backend.resolveForPath(
          "src/app.ts",
          roots,
          LANGUAGE_SERVER_REQUEST_ORIGINS.BACKGROUND
        ),
        { reason: "no server" }
      );
      assert.deepStrictEqual(statuses, []);

      await backend.resolveForPath(
        "src/app.ts",
        roots,
        LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
      );
      assert.deepStrictEqual(statuses, ["not installed"]);
    } finally {
      await backend.dispose();
    }
  });

  test("requires approval, remembers it, and asks again when executable fields change", async () => {
    let decisions = 0;
    const store = new Map<string, unknown>();
    const interaction: UserInteractionPort = {
      canPrompt: () => true,
      requestChoice: async () => undefined,
      requestBatchApproval: async (request) => {
        decisions += 1;
        return {
          approvedValues: request.items.map((item) => item.value),
          deniedValues: [],
        };
      },
    };
    const settings = {
      ...CTRLYOKE_SETTINGS_DEFAULTS.languageServers,
      definitions: {
        custom: {
          command: ["custom-lsp", "--stdio"],
          languages: ["typescript"],
          extensions: ["ts"],
          rootMarkers: [],
          env: { MODE: "one" },
        },
      },
      use: { typescript: "custom" },
      settings: {
        custom: { typescript: { tsdk: "./node_modules/typescript/lib" } },
      },
    };
    const backend = createBackend({
      store,
      interaction,
      workspaceSettings: settings,
    });
    const result = await backend.resolveForPath(
      "src/app.ts",
      roots,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    assert.ok("descriptor" in result);
    assert.strictEqual(decisions, 1);
    await backend.resolveForPath(
      "src/app.ts",
      roots,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    assert.strictEqual(decisions, 1);
    settings.definitions.custom.env.MODE = "two";
    await backend.resolveForPath(
      "src/app.ts",
      roots,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    assert.strictEqual(decisions, 2);
    settings.settings.custom.typescript.tsdk = "./vendor/typescript/lib";
    await backend.resolveForPath(
      "src/app.ts",
      roots,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    assert.strictEqual(
      decisions,
      3,
      "path-bearing initialization settings are bound to the approval hash"
    );
    await backend.dispose();
  });

  test("keeps initialize capabilities after startLanguages warmup", async () => {
    const backend = createBackend();
    const host = new LanguageIntelligenceHost({
      backend,
      workspaceRoot: root,
      namedWorkspaceRoots: [],
      isWorkspaceTrusted: () => true,
    });
    try {
      await backend.startLanguages(["typescript"]);
      const first = await host.lookupSession(
        "src/app.ts",
        LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
      );
      assert.ok(first.session);
      assert.deepStrictEqual(first.session.capabilities, {
        completionProvider: {},
        hoverProvider: true,
      });
      const messages: unknown[] = [];
      const proxy = await host.createProxy(
        first.session.id,
        (message) => messages.push(message),
        async () => true
      );
      await proxy?.handleMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });
      assert.deepStrictEqual((messages[0] as { result: unknown }).result, {
        capabilities: { completionProvider: {}, hoverProvider: true },
        serverInfo: { name: "typescript-language-server" },
      });
      const second = await host.lookupSession(
        "src/app.ts",
        LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
      );
      assert.deepStrictEqual(second.session?.capabilities, {
        completionProvider: {},
        hoverProvider: true,
      });
    } finally {
      await host.dispose();
    }
  });

  test("coalesces concurrent connection requests for one server root", async () => {
    const children: EventEmitter[] = [];
    const backend = createBackend({ children });
    const result = await backend.resolveForPath(
      "src/app.ts",
      roots,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    assert.ok("descriptor" in result);
    const [first, second] = await Promise.all([
      backend.getConnection(
        result.descriptor,
        LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
      ),
      backend.getConnection(
        result.descriptor,
        LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
      ),
    ]);
    assert.strictEqual(first, second);
    assert.deepStrictEqual(result.descriptor.capabilities, {
      completionProvider: {},
      hoverProvider: true,
    });
    assert.strictEqual(children.length, 1);
    await backend.dispose();
  });

  test("bounds shutdown, sends exit, and kills a child before a late shutdown reply", async () => {
    const children: EventEmitter[] = [];
    const backend = createBackend({
      children,
      ignoreShutdown: true,
      ignoreExit: true,
      setTimer: ((callback: () => void, delay?: number) => {
        if (delay === 1_000) setImmediate(callback);
        return callback as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimer: (() => undefined) as typeof clearTimeout,
    });
    const result = await backend.resolveForPath(
      "src/app.ts",
      roots,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    assert.ok("descriptor" in result);
    await backend.getConnection(
      result.descriptor,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    await backend.dispose();
    assert.strictEqual(
      (children[0] as EventEmitter & { killCount: number }).killCount,
      1
    );
  });

  test("stops a server still initializing and never hands out its connection", async () => {
    let resolveInitialize!: (value: unknown) => void;
    const initializeResponse = new Promise<unknown>((resolve) => {
      resolveInitialize = resolve;
    });
    const children: EventEmitter[] = [];
    const backend = createBackend({ children, initializeResponse });
    const result = await backend.resolveForPath(
      "src/app.ts",
      roots,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    assert.ok("descriptor" in result);
    const starting = backend.getConnection(
      result.descriptor,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    await waitForCondition(
      () => children.length === 1,
      "language-server spawn"
    );
    await backend.stopManagedServer(result.descriptor.id);
    resolveInitialize({ capabilities: { hoverProvider: true } });
    const settled = await Promise.allSettled([starting]);
    assert.strictEqual(settled[0]?.status, "rejected");
    assert.strictEqual(backend.runningServerCount, 0);
    await backend.dispose();
  });

  test("restart starts a detected server that has never run", async () => {
    let spawnCount = 0;
    const backend = createBackend({
      onSpawn: () => {
        spawnCount += 1;
      },
    });
    try {
      await backend.restartServer("typescript-language-server");
      assert.strictEqual(spawnCount, 1);
      assert.strictEqual(backend.runningServerCount, 1);
    } finally {
      await backend.dispose();
    }
  });

  test("evicts a failed startup session so a later lookup retries and reports the crash", async () => {
    let attempts = 0;
    const backend = createBackend({
      onSpawn: () => {
        attempts += 1;
        throw new Error("spawn failed");
      },
    });
    const host = new LanguageIntelligenceHost({
      backend,
      workspaceRoot: root,
      namedWorkspaceRoots: [],
      isWorkspaceTrusted: () => true,
    });
    const statuses: string[] = [];
    host.onStatusChanged((event) => statuses.push(event.status));
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(
          host.lookupSession(
            "src/app.ts",
            LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
          ),
          /spawn failed/
        );
      }
      assert.strictEqual(attempts, 2);
      assert.ok(statuses.includes("crashed"));
    } finally {
      await host.dispose();
    }
  });

  test("closes every attached proxy with the reconnect code before connection disposal", async () => {
    const backend = createBackend();
    const host = new LanguageIntelligenceHost({
      backend,
      workspaceRoot: root,
      namedWorkspaceRoots: [],
      isWorkspaceTrusted: () => true,
    });
    const closes: Array<{ code: number; reason: string }> = [];
    try {
      const lookup = await host.lookupSession(
        "src/app.ts",
        LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
      );
      assert.ok(lookup.session);
      await host.createProxy(
        lookup.session.id,
        () => undefined,
        async () => true,
        undefined,
        (code, reason) => {
          closes.push({ code, reason });
        }
      );
      await host.createProxy(
        lookup.session.id,
        () => undefined,
        async () => true,
        undefined,
        (code, reason) => {
          closes.push({ code, reason });
        }
      );
      await backend.stopManagedServer("typescript-language-server");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepStrictEqual(closes, [
        {
          code: LSP_SESSION_INVALIDATION_CLOSE.CODE,
          reason: LSP_SESSION_INVALIDATION_CLOSE.REASON,
        },
        {
          code: LSP_SESSION_INVALIDATION_CLOSE.CODE,
          reason: LSP_SESSION_INVALIDATION_CLOSE.REASON,
        },
      ]);
    } finally {
      await host.dispose();
    }
  });

  test("user stop prevents lookup respawn until restart", async () => {
    let spawnCount = 0;
    const backend = createBackend({
      onSpawn: () => {
        spawnCount += 1;
      },
    });
    const host = new LanguageIntelligenceHost({
      backend,
      workspaceRoot: root,
      namedWorkspaceRoots: [],
      isWorkspaceTrusted: () => true,
    });
    try {
      assert.ok(
        (
          await host.lookupSession(
            "src/app.ts",
            LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
          )
        ).session
      );
      await host.stopServer("typescript-language-server");
      assert.deepStrictEqual(
        await host.lookupSession(
          "src/app.ts",
          LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
        ),
        {
          session: null,
          reason: "stopped",
        }
      );
      assert.strictEqual(spawnCount, 1);
      await host.restartServer("typescript-language-server");
      assert.ok(
        (
          await host.lookupSession(
            "src/app.ts",
            LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
          )
        ).session
      );
      assert.strictEqual(spawnCount, 2);
    } finally {
      await host.dispose();
    }
  });

  test("warmup starts do not evict at the running server cap", async () => {
    let spawnCount = 0;
    const backend = createBackend({
      maxRunning: 1,
      onSpawn: () => {
        spawnCount += 1;
      },
    });
    await backend.startLanguages(["typescript", "json"]);
    assert.strictEqual(spawnCount, 1);
    assert.strictEqual(backend.runningServerCount, 1);
    await backend.dispose();
  });

  test("background symbol and warmup requests stay quiet and never evict at the cap", async () => {
    let spawnCount = 0;
    const statuses: string[] = [];
    const backend = createBackend({
      maxRunning: 1,
      onSpawn: () => {
        spawnCount += 1;
      },
    });
    backend.onStatusChanged((event) => statuses.push(event.status));
    const host = new LanguageIntelligenceHost({
      backend,
      workspaceRoot: root,
      namedWorkspaceRoots: [],
      isWorkspaceTrusted: () => true,
    });
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await backend.startLanguages(["typescript", "python"]);
        await host.requestForPath(
          "src/app.py",
          "workspace/symbol",
          { query: "Widget" },
          LANGUAGE_SERVER_REQUEST_ORIGINS.BACKGROUND
        );
        await host.openWarmupDocument(
          "src/app.py",
          "python",
          LANGUAGE_SERVER_REQUEST_ORIGINS.BACKGROUND
        );
      }
      assert.strictEqual(spawnCount, 1);
      assert.strictEqual(backend.runningServerCount, 1);
      assert.strictEqual(
        statuses.filter((status) => status === "stopped").length,
        0
      );
      assert.strictEqual(
        statuses.filter((status) => status === "limit reached").length,
        0
      );
    } finally {
      await host.dispose();
    }
  });

  test("background warmup and path requests do not prompt for workspace definitions", async () => {
    let prompts = 0;
    const settings = {
      ...CTRLYOKE_SETTINGS_DEFAULTS.languageServers,
      definitions: {
        custom: {
          command: ["custom-lsp"],
          languages: ["typescript"],
          extensions: ["ts"],
          rootMarkers: [],
        },
      },
      use: { typescript: "custom" },
    };
    const backend = createBackend({
      workspaceSettings: settings,
      interaction: {
        canPrompt: () => true,
        requestChoice: async () => undefined,
        requestBatchApproval: async () => {
          prompts += 1;
          return undefined;
        },
      },
    });
    const host = new LanguageIntelligenceHost({
      backend,
      workspaceRoot: root,
      namedWorkspaceRoots: [],
      isWorkspaceTrusted: () => true,
    });
    try {
      await host.openWarmupDocument(
        "src/app.ts",
        "typescript",
        LANGUAGE_SERVER_REQUEST_ORIGINS.BACKGROUND
      );
      await host.requestForPath(
        "src/app.ts",
        "textDocument/completion",
        {},
        LANGUAGE_SERVER_REQUEST_ORIGINS.BACKGROUND
      );
      assert.strictEqual(prompts, 0);
    } finally {
      await host.dispose();
    }
  });

  test("does not prompt for an unrelated pending workspace definition", async () => {
    let prompts = 0;
    const settings = {
      ...CTRLYOKE_SETTINGS_DEFAULTS.languageServers,
      definitions: {
        custom: {
          command: ["custom-lsp"],
          languages: ["python"],
          extensions: ["py"],
          rootMarkers: [],
        },
      },
    };
    const backend = createBackend({
      workspaceSettings: settings,
      interaction: {
        canPrompt: () => true,
        requestChoice: async () => undefined,
        requestBatchApproval: async () => {
          prompts += 1;
          return undefined;
        },
      },
    });
    const result = await backend.resolveForPath(
      "src/app.ts",
      roots,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    assert.ok("descriptor" in result);
    assert.strictEqual(prompts, 0);
    await backend.dispose();
  });

  test("deduplicates a pending definition prompt and remembers dismissal for the host session", async () => {
    let prompts = 0;
    const settings = {
      ...CTRLYOKE_SETTINGS_DEFAULTS.languageServers,
      definitions: {
        custom: {
          command: ["custom-lsp"],
          languages: ["typescript"],
          extensions: ["ts"],
          rootMarkers: [],
        },
      },
      use: { typescript: "custom" },
    };
    const backend = createBackend({
      workspaceSettings: settings,
      interaction: {
        canPrompt: () => true,
        requestChoice: async () => undefined,
        requestBatchApproval: async () => {
          prompts += 1;
          return undefined;
        },
      },
    });
    const results = await Promise.all([
      backend.resolveForPath(
        "src/app.ts",
        roots,
        LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
      ),
      backend.resolveForPath(
        "src/other.ts",
        roots,
        LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
      ),
    ]);
    assert.deepStrictEqual(results, [
      { reason: "needs approval" },
      { reason: "needs approval" },
    ]);
    await backend.resolveForPath(
      "src/app.ts",
      roots,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    assert.strictEqual(prompts, 1);
    await backend.dispose();
  });

  test("uses the nearest root marker within the workspace", async () => {
    const workspace = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-lsp-root-")
    );
    const projectRoot = path.join(workspace, "packages", "app");
    await fs.promises.mkdir(path.join(projectRoot, "src"), { recursive: true });
    await fs.promises.writeFile(path.join(projectRoot, "app.sln"), "", "utf8");
    const backend = createBackend({ root: workspace });
    try {
      const result = await backend.resolveForPath(
        path.join(projectRoot, "src", "app.cs"),
        { workspaceRoot: workspace, namedRoots: [] },
        LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
      );
      assert.ok("descriptor" in result);
      assert.strictEqual(result.descriptor.rootPath, projectRoot);
    } finally {
      await backend.dispose();
      await fs.promises.rm(workspace, { recursive: true, force: true });
    }
  });

  test("warm-up anchors do not protect idle servers, while a browser open of the same URI does", async () => {
    const workspace = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-lsp-anchor-")
    );
    await fs.promises.writeFile(
      path.join(workspace, "anchor.ts"),
      "export const anchor = 1;",
      "utf8"
    );
    const timers: Array<() => void> = [];
    const children: EventEmitter[] = [];
    const backend = createBackend({
      root: workspace,
      children,
      setTimer: ((callback: () => void) => {
        timers.push(callback);
        return callback as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimer: (() => undefined) as typeof clearTimeout,
    });
    const host = new LanguageIntelligenceHost({
      backend,
      workspaceRoot: workspace,
      namedWorkspaceRoots: [],
      isWorkspaceTrusted: () => true,
    });
    let proxy: Awaited<ReturnType<LanguageIntelligenceHost["createProxy"]>>;
    try {
      await host.openWarmupDocument(
        "anchor.ts",
        "typescript",
        LANGUAGE_SERVER_REQUEST_ORIGINS.BACKGROUND
      );
      const lookup = await host.lookupSession(
        "anchor.ts",
        LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
      );
      assert.ok(lookup.session);
      proxy = await host.createProxy(
        lookup.session.id,
        () => undefined,
        async () => true
      );
      assert.ok(proxy);
      const uri = pathToFileURL(path.join(workspace, "anchor.ts")).toString();
      await proxy?.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri,
            languageId: "typescript",
            version: 1,
            text: "export const anchor = 1;",
          },
        },
      });
      timers.splice(0).forEach((timer) => timer());
      await Promise.resolve();
      assert.strictEqual(
        backend.runningServerCount,
        1,
        "the browser document protects the server"
      );
      await proxy?.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didClose",
        params: { textDocument: { uri } },
      });
      timers.splice(0).forEach((timer) => timer());
      for (
        let attempt = 0;
        attempt < 20 && backend.runningServerCount;
        attempt += 1
      )
        await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(
        backend.runningServerCount,
        0,
        "the warm-up reference alone does not prevent idle shutdown"
      );
    } finally {
      proxy?.dispose();
      await host.dispose();
      await fs.promises.rm(workspace, { recursive: true, force: true });
    }
  });

  test("idle shutdown never stops a server while a document is open", async () => {
    const timers: Array<() => void> = [];
    const backend = createBackend({
      setTimer: ((callback: () => void) => {
        timers.push(callback);
        return callback as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimer: (() => undefined) as typeof clearTimeout,
    });
    const result = await backend.resolveForPath(
      "src/app.ts",
      roots,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    assert.ok("descriptor" in result);
    await backend.getConnection(
      result.descriptor,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    backend.documentOpened(result.descriptor);
    timers.splice(0).forEach((timer) => timer());
    assert.strictEqual(backend.runningServerCount, 1);
    backend.documentClosed(result.descriptor);
    timers.splice(0).forEach((timer) => timer());
    assert.strictEqual(backend.runningServerCount, 0);
    await backend.dispose();
  });

  test("cap reports limit reached when every server owns an open document", async () => {
    const backend = createBackend({ maxRunning: 1 });
    const ts = await backend.resolveForPath(
      "src/app.ts",
      roots,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    assert.ok("descriptor" in ts);
    await backend.getConnection(
      ts.descriptor,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    backend.documentOpened(ts.descriptor);
    const json = await backend.resolveForPath(
      "package.json",
      roots,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    assert.deepStrictEqual(json, { reason: "limit reached" });
    backend.documentClosed(ts.descriptor);
    await backend.dispose();
  });

  test("evicts the least recently used idle server when the cap is full", async () => {
    const backend = createBackend({ maxRunning: 1 });
    const statuses: string[] = [];
    backend.onStatusChanged((status) =>
      statuses.push(`${status.id}:${status.status}`)
    );
    const ts = await backend.resolveForPath(
      "src/app.ts",
      roots,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    assert.ok("descriptor" in ts);
    await backend.getConnection(
      ts.descriptor,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    const json = await backend.resolveForPath(
      "package.json",
      roots,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    assert.ok("descriptor" in json);
    // Resolution only checks capacity; the slot is reserved when starting.
    assert.ok(!statuses.includes("typescript-language-server:stopped"));
    await backend.getConnection(
      json.descriptor,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    assert.ok(statuses.includes("typescript-language-server:stopped"));
    assert.strictEqual(backend.runningServerCount, 1);
    await backend.dispose();
  });

  test("concurrent editor starts never exceed the cap", async () => {
    let spawnCount = 0;
    const backend = createBackend({
      maxRunning: 1,
      onSpawn: () => {
        spawnCount += 1;
      },
    });
    const ts = await backend.resolveForPath(
      "src/app.ts",
      roots,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    const json = await backend.resolveForPath(
      "package.json",
      roots,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    assert.ok("descriptor" in ts && "descriptor" in json);
    const results = await Promise.allSettled([
      backend.getConnection(
        ts.descriptor,
        LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
      ),
      backend.getConnection(
        json.descriptor,
        LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
      ),
    ]);
    assert.deepStrictEqual(
      results.map((result) => result.status),
      ["fulfilled", "rejected"]
    );
    assert.strictEqual(spawnCount, 1);
    assert.strictEqual(backend.runningServerCount, 1);
    await backend.dispose();
  });

  test("a crash restart does not start beyond the cap", async () => {
    const timers: Array<() => void> = [];
    const children: EventEmitter[] = [];
    const statuses: string[] = [];
    const backend = createBackend({
      maxRunning: 1,
      children,
      setTimer: ((callback: () => void) => {
        timers.push(callback);
        return callback as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimer: (() => undefined) as typeof clearTimeout,
    });
    backend.onStatusChanged((event) =>
      statuses.push(`${event.id}:${event.status}`)
    );
    const ts = await backend.resolveForPath(
      "src/app.ts",
      roots,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    assert.ok("descriptor" in ts);
    await backend.getConnection(
      ts.descriptor,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    backend.documentOpened(ts.descriptor);
    children[0].emit("exit", 1, null);
    const json = await backend.resolveForPath(
      "package.json",
      roots,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    assert.ok("descriptor" in json);
    await backend.getConnection(
      json.descriptor,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    backend.documentOpened(json.descriptor);
    timers.splice(0).forEach((timer) => timer());
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(backend.runningServerCount, 1);
    assert.strictEqual(children.length, 2);
    assert.ok(statuses.includes("typescript-language-server:stopped"));
    backend.documentClosed(json.descriptor);
    await backend.dispose();
  });

  test("a start in flight during dispose leaves no running server", async () => {
    let releaseInitialize: (value: unknown) => void = () => undefined;
    const backend = createBackend({
      initializeResponse: new Promise((resolve) => {
        releaseInitialize = resolve;
      }),
    });
    const ts = await backend.resolveForPath(
      "src/app.ts",
      roots,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    assert.ok("descriptor" in ts);
    const connecting = backend.getConnection(
      ts.descriptor,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    await new Promise((resolve) => setImmediate(resolve));
    const disposing = backend.dispose();
    releaseInitialize({ capabilities: {} });
    await assert.rejects(connecting);
    await disposing;
    assert.strictEqual(backend.runningServerCount, 0);
  });

  test("restarts a crashed server with a backoff while a document remains open", async () => {
    const timers: Array<() => void> = [];
    const children: EventEmitter[] = [];
    const backend = createBackend({
      children,
      setTimer: ((callback: () => void) => {
        timers.push(callback);
        return callback as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimer: (() => undefined) as typeof clearTimeout,
    });
    const result = await backend.resolveForPath(
      "src/app.ts",
      roots,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    assert.ok("descriptor" in result);
    await backend.getConnection(
      result.descriptor,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    backend.documentOpened(result.descriptor);
    children[0].emit("exit", 1, null);
    assert.strictEqual(
      (children[0] as EventEmitter & { exitCode: number | null }).exitCode,
      0,
      "crashed child is killed before restart"
    );
    assert.strictEqual(backend.runningServerCount, 0);
    assert.ok(
      timers.length >= 2,
      "idle callback and crash retry should both be queued"
    );
    await backend.getConnection(
      result.descriptor,
      LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
    );
    timers.at(-2)?.();
    assert.strictEqual(backend.runningServerCount, 1);
    assert.strictEqual(children.length, 2);
    children[1].emit("exit", 1, null);
    assert.ok(
      timers.length >= 3,
      "restart policy survives the new instance's zero document count"
    );
    timers.at(-1)?.();
    for (let attempt = 0; attempt < 20 && children.length < 3; attempt += 1)
      await Promise.resolve();
    assert.strictEqual(children.length, 3);
    await backend.dispose();
    children[0].emit("exit", 1, null);
  });

  test("coalesces an editor lookup with a restart already in progress", async () => {
    const children: EventEmitter[] = [];
    const backend = createBackend({ children });
    const host = new LanguageIntelligenceHost({
      backend,
      workspaceRoot: root,
      namedWorkspaceRoots: [],
      isWorkspaceTrusted: () => true,
    });
    try {
      const first = await host.lookupSession(
        "src/app.ts",
        LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
      );
      assert.ok(first.session);
      const restart = host.restartServer("typescript-language-server");
      const lookup = host.lookupSession(
        "src/app.ts",
        LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
      );
      const [, second] = await Promise.all([restart, lookup]);
      assert.ok(second.session);
      assert.deepStrictEqual(second.session.capabilities, {
        completionProvider: {},
        hoverProvider: true,
      });
      assert.strictEqual(children.length, 2);
    } finally {
      await host.dispose();
    }
  });

  test("proxies TypeScript completion and hover when installed", async function () {
    if (!hasTypeScriptLanguageServer()) this.skip();
    const workspaceRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-lsp-integration-")
    );
    const text =
      'const broken: number = "bad";\nconst message = "hello";\nmessage.\n';
    await fs.promises.writeFile(
      path.join(workspaceRoot, "main.ts"),
      text,
      "utf8"
    );
    await fs.promises.writeFile(
      path.join(workspaceRoot, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true },
        include: ["main.ts"],
      }),
      "utf8"
    );
    const backend = new ManagedLanguageServerBackend({
      workspaceRoot,
      userSettings: () => ({
        languageServers: {
          ...CTRLYOKE_SETTINGS_DEFAULTS.languageServers,
          use: { typescript: "typescript-language-server" },
        },
      }),
      workspaceSettings: () => ({
        languageServers: CTRLYOKE_SETTINGS_DEFAULTS.languageServers,
      }),
      approvalStore: { get: () => undefined, update: async () => undefined },
      interactionPort: {
        canPrompt: () => false,
        requestBatchApproval: async () => undefined,
        requestChoice: async () => undefined,
      },
      isWorkspaceTrusted: () => true,
    });
    const host = new LanguageIntelligenceHost({
      backend,
      workspaceRoot,
      namedWorkspaceRoots: [
        { name: path.basename(workspaceRoot), fsPath: workspaceRoot },
      ],
      isWorkspaceTrusted: () => true,
    });
    let proxy: Awaited<ReturnType<LanguageIntelligenceHost["createProxy"]>>;
    try {
      const lookup = await host.lookupSession(
        "main.ts",
        LANGUAGE_SERVER_REQUEST_ORIGINS.EDITOR
      );
      assert.ok(lookup.session);
      const received: Array<Record<string, unknown>> = [];
      proxy = await host.createProxy(
        lookup.session.id,
        (message) => {
          const record = message as Record<string, unknown>;
          received.push(record);
          if (record.method && record.id !== undefined) {
            queueMicrotask(
              () =>
                void proxy?.handleMessage({
                  jsonrpc: "2.0",
                  id: record.id as string | number,
                  result:
                    record.method === "workspace/configuration" ? [] : null,
                })
            );
          }
        },
        async () => true
      );
      assert.ok(proxy);
      const uri = pathToFileURL(path.join(workspaceRoot, "main.ts")).toString();
      await proxy?.handleMessage({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          processId: process.pid,
          rootUri: pathToFileURL(workspaceRoot).toString(),
          capabilities: {},
        },
      });
      await proxy?.handleMessage({
        jsonrpc: "2.0",
        method: "initialized",
        params: {},
      });
      await proxy?.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "typescript", version: 1, text },
        },
      });
      await proxy?.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didChange",
        params: {
          textDocument: { uri, version: 2 },
          contentChanges: [{ text }],
        },
      });
      await proxy?.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didSave",
        params: { textDocument: { uri }, text },
      });
      await proxy?.handleMessage({
        jsonrpc: "2.0",
        id: "hover",
        method: "textDocument/hover",
        params: { textDocument: { uri }, position: { line: 1, character: 8 } },
      });
      const hover = await waitForMessage(
        received,
        (message) => message.id === "hover"
      );
      assert.ok(hover.result);
      await proxy?.handleMessage({
        jsonrpc: "2.0",
        id: "completion",
        method: "textDocument/completion",
        params: { textDocument: { uri }, position: { line: 2, character: 8 } },
      });
      const completion = await waitForMessage(
        received,
        (message) => message.id === "completion"
      );
      const items = Array.isArray(completion.result)
        ? completion.result
        : (completion.result as { items?: unknown[] } | undefined)?.items;
      assert.ok(
        items?.some((item) => (item as { label?: string }).label === "charAt")
      );
    } finally {
      proxy?.dispose();
      await host.dispose();
      await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

function hasTypeScriptLanguageServer(): boolean {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
  const extensions = process.platform === "win32" ? ["", ".cmd", ".exe"] : [""];
  return pathEntries.some((directory) =>
    extensions.some((extension) =>
      fs.existsSync(
        path.join(directory, `typescript-language-server${extension}`)
      )
    )
  );
}

async function waitForCondition(
  condition: () => boolean,
  description: string
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function waitForMessage(
  messages: Array<Record<string, unknown>>,
  predicate: (message: Record<string, unknown>) => boolean
): Promise<Record<string, unknown>> {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    const message = messages.find(predicate);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for TypeScript language-server response.");
}

function createBackend(
  options: {
    root?: string;
    trusted?: boolean;
    onSpawn?: () => void;
    store?: Map<string, unknown>;
    interaction?: UserInteractionPort;
    workspaceSettings?: typeof CTRLYOKE_SETTINGS_DEFAULTS.languageServers;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
    maxRunning?: number;
    children?: EventEmitter[];
    ignoreShutdown?: boolean;
    ignoreExit?: boolean;
    initializeResponse?: Promise<unknown>;
    installed?: boolean;
  } = {}
): ManagedLanguageServerBackend {
  const state = options.store ?? new Map<string, unknown>();
  const child = () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let server: ReturnType<typeof createMessageConnection> | undefined;
    const emitter = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      exitCode: number | null;
      killCount: number;
      kill(): boolean;
    };
    Object.assign(emitter, {
      stdin,
      stdout,
      stderr,
      exitCode: null,
      killCount: 0,
      kill: () => {
        emitter.killCount += 1;
        emitter.exitCode = 0;
        server?.dispose();
        stdin.destroy();
        stdout.destroy();
        stderr.destroy();
        emitter.emit("exit", 0, null);
        return true;
      },
    });
    options.children?.push(emitter);
    emitter.once("exit", () => {
      server?.dispose();
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
    });
    server = createMessageConnection(
      new StreamMessageReader(stdin),
      new StreamMessageWriter(stdout)
    );
    server.onRequest(
      "initialize",
      () =>
        options.initializeResponse ?? {
          capabilities: { completionProvider: {}, hoverProvider: true },
        }
    );
    server.onRequest("textDocument/hover", () => ({ contents: "hover" }));
    server.onRequest("shutdown", () =>
      options.ignoreShutdown
        ? new Promise<null>((resolve) => setTimeout(() => resolve(null), 25))
        : null
    );
    server.onNotification("exit", () => {
      if (!options.ignoreExit)
        setImmediate(() => {
          emitter.exitCode = 0;
          emitter.emit("exit", 0, null);
        });
    });
    server.listen();
    return emitter;
  };
  const languageServers =
    options.workspaceSettings ?? CTRLYOKE_SETTINGS_DEFAULTS.languageServers;
  return new ManagedLanguageServerBackend({
    workspaceRoot: options.root ?? "/workspace",
    userSettings: () => ({
      languageServers: {
        ...CTRLYOKE_SETTINGS_DEFAULTS.languageServers,
        maxRunning:
          options.maxRunning ??
          CTRLYOKE_SETTINGS_DEFAULTS.languageServers.maxRunning,
      },
    }),
    workspaceSettings: () => ({ languageServers }),
    approvalStore: {
      get: <T>(key: string) => state.get(key) as T | undefined,
      update: async (key: string, value: unknown) => {
        state.set(key, value);
      },
    },
    interactionPort: options.interaction ?? {
      canPrompt: () => false,
      requestBatchApproval: async () => undefined,
      requestChoice: async () => undefined,
    },
    isWorkspaceTrusted: () => options.trusted ?? true,
    resolverDependencies: {
      fileExists: async () => options.installed !== false,
      resolveCommand: async (command, args) => ({
        command,
        args,
        displayCommand: command,
        launcherKind: "direct",
      }),
    },
    spawnProcess: ((..._args: unknown[]) => {
      options.onSpawn?.();
      return child() as never;
    }) as typeof import("child_process").spawn,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
    pathEntries: ["/bin"],
  });
}
