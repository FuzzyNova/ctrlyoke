import * as assert from "assert";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PassThrough } from "stream";
import { pathToFileURL } from "url";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "../../types/CtrlYokeSettings";
import { ManagedLanguageServerBackend } from "../../server/lsp/ManagedLanguageServerBackend";
import { LanguageIntelligenceHost } from "../../server/lsp/LanguageIntelligenceHost";
import type { UserInteractionPort } from "../../ui/UserInteractionPort";

suite("ManagedLanguageServerBackend", () => {
  const root = "/workspace";
  const roots = { workspaceRoot: root, namedRoots: [] };

  test("trust gate prevents resolution and spawning", async () => {
    let spawnCount = 0;
    const backend = createBackend({ trusted: false, onSpawn: () => { spawnCount += 1; } });
    const result = await backend.resolveForPath("src/app.ts", roots);
    assert.deepStrictEqual(result, { reason: "untrusted" });
    assert.strictEqual(spawnCount, 0);
    await backend.dispose();
  });

  test("requires approval, remembers it, and asks again when executable fields change", async () => {
    let decisions = 0;
    const store = new Map<string, unknown>();
    const interaction: UserInteractionPort = {
      canPrompt: () => true,
      requestChoice: async () => undefined,
      requestBatchApproval: async (request) => {
        decisions += 1;
        return { approvedValues: request.items.map((item) => item.value), deniedValues: [] };
      },
    };
    const settings = { ...CTRLYOKE_SETTINGS_DEFAULTS.languageServers, definitions: { custom: { command: ["custom-lsp", "--stdio"], languages: ["typescript"], extensions: ["ts"], rootMarkers: [], env: { MODE: "one" } } }, use: { typescript: "custom" } };
    const backend = createBackend({ store, interaction, workspaceSettings: settings });
    const result = await backend.resolveForPath("src/app.ts", roots);
    assert.ok("descriptor" in result);
    assert.strictEqual(decisions, 1);
    await backend.resolveForPath("src/app.ts", roots);
    assert.strictEqual(decisions, 1);
    settings.definitions.custom.env.MODE = "two";
    await backend.resolveForPath("src/app.ts", roots);
    assert.strictEqual(decisions, 2);
    await backend.dispose();
  });

  test("idle shutdown never stops a server while a document is open", async () => {
    const timers: Array<() => void> = [];
    const backend = createBackend({ setTimer: ((callback: () => void) => { timers.push(callback); return callback as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout, clearTimer: (() => undefined) as typeof clearTimeout });
    const result = await backend.resolveForPath("src/app.ts", roots);
    assert.ok("descriptor" in result);
    await backend.getConnection(result.descriptor);
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
    const ts = await backend.resolveForPath("src/app.ts", roots);
    assert.ok("descriptor" in ts);
    await backend.getConnection(ts.descriptor);
    backend.documentOpened(ts.descriptor);
    const json = await backend.resolveForPath("package.json", roots);
    assert.deepStrictEqual(json, { reason: "limit reached" });
    backend.documentClosed(ts.descriptor);
    await backend.dispose();
  });

  test("evicts the least recently used idle server when the cap is full", async () => {
    const backend = createBackend({ maxRunning: 1 });
    const statuses: string[] = [];
    backend.onStatusChanged((status) => statuses.push(`${status.id}:${status.status}`));
    const ts = await backend.resolveForPath("src/app.ts", roots);
    assert.ok("descriptor" in ts);
    await backend.getConnection(ts.descriptor);
    const json = await backend.resolveForPath("package.json", roots);
    assert.ok("descriptor" in json);
    assert.ok(statuses.includes("typescript-language-server:stopped"));
    await backend.getConnection(json.descriptor);
    assert.strictEqual(backend.runningServerCount, 1);
    await backend.dispose();
  });

  test("restarts a crashed server with a backoff while a document remains open", async () => {
    const timers: Array<() => void> = [];
    const children: EventEmitter[] = [];
    const backend = createBackend({ children, setTimer: ((callback: () => void) => { timers.push(callback); return callback as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout, clearTimer: (() => undefined) as typeof clearTimeout });
    const result = await backend.resolveForPath("src/app.ts", roots);
    assert.ok("descriptor" in result);
    await backend.getConnection(result.descriptor);
    backend.documentOpened(result.descriptor);
    children[0].emit("exit", 1, null);
    assert.strictEqual(backend.runningServerCount, 0);
    assert.ok(timers.length >= 2, "idle callback and crash retry should both be queued");
    timers.at(-1)?.();
    for (let attempt = 0; attempt < 20 && backend.runningServerCount === 0; attempt += 1) await Promise.resolve();
    assert.strictEqual(backend.runningServerCount, 1);
    assert.strictEqual(children.length, 2);
    await backend.dispose();
    children[0].emit("exit", 1, null);
  });

  test("proxies TypeScript completion and hover when installed", async function () {
    if (!hasTypeScriptLanguageServer()) this.skip();
    const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-lsp-integration-"));
    const text = 'const broken: number = "bad";\nconst message = "hello";\nmessage.\n';
    await fs.promises.writeFile(path.join(workspaceRoot, "main.ts"), text, "utf8");
    await fs.promises.writeFile(path.join(workspaceRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["main.ts"] }), "utf8");
    const backend = new ManagedLanguageServerBackend({
      workspaceRoot,
      userSettings: () => ({ languageServers: { ...CTRLYOKE_SETTINGS_DEFAULTS.languageServers, use: { typescript: "typescript-language-server" } } }),
      workspaceSettings: () => ({ languageServers: CTRLYOKE_SETTINGS_DEFAULTS.languageServers }),
      approvalStore: { get: () => undefined, update: async () => undefined },
      interactionPort: { canPrompt: () => false, requestBatchApproval: async () => undefined, requestChoice: async () => undefined },
      isWorkspaceTrusted: () => true,
    });
    const host = new LanguageIntelligenceHost({ backend, workspaceRoot, namedWorkspaceRoots: [{ name: path.basename(workspaceRoot), fsPath: workspaceRoot }], isWorkspaceTrusted: () => true });
    let proxy: Awaited<ReturnType<LanguageIntelligenceHost["createProxy"]>>;
    try {
      const lookup = await host.lookupSession("main.ts");
      assert.ok(lookup.session);
      const received: Array<Record<string, unknown>> = [];
      proxy = await host.createProxy(lookup.session.id, (message) => {
        const record = message as Record<string, unknown>;
        received.push(record);
        if (record.method && record.id !== undefined) {
          queueMicrotask(() => void proxy?.handleMessage({ jsonrpc: "2.0", id: record.id as string | number, result: record.method === "workspace/configuration" ? [] : null }));
        }
      }, async () => true);
      assert.ok(proxy);
      const uri = pathToFileURL(path.join(workspaceRoot, "main.ts")).toString();
      await proxy?.handleMessage({ jsonrpc: "2.0", id: "initialize", method: "initialize", params: { processId: process.pid, rootUri: pathToFileURL(workspaceRoot).toString(), capabilities: {} } });
      await proxy?.handleMessage({ jsonrpc: "2.0", method: "initialized", params: {} });
      await proxy?.handleMessage({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "typescript", version: 1, text } } });
      await proxy?.handleMessage({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri, version: 2 }, contentChanges: [{ text }] } });
      await proxy?.handleMessage({ jsonrpc: "2.0", method: "textDocument/didSave", params: { textDocument: { uri }, text } });
      await proxy?.handleMessage({ jsonrpc: "2.0", id: "hover", method: "textDocument/hover", params: { textDocument: { uri }, position: { line: 1, character: 8 } } });
      const hover = await waitForMessage(received, (message) => message.id === "hover");
      assert.ok(hover.result);
      await proxy?.handleMessage({ jsonrpc: "2.0", id: "completion", method: "textDocument/completion", params: { textDocument: { uri }, position: { line: 2, character: 8 } } });
      const completion = await waitForMessage(received, (message) => message.id === "completion");
      const items = Array.isArray(completion.result) ? completion.result : (completion.result as { items?: unknown[] } | undefined)?.items;
      assert.ok(items?.some((item) => (item as { label?: string }).label === "charAt"));
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
  return pathEntries.some((directory) => extensions.some((extension) => fs.existsSync(path.join(directory, `typescript-language-server${extension}`))));
}

async function waitForMessage(messages: Array<Record<string, unknown>>, predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    const message = messages.find(predicate);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for TypeScript language-server response.");
}

function createBackend(options: {
  trusted?: boolean;
  onSpawn?: () => void;
  store?: Map<string, unknown>;
  interaction?: UserInteractionPort;
  workspaceSettings?: typeof CTRLYOKE_SETTINGS_DEFAULTS.languageServers;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  maxRunning?: number;
  children?: EventEmitter[];
} = {}): ManagedLanguageServerBackend {
  const state = options.store ?? new Map<string, unknown>();
  const child = () => {
    const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
    let server: ReturnType<typeof createMessageConnection> | undefined;
    const emitter = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; exitCode: number | null; kill(): boolean };
    Object.assign(emitter, { stdin, stdout, stderr, exitCode: null, kill: () => { emitter.exitCode = 0; server?.dispose(); stdin.destroy(); stdout.destroy(); stderr.destroy(); emitter.emit("exit", 0, null); return true; } });
    options.children?.push(emitter);
    emitter.once("exit", () => { server?.dispose(); stdin.destroy(); stdout.destroy(); stderr.destroy(); });
    server = createMessageConnection(new StreamMessageReader(stdin), new StreamMessageWriter(stdout));
    server.onRequest("initialize", () => ({ capabilities: { completionProvider: {}, hoverProvider: true } }));
    server.onRequest("shutdown", () => null);
    server.onNotification("exit", () => { emitter.exitCode = 0; emitter.emit("exit", 0, null); });
    server.listen();
    return emitter;
  };
  const languageServers = options.workspaceSettings ?? CTRLYOKE_SETTINGS_DEFAULTS.languageServers;
  return new ManagedLanguageServerBackend({
    workspaceRoot: "/workspace",
    userSettings: () => ({ languageServers: { ...CTRLYOKE_SETTINGS_DEFAULTS.languageServers, maxRunning: options.maxRunning ?? CTRLYOKE_SETTINGS_DEFAULTS.languageServers.maxRunning } }),
    workspaceSettings: () => ({ languageServers }),
    approvalStore: { get: <T>(key: string) => state.get(key) as T | undefined, update: async (key: string, value: unknown) => { state.set(key, value); } },
    interactionPort: options.interaction ?? { canPrompt: () => false, requestBatchApproval: async () => undefined, requestChoice: async () => undefined },
    isWorkspaceTrusted: () => options.trusted ?? true,
    resolverDependencies: { fileExists: async () => true, resolveCommand: async (command, args) => ({ command, args, displayCommand: command, launcherKind: "direct" }) },
    spawnProcess: ((..._args: unknown[]) => { options.onSpawn?.(); return child() as never; }) as typeof import("child_process").spawn,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
    pathEntries: ["/bin"],
  });
}
