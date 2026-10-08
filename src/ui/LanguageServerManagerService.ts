import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { configService } from "../config/CtrlYokeConfigService";
import { resolveCliCommand } from "../core/harness/shared/CliLauncherResolver";
import { LANGUAGE_SERVER_INSTALL_KINDS, MESSAGE_TYPES, SETTING_SCOPES, type SettingWriteScope } from "../types/DashboardConstants";
import type { LanguageServerDefinition } from "../types/CtrlYokeSettings";
import type { DeleteLspDefinitionMessage, ExportLspDefinitionMessage, InstallLspServerMessage, LanguageServerProbeResult, RequestLspLocalScanMessage, SaveLspDefinitionMessage } from "../types/WebviewMessageTypes";
import type { RestartLspServerMessage } from "../types/WebviewMessageTypes";
import { LANGUAGE_SERVER_CATALOG } from "../server/lsp/LanguageServerCatalog";
import type { LanguageIntelligenceHost } from "../server/lsp/LanguageIntelligenceHost";
import type { LanguageServerStatusChange } from "../server/lsp/ManagedLanguageServerBackend";
import { safeDiscoverLocalLanguageServers } from "../utils/LspDiscoveryUtils";
import { HarnessLspExporter } from "../utils/HarnessLspExporter";
import { ctrlyokeStateHome } from "../utils/ProjectStatePaths";
import type { WebviewClientContext } from "./WebviewClientContext";

export type LanguageServerSpawn = typeof spawn;

export interface LanguageServerStatusSource {
  onStatusChanged(listener: (event: LanguageServerStatusChange) => void): { dispose(): void };
}

function getHostPlatform(): "win32" | "darwin" | "linux" {
  return process.platform === "win32" || process.platform === "darwin"
    ? process.platform
    : "linux";
}

function executablePath(name: string, entries: string[]): string | undefined {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const entry of entries) for (const extension of extensions) {
    const candidate = path.join(entry, `${name}${extension}`);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* not installed in this PATH entry */ }
  }
  return undefined;
}

function detectWorkspaceLanguages(root: string, definitions: readonly { definition: LanguageServerDefinition }[]): string[] {
  const languageByExtension = new Map<string, string>();
  for (const entry of LANGUAGE_SERVER_CATALOG) for (const extension of entry.extensions) {
    if (!languageByExtension.has(extension.toLowerCase())) languageByExtension.set(extension.toLowerCase(), entry.languages[0] ?? "");
  }
  languageByExtension.set("tsx", "typescriptreact");
  languageByExtension.set("jsx", "javascriptreact");
  languageByExtension.set("ts", "typescript");
  languageByExtension.set("js", "javascript");
  for (const { definition } of definitions) for (const extension of definition.extensions) {
    if (definition.languages[0]) languageByExtension.set(extension.toLowerCase(), definition.languages[0]);
  }
  const detected = new Set<string>();
  const ignored = new Set([".git", "node_modules", ".ctrlyoke", "vendor", "dist", "build"]);
  const pending = [root];
  let visited = 0;
  while (pending.length && visited < 5000) {
    const directory = pending.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++visited >= 5000) break;
      if (entry.isDirectory() && !ignored.has(entry.name)) pending.push(path.join(directory, entry.name));
      else if (entry.isFile()) {
        const language = languageByExtension.get(path.extname(entry.name).slice(1).toLowerCase());
        if (language) detected.add(language);
      }
    }
  }
  return [...detected].sort();
}

export class LanguageServerManagerService {
  private readonly clients = new Map<string, WebviewClientContext>();
  private readonly statuses = new Map<string, LanguageServerStatusChange>();
  private definitions: Array<{ id: string; definition: LanguageServerDefinition; scope: SettingWriteScope }> = [];
  private probes: LanguageServerProbeResult[] = [];
  private host?: LanguageIntelligenceHost;
  private statusSubscription?: { dispose(): void };

  constructor(private readonly getWorkspaceRoot: () => string, private readonly spawnProcess: LanguageServerSpawn = spawn) {}

  bindHost(host: LanguageIntelligenceHost | undefined): void {
    this.host = host;
    this.bindStatusSource(host);
  }

  bindStatusSource(source: LanguageServerStatusSource | undefined): void {
    this.statusSubscription?.dispose();
    this.statusSubscription = source?.onStatusChanged((event) => this.pushStatus(event));
  }

  dispose(): void { this.statusSubscription?.dispose(); this.clients.clear(); }

  disposeClient(clientId: string): void { this.clients.delete(clientId); }
  closeManager(clientId: string): void { this.clients.delete(clientId); }

  async handleRequestServers(ctx: WebviewClientContext): Promise<void> {
    this.clients.set(ctx.clientId, ctx);
    const [definitions, probes] = await Promise.all([this.readDefinitions(), this.probeCatalog()]);
    this.definitions = definitions; this.probes = probes;
    ctx.emit(this.createUpdate(definitions, probes));
  }

