import * as assert from "assert";
import { EventEmitter } from "events";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { spawn, type ChildProcess } from "child_process";
import { setup, suite, teardown, test } from "mocha";
import { configService, type ConfigBackend } from "../../config/CtrlYokeConfigService";
import { escapeCmdArgument } from "../../core/harness/shared/WindowsCmdEscaping";
import type { PartialCtrlYokeSettings } from "../../types/CtrlYokeSettings";
import { LANGUAGE_SERVER_CATALOG } from "../../server/lsp/LanguageServerCatalog";
import { MESSAGE_TYPES, SETTING_SCOPES } from "../../types/DashboardConstants";
import type { LanguageServerStatusChange } from "../../server/lsp/ManagedLanguageServerBackend";
import { LanguageServerManagerService, type LanguageServerStatusSource } from "../../ui/LanguageServerManagerService";
import type { WebviewClientContext } from "../../ui/WebviewClientContext";

function backend(data: PartialCtrlYokeSettings, onSet?: (path: string, value: unknown) => void): ConfigBackend {
  return { getAll: () => data, set: async (key, value) => onSet?.(key, value) };
}

suite("LanguageServerManagerService", () => {
  let userSettings: PartialCtrlYokeSettings;
  let workspaceSettings: PartialCtrlYokeSettings;
  let tempRoot: string;
  let originalPath: string | undefined;
  let originalStateHome: string | undefined;
  let binDirectory: string;
  const messages: unknown[] = [];
  const context = (clientId = "browser:1"): WebviewClientContext => ({
    clientId,
    postMessage: (message) => messages.push(message),
    emit: (message) => messages.push(message),
    interactionPort: { canPrompt: () => true, requestBatchApproval: async () => undefined, requestChoice: async () => "install" },
  });

  setup(async () => {
    userSettings = {};
    workspaceSettings = {};
    configService.setUserBackend(backend(userSettings));
    configService.setWorkspaceBackend(backend(workspaceSettings));
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cy lsp manager-"));
    originalPath = process.env.PATH;
    originalStateHome = process.env.CTRLYOKE_HOME;
    binDirectory = path.join(tempRoot, "program files");
    process.env.PATH = `${binDirectory}${path.delimiter}${originalPath ?? ""}`;
    process.env.CTRLYOKE_HOME = path.join(tempRoot, "state home");
    await fs.mkdir(binDirectory, { recursive: true });
    messages.length = 0;
  });

  teardown(async () => {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalStateHome === undefined) delete process.env.CTRLYOKE_HOME; else process.env.CTRLYOKE_HOME = originalStateHome;
    configService.setUserBackend(backend({}));
    configService.setWorkspaceBackend(backend({}));
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test("saves definitions to the requested scope", async () => {
    let saved: unknown;
    configService.setUserBackend(backend(userSettings, (_key, value) => { saved = value; }));
    const service = new LanguageServerManagerService(() => tempRoot);
    const definition = { command: ["pyright-langserver", "--stdio"], languages: ["python"], extensions: ["py"], rootMarkers: [] };
    await service.handleSave(context(), { type: MESSAGE_TYPES.SAVE_LSP_DEFINITION, id: "pyright-custom", definition, scope: SETTING_SCOPES.USER });
    assert.deepStrictEqual(saved, { "pyright-custom": definition });
    assert.ok(messages.some((message) => (message as { type?: string }).type === MESSAGE_TYPES.LSP_SERVERS_UPDATE));
    service.dispose();
  });

  test("pushes live status to clients that requested the manager", async () => {
    const service = new LanguageServerManagerService(() => tempRoot);
    const listeners = new Set<(event: LanguageServerStatusChange) => void>();
    const statusSource: LanguageServerStatusSource = {
      onStatusChanged: (listener) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
    };
    service.bindStatusSource(statusSource);
    await service.handleRequestServers(context());
    const before = messages.length;
    for (const listener of listeners) listener({ id: "pyright", rootPath: tempRoot, status: "running" });
    assert.ok(messages.length > before);
    const pushed = messages[messages.length - 1] as { type: string; catalog: unknown[]; probes: unknown[]; statuses: Array<{ id: string; status: string }> };
    assert.strictEqual(pushed.type, MESSAGE_TYPES.LSP_SERVERS_UPDATE);
    assert.strictEqual(pushed.catalog.length, LANGUAGE_SERVER_CATALOG.length);
    assert.strictEqual(pushed.probes.length, LANGUAGE_SERVER_CATALOG.length);
    assert.deepStrictEqual(pushed.statuses.map(({ id, status }) => [id, status]), [["pyright", "running"]]);
    service.dispose();
  });

  test("constructs the approved npm install command and streams progress", async () => {
    const npmPath = path.join(binDirectory, process.platform === "win32" ? "npm.cmd" : "npm");
    await fs.writeFile(npmPath, "");
    let spawnedCommand = "";
    let spawnedArgs: readonly string[] = [];
    let spawnedOptions: Record<string, unknown> = {};
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter() });
    const fakeSpawn = ((file: string, args: readonly string[], options: Record<string, unknown>) => {
      spawnedCommand = file; spawnedArgs = args; spawnedOptions = options;
      queueMicrotask(() => { (child.stdout as EventEmitter).emit("data", "install output"); child.emit("close", 0); });
      return child;
    }) as typeof spawn;
    const service = new LanguageServerManagerService(() => tempRoot, fakeSpawn);
    await service.handleInstall(context(), { type: MESSAGE_TYPES.INSTALL_LSP_SERVER, id: "pyright" });
    const installDirectory = path.join(process.env.CTRLYOKE_HOME!, "lsp");
    assert.ok(process.platform !== "win32" || !spawnedCommand.toLowerCase().endsWith("npm.cmd"), "Windows batch launchers go through the shared resolver");
    const expectedInstallDirectory = process.platform === "win32"
      ? escapeCmdArgument(installDirectory, false)
      : installDirectory;
    assert.ok(spawnedArgs.join(" ").includes(expectedInstallDirectory), "the path with spaces stays one safely quoted argument");
    assert.ok(!("shell" in spawnedOptions));
    if (process.platform === "win32") assert.strictEqual(spawnedOptions.windowsVerbatimArguments, true);
    else assert.ok(spawnedArgs.includes("install"));
    assert.ok(spawnedArgs.some((arg) => arg.includes("pyright")));
    assert.ok(messages.some((message) => (message as { output?: string }).output === "install output"));
    service.dispose();
  });
});