  async handleRequestLocalScan(ctx: WebviewClientContext, _message: RequestLspLocalScanMessage): Promise<void> {
    const result = await safeDiscoverLocalLanguageServers(this.getWorkspaceRoot());
    ctx.emit({ type: MESSAGE_TYPES.LSP_LOCAL_SCAN_RESULT, servers: result.servers, ...(result.error ? { error: result.error } : {}) });
  }

  async handleExport(ctx: WebviewClientContext, message: ExportLspDefinitionMessage): Promise<void> {
    try {
      const definition = this.getScopedLanguageServers(message.scope).definitions[message.id];
      if (!definition) throw new Error(`Language server definition "${message.id}" was not found in ${message.scope} settings.`);
      await new HarnessLspExporter(this.getWorkspaceRoot() || undefined).export(message.id, definition, message.targetId, message.scope);
      ctx.emit({ type: MESSAGE_TYPES.LSP_EXPORT_RESULT, id: message.id, targetId: message.targetId, scope: message.scope, success: true });
    } catch (error) {
      ctx.emit({ type: MESSAGE_TYPES.LSP_EXPORT_RESULT, id: message.id, targetId: message.targetId, scope: message.scope, success: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async handleSave(ctx: WebviewClientContext, message: SaveLspDefinitionMessage): Promise<void> {
    await this.validateAndWrite(message.id, message.definition, message.scope);
    await this.emitUpdate(ctx);
  }

  async handleDelete(ctx: WebviewClientContext, message: DeleteLspDefinitionMessage): Promise<void> {
    const settings = this.getScopedLanguageServers(message.scope);
    delete settings.definitions[message.id];
    await configService.set("languageServers.definitions", settings.definitions, message.scope);
    await this.emitUpdate(ctx);
  }

  async handleInstall(ctx: WebviewClientContext, message: InstallLspServerMessage): Promise<void> {
    const catalog = LANGUAGE_SERVER_CATALOG.find((entry) => entry.id === message.id);
    if (!catalog || catalog.install.kind !== LANGUAGE_SERVER_INSTALL_KINDS.NPM) throw new Error("Only catalog npm packages can be installed here.");
    const packageNames = catalog.install.packages;
    const installDirectory = path.join(ctrlyokeStateHome(), "lsp");
    const args = ["install", "--prefix", installDirectory, ...packageNames];
    const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    const npm = executablePath("npm", pathEntries);
    const copyableCommand = `npm ${args.map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(" ")}`;
    if (!npm) {
      ctx.emit({ type: MESSAGE_TYPES.LSP_INSTALL_PROGRESS, id: message.id, error: "npm was not found on PATH.", copyableCommand, complete: true });
      return;
    }
    const accepted = await ctx.interactionPort?.requestChoice({
      id: `lsp-install-${message.id}-${Date.now()}`,
      title: "Install language server packages?",
      detail: `Packages: ${packageNames.join(", ")}\nInstall directory: ${installDirectory}`,
      choices: [{ value: "install", label: "Install" }, { value: "cancel", label: "Cancel" }],
    });
    if (accepted !== "install") return;
    ctx.emit({ type: MESSAGE_TYPES.LSP_INSTALL_PROGRESS, id: message.id, output: `Installing ${packageNames.join(", ")} in ${installDirectory}` });
    await fs.promises.mkdir(installDirectory, { recursive: true });
    const resolved = await resolveCliCommand(path.basename(npm, path.extname(npm)), args);
    await new Promise<void>((resolve) => {
      let child: ChildProcess;
      try { child = this.spawnProcess(resolved.command, resolved.args, { cwd: this.getWorkspaceRoot(), stdio: ["ignore", "pipe", "pipe"], ...(resolved.requiresShellVerbatimArgs ? { windowsVerbatimArguments: true } : {}) }); }
      catch (error) { ctx.emit({ type: MESSAGE_TYPES.LSP_INSTALL_PROGRESS, id: message.id, error: String(error), complete: true }); resolve(); return; }
      const send = (chunk: Buffer | string): void => ctx.emit({ type: MESSAGE_TYPES.LSP_INSTALL_PROGRESS, id: message.id, output: chunk.toString() });
      child.stdout?.on("data", send); child.stderr?.on("data", send);
      child.once("error", (error) => { ctx.emit({ type: MESSAGE_TYPES.LSP_INSTALL_PROGRESS, id: message.id, error: error.message, complete: true }); resolve(); });
      child.once("close", (code) => { ctx.emit({ type: MESSAGE_TYPES.LSP_INSTALL_PROGRESS, id: message.id, complete: true, ...(code === 0 ? {} : { error: `npm install exited with code ${code}.` }) }); resolve(); });
    });
    await this.emitUpdate(ctx);
  }

  async handleRestart(ctx: WebviewClientContext, message: RestartLspServerMessage): Promise<void> {
    try {
      if (!this.host) throw new Error("The language server host is unavailable.");
      await this.host.restartServer(message.id);
    } catch (error) {
      ctx.emit({ type: MESSAGE_TYPES.WORKFLOW_ACTION_FAILED, action: "restart language server", error: error instanceof Error ? error.message : String(error) });
    }
  }

  async handleRequestApproval(ctx: WebviewClientContext): Promise<void> {
    try {
      if (!this.host) throw new Error("The language server host is unavailable.");
      await this.host.requestWorkspaceApproval();
      await this.emitUpdate(ctx);
    } catch (error) {
      ctx.emit({ type: MESSAGE_TYPES.WORKFLOW_ACTION_FAILED, action: "approve language servers", error: error instanceof Error ? error.message : String(error) });
    }
  }

  async handleStop(ctx: WebviewClientContext, id: string): Promise<void> {
    try {
      if (!this.host) throw new Error("The language server host is unavailable.");
      await this.host.stopServer(id);
    } catch (error) {
      ctx.emit({ type: MESSAGE_TYPES.WORKFLOW_ACTION_FAILED, action: "stop language server", error: error instanceof Error ? error.message : String(error) });
    }
  }

  private pushStatus(event: LanguageServerStatusChange): void {
    this.statuses.set(`${event.id}\n${path.resolve(event.rootPath)}`, event);
    const message = this.createUpdate(this.definitions, this.probes);
    for (const client of this.clients.values()) client.emit(message);
  }

  private async emitUpdate(ctx: WebviewClientContext): Promise<void> {
    this.definitions = await this.readDefinitions(); this.probes = await this.probeCatalog();
    ctx.emit(this.createUpdate(this.definitions, this.probes));
  }

  private createUpdate(definitions: Array<{ id: string; definition: LanguageServerDefinition; scope: SettingWriteScope }>, probes: LanguageServerProbeResult[]) {
    return { type: MESSAGE_TYPES.LSP_SERVERS_UPDATE, hostPlatform: getHostPlatform(), definitions, catalog: LANGUAGE_SERVER_CATALOG, probes, statuses: [...this.statuses.values()], detectedLanguages: detectWorkspaceLanguages(this.getWorkspaceRoot(), definitions), approvedWorkspaceDefinitionIds: this.host?.getApprovedWorkspaceDefinitionIds() ?? [] };
  }

  private async readDefinitions(): Promise<Array<{ id: string; definition: LanguageServerDefinition; scope: SettingWriteScope }>> {
    const entries: Array<{ id: string; definition: LanguageServerDefinition; scope: SettingWriteScope }> = [];
    for (const scope of [SETTING_SCOPES.WORKSPACE, SETTING_SCOPES.USER] as const) {
      const definitions = this.getScopedLanguageServers(scope).definitions;
      for (const [id, definition] of Object.entries(definitions)) entries.push({ id, definition, scope });
    }
    return entries;
  }

  private getScopedLanguageServers(scope: SettingWriteScope): { definitions: Record<string, LanguageServerDefinition> } {
    const value = configService.getScoped("languageServers", scope);
    const definitions: Record<string, LanguageServerDefinition> = {};
    for (const [id, definition] of Object.entries(value?.definitions ?? {})) {
      if (
        definition &&
        Array.isArray(definition.command) &&
        Array.isArray(definition.languages) &&
        Array.isArray(definition.extensions) &&
        Array.isArray(definition.rootMarkers)
      ) definitions[id] = definition as LanguageServerDefinition;
    }
    return { definitions };
  }

  private async validateAndWrite(id: string, definition: LanguageServerDefinition, scope: SettingWriteScope): Promise<void> {
    if (!id.trim() || !Array.isArray(definition.command) || definition.command.length === 0 || !Array.isArray(definition.languages) || !Array.isArray(definition.extensions)) throw new Error("A language server requires an id, command, languages, and extensions.");
    const current = this.getScopedLanguageServers(scope).definitions;
    await configService.set("languageServers.definitions", { ...current, [id]: definition }, scope);
  }

  private async probeCatalog(): Promise<LanguageServerProbeResult[]> {
    const root = this.getWorkspaceRoot();
    const dirs = [
      ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
      path.join(ctrlyokeStateHome(), "lsp", "node_modules", ".bin"),
      path.join(root, "node_modules", ".bin"),
    ];
    return LANGUAGE_SERVER_CATALOG.map((entry) => {
      const resolvedPath = executablePath(entry.command[0]!, dirs);
      return { id: entry.id, detected: Boolean(resolvedPath), ...(resolvedPath ? { resolvedPath } : {}) };
    });
  }
}
