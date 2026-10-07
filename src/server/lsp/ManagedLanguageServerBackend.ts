import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import { CTRLYOKE_SETTINGS_DEFAULTS, type CtrlYokeGlobalSettings, type LanguageServerDefinition, type LanguageServersSettings } from "../../types/CtrlYokeSettings";
import type { KeyValueStore } from "../../core/HostPorts";
import type { UserInteractionPort } from "../../ui/UserInteractionPort";
import {
  createNodeLanguageServerResolverDependencies,
  resolveLanguageServer,
  type LanguageServerResolverDependencies,
  type ResolvedLanguageServer,
} from "./LanguageServerResolver";
import type { LanguageServerBackend, LanguageServerDescriptor, LanguageServerResolution } from "./LanguageServerBackend";
import { LANGUAGE_SERVER_RESOLUTION_REASONS } from "./LanguageServerBackend";
import type { WorkspacePathContext } from "./WorkspacePathContainment";
import { safeResolveWorkspacePath } from "./WorkspacePathContainment";
import { LANGUAGE_SERVER_CATALOG } from "./LanguageServerCatalog";

export type LanguageServerStatus = "running" | "starting" | "idle" | "stopped" | "not installed" | "limit reached" | "needs approval" | "crashed";
export interface LanguageServerStatusChange { readonly id: string; readonly rootPath: string; readonly status: LanguageServerStatus; readonly detail?: string; }
export interface ManagedLanguageServerBackendOptions {
  readonly workspaceRoot: string;
  readonly userSettings: () => Pick<CtrlYokeGlobalSettings, "languageServers">;
  readonly workspaceSettings: () => Pick<CtrlYokeGlobalSettings, "languageServers">;
  readonly approvalStore: KeyValueStore;
  readonly interactionPort: UserInteractionPort;
  readonly isWorkspaceTrusted: () => boolean;
  readonly pathEntries?: readonly string[];
  readonly toolBinDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly resolverDependencies?: LanguageServerResolverDependencies;
  readonly spawnProcess?: typeof spawn;
  readonly setTimer?: typeof setTimeout;
  readonly clearTimer?: typeof clearTimeout;
}

interface RunningServer { readonly key: string; readonly resolved: ResolvedLanguageServer; readonly descriptor: LanguageServerDescriptor; readonly connection: MessageConnection; readonly child: ChildProcess; openDocuments: number; lastUsed: number; idleTimer?: ReturnType<typeof setTimeout>; stderrLine?: string; intentionalStop: boolean; restartCount: number; }
const APPROVAL_KEY = "languageServers.workspaceDefinitionApprovals";

/** Spawns and supervises stdio language servers for a single workspace host. */
export class ManagedLanguageServerBackend implements LanguageServerBackend {
  private readonly servers = new Map<string, RunningServer>();
  private readonly statuses = new EventEmitter();
  private readonly roots: WorkspacePathContext;
  private readonly deps: LanguageServerResolverDependencies;
  private disposed = false;

  constructor(private readonly options: ManagedLanguageServerBackendOptions) {
    this.roots = { workspaceRoot: path.resolve(options.workspaceRoot), namedRoots: [] };
    this.deps = options.resolverDependencies ?? createNodeLanguageServerResolverDependencies();
  }

  onStatusChanged(listener: (event: LanguageServerStatusChange) => void): { dispose(): void } {
    this.statuses.on("change", listener);
    return { dispose: () => this.statuses.off("change", listener) };
  }

  get runningServerCount(): number { return this.servers.size; }

  async resolveForPath(viewerPath: string, roots: WorkspacePathContext): Promise<LanguageServerResolution> {
    if (this.disposed) return { reason: LANGUAGE_SERVER_RESOLUTION_REASONS.NO_SERVER };
    if (!this.options.isWorkspaceTrusted()) return { reason: LANGUAGE_SERVER_RESOLUTION_REASONS.UNTRUSTED };
    const absolutePath = safeResolveWorkspacePath(viewerPath, roots);
    if (!absolutePath) return { reason: LANGUAGE_SERVER_RESOLUTION_REASONS.NO_SERVER };
    const languageId = this.languageForPath(absolutePath);
    if (!languageId) return { reason: LANGUAGE_SERVER_RESOLUTION_REASONS.NO_SERVER };
    const approval = await this.approveWorkspaceDefinitions();
    if (!approval) return { reason: LANGUAGE_SERVER_RESOLUTION_REASONS.NEEDS_APPROVAL };
    const userSettings = { languageServers: this.normalize(this.options.userSettings().languageServers) };
    const workspaceSettings = { languageServers: this.normalize(this.options.workspaceSettings().languageServers) };
    const approved = this.getApprovals();
    const ids = new Set(Object.entries(workspaceSettings.languageServers.definitions)
      .filter(([id, definition]) => approved[id] === this.definitionHash(definition)).map(([id]) => id));
    const resolved = await resolveLanguageServer({
      languageId, userSettings, workspaceSettings, approvedWorkspaceDefinitionIds: ids,
      pathEntries: this.options.pathEntries ?? (process.env.PATH ?? "").split(path.delimiter),
      toolBinDirectory: this.options.toolBinDirectory ?? path.join(this.options.workspaceRoot, ".ctrlyoke", "tools", "bin"),
      workspaceRoot: this.options.workspaceRoot, platform: this.options.platform ?? process.platform,
    }, this.deps);
    if (!resolved) {
      this.emitStatus({ id: String(workspaceSettings.languageServers.use[languageId] ?? languageId), rootPath: this.options.workspaceRoot, status: "not installed" });
      return { reason: LANGUAGE_SERVER_RESOLUTION_REASONS.NO_SERVER };
    }
    const key = this.serverKey(resolved.id, this.options.workspaceRoot);
    const existing = this.servers.get(key);
    if (existing) { existing.lastUsed = Date.now(); this.resetIdle(existing); }
    else if (this.runningCount() >= Math.max(1, userSettings.languageServers.maxRunning)) {
      const victim = [...this.servers.values()].filter((server) => server.openDocuments === 0).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!victim) {
        this.emitStatus({ id: resolved.id, rootPath: this.options.workspaceRoot, status: "limit reached" });
        return { reason: LANGUAGE_SERVER_RESOLUTION_REASONS.LIMIT_REACHED };
      }
      await this.stopServer(victim, "stopped");
    }
    const descriptor: LanguageServerDescriptor = { id: resolved.id, languageId, rootPath: this.options.workspaceRoot, capabilities: {}, serverInfo: { name: resolved.id } };
    return { descriptor };
  }

  async getConnection(descriptor: LanguageServerDescriptor): Promise<MessageConnection> {
    const key = this.serverKey(descriptor.id, descriptor.rootPath);
    const existing = this.servers.get(key);
    if (existing) { existing.lastUsed = Date.now(); this.resetIdle(existing); return existing.connection; }
    const resolved = await this.resolveByDescriptor(descriptor);
    if (!resolved) throw new Error(`Language server ${descriptor.id} is no longer available.`);
    return this.startServer(key, resolved, descriptor, 0);
  }

  listenConnection(_connection: MessageConnection): void {
    // The managed process must be listened to while initialize is in flight;
    // LanguageIntelligenceHost uses this hook to avoid listening twice.
  }

  documentOpened(descriptor: LanguageServerDescriptor): void {
    const server = this.servers.get(this.serverKey(descriptor.id, descriptor.rootPath));
    if (!server) return;
    server.openDocuments += 1; server.lastUsed = Date.now(); this.clearIdle(server);
  }
  documentClosed(descriptor: LanguageServerDescriptor): void {
    const server = this.servers.get(this.serverKey(descriptor.id, descriptor.rootPath));
    if (!server) return;
    server.openDocuments = Math.max(0, server.openDocuments - 1); server.lastUsed = Date.now();
    if (server.openDocuments === 0) {
      this.emitStatus({ id: server.resolved.id, rootPath: server.descriptor.rootPath, status: "idle" });
      this.resetIdle(server);
    }
  }

  async startLanguages(languageIds: readonly string[]): Promise<void> {
    for (const languageId of languageIds) {
      const extension = this.extensionForLanguage(languageId);
      if (!extension) continue;
      const result = await this.resolveForPath(path.join(this.options.workspaceRoot, `__ctrlyoke_start__.${extension}`), this.roots);
      if ("descriptor" in result) {
        try { await this.getConnection(result.descriptor); } catch { /* status carries the failure */ }
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const running = [...this.servers.values()];
    await Promise.all(running.map(async (server) => {
      this.clearIdle(server);
      server.intentionalStop = true;
      try { await server.connection.sendRequest("shutdown"); } catch { /* process may already be gone */ }
      try { await server.connection.sendNotification("exit"); } catch { /* already closed */ }
      await this.waitForExit(server.child);
      if (server.child.exitCode === null) server.child.kill();
      server.connection.dispose();
    }));
    this.servers.clear();
    this.statuses.removeAllListeners();
  }

  private async approveWorkspaceDefinitions(): Promise<boolean> {
    const definitions = this.normalize(this.options.workspaceSettings().languageServers).definitions;
    const approvals = this.getApprovals();
    const pending = Object.entries(definitions).filter(([id, definition]) => {
      const hash = this.definitionHash(definition);
      return approvals[id] !== hash && approvals[id] !== `!${hash}`;
    });
    if (!pending.length) return true;
    this.emitStatus({ id: pending[0][0], rootPath: this.options.workspaceRoot, status: "needs approval" });
    if (!this.options.interactionPort.canPrompt()) return false;
    const hashes = new Map(pending.map(([id, definition]) => [id, this.definitionHash(definition)]));
    const response = await this.options.interactionPort.requestBatchApproval({
      id: `language-servers-${createHash("sha256").update(path.resolve(this.options.workspaceRoot)).digest("hex").slice(0, 16)}`,
      title: "Approve workspace language servers",
      description: "These workspace definitions can run commands on this machine. Review each executable before allowing it.",
      items: pending.map(([id, definition]) => ({ value: `${id}:${hashes.get(id)}`, label: `${id}: ${definition.command.join(" ")}`, checked: false })),
    });
    if (!response) return false;
    for (const value of response.approvedValues) { const [id, hash] = value.split(":"); if (id && hash) approvals[id] = hash; }
    for (const value of response.deniedValues) { const [id, hash] = value.split(":"); if (id && hash) approvals[id] = `!${hash}`; }
    await this.options.approvalStore.update(APPROVAL_KEY, { ...this.options.approvalStore.get<Record<string, Record<string, string>>>(APPROVAL_KEY), [path.resolve(this.options.workspaceRoot)]: approvals });
    // A denial records the decision without blocking built-ins or another
    // approved definition for this language. The resolver receives only the
    // definitions whose current executable hash was approved.
    return true;
  }

  private getApprovals(): Record<string, string> {
    const all = this.options.approvalStore.get<Record<string, Record<string, string>>>(APPROVAL_KEY) ?? {};
    return { ...(all[path.resolve(this.options.workspaceRoot)] ?? {}) };
  }
  private definitionHash(definition: LanguageServerDefinition): string {
    return createHash("sha256").update(JSON.stringify({ command: definition.command, env: definition.env ?? {} })).digest("hex");
  }
  private languageForPath(filePath: string): string | undefined {
    const extension = path.extname(filePath).slice(1).toLowerCase();
    const candidates = [...Object.entries(this.normalize(this.options.workspaceSettings().languageServers).definitions), ...Object.entries(this.normalize(this.options.userSettings().languageServers).definitions)];
    for (const [, definition] of candidates) if (definition.extensions.some((value) => value.toLowerCase() === extension)) return definition.languages[0];
    return LANGUAGE_SERVER_CATALOG.find((entry) => entry.extensions.some((value) => value.toLowerCase() === extension))?.languages[0];
  }
  private extensionForLanguage(languageId: string): string | undefined {
    return LANGUAGE_SERVER_CATALOG.find((entry) => entry.languages.includes(languageId))?.extensions[0];
  }
  private async resolveByDescriptor(descriptor: LanguageServerDescriptor): Promise<ResolvedLanguageServer | undefined> {
    const userSettings = { languageServers: this.normalize(this.options.userSettings().languageServers) }; const workspaceSettings = { languageServers: this.normalize(this.options.workspaceSettings().languageServers) }; const approvals = this.getApprovals();
    const ids = new Set(Object.entries(workspaceSettings.languageServers.definitions).filter(([id, def]) => approvals[id] === this.definitionHash(def)).map(([id]) => id));
    return resolveLanguageServer({ languageId: descriptor.languageId, userSettings, workspaceSettings, approvedWorkspaceDefinitionIds: ids, pathEntries: this.options.pathEntries ?? (process.env.PATH ?? "").split(path.delimiter), toolBinDirectory: this.options.toolBinDirectory ?? path.join(this.options.workspaceRoot, ".ctrlyoke", "tools", "bin"), workspaceRoot: this.options.workspaceRoot, platform: this.options.platform ?? process.platform }, this.deps);
  }
  private async startServer(key: string, resolved: ResolvedLanguageServer, descriptor: LanguageServerDescriptor, restartCount: number): Promise<MessageConnection> {
    this.emitStatus({ id: resolved.id, rootPath: descriptor.rootPath, status: "starting" });
    const command = resolved.command;
    const env = { ...process.env, ...resolved.env } as NodeJS.ProcessEnv;
    const child = (this.options.spawnProcess ?? spawn)(command.command, command.args, {
      cwd: descriptor.rootPath, env, stdio: ["pipe", "pipe", "pipe"],
      ...(command.requiresShellVerbatimArgs ? { windowsVerbatimArguments: true } : {}),
    });
    const reader = new StreamMessageReader(child.stdout!);
    const writer = new StreamMessageWriter(child.stdin!);
    const connection = createMessageConnection(reader, writer);
    const server: RunningServer = { key, resolved, descriptor, connection, child, openDocuments: 0, lastUsed: Date.now(), intentionalStop: false, restartCount };
    this.servers.set(key, server);
    connection.onError((errors) => {
      if (server.intentionalStop || this.disposed) return;
      const detail = errors.map((error) => error instanceof Error ? error.message : String(error)).join("; ");
      this.crashed(server, new Error(detail || "Language server JSON-RPC connection failed."));
    });
    child.stderr?.on("data", (data: Buffer) => { const lines = `${server.stderrLine ?? ""}${data.toString("utf8")}`.split(/\r?\n/); server.stderrLine = lines.pop(); const line = lines.filter(Boolean).at(-1); if (line) server.stderrLine = line; });
    child.once("error", (error) => this.crashed(server, error));
    child.once("exit", (code, signal) => { if (!server.intentionalStop) this.crashed(server, new Error(`Language server exited (${code ?? signal}). ${server.stderrLine ?? ""}`)); });
    connection.onRequest("workspace/configuration", (params: { items?: Array<{ section?: string }> }) => (params.items ?? []).map((item) => this.configurationValue(resolved.settings, item.section)));
    connection.onRequest("client/registerCapability", () => null);
    connection.onRequest("client/unregisterCapability", () => null);
    connection.listen();
    try {
      const initialized = await connection.sendRequest("initialize", { processId: process.pid, rootUri: pathToFileURL(descriptor.rootPath).toString(), capabilities: { workspace: { configuration: true }, textDocument: { completion: { completionItem: { snippetSupport: true } }, hover: {}, publishDiagnostics: {} } }, initializationOptions: resolved.settings });
      const caps = (initialized as { capabilities?: Record<string, unknown> }).capabilities ?? {};
      (server.descriptor as { capabilities: Record<string, unknown> }).capabilities = caps;
      connection.sendNotification("initialized", {});
      this.emitStatus({ id: resolved.id, rootPath: descriptor.rootPath, status: "running" });
      if (server.openDocuments === 0) this.emitStatus({ id: resolved.id, rootPath: descriptor.rootPath, status: "idle" });
      this.resetIdle(server);
      return connection;
    } catch (error) { await this.stopServer(server, "crashed"); throw error; }
  }
  private configurationValue(settings: Record<string, unknown>, section?: string): unknown {
    if (!section) return settings;
    return section.split(".").reduce<unknown>((value, key) => value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined, settings);
  }
  private normalize(value: Partial<LanguageServersSettings>): LanguageServersSettings {
    const defaults = CTRLYOKE_SETTINGS_DEFAULTS.languageServers;
    return { ...defaults, ...value, definitions: value.definitions ?? {}, use: value.use ?? {}, settings: value.settings ?? {} };
  }
  private crashed(server: RunningServer, error: Error): void {
    if (this.servers.get(server.key) !== server) return;
    this.servers.delete(server.key); this.clearIdle(server);
    this.emitStatus({ id: server.resolved.id, rootPath: server.descriptor.rootPath, status: "crashed", detail: error.message });
    if (!this.disposed && server.openDocuments > 0 && server.restartCount < 5) {
      const delay = Math.min(30_000, 500 * 2 ** server.restartCount);
      this.emitStatus({ id: server.resolved.id, rootPath: server.descriptor.rootPath, status: "starting", detail: `Restarting in ${delay} ms` });
      (this.options.setTimer ?? setTimeout)(() => { if (!this.disposed) void this.startServer(server.key, server.resolved, server.descriptor, server.restartCount + 1).catch(() => undefined); }, delay);
    }
  }
  private resetIdle(server: RunningServer): void {
    this.clearIdle(server);
    if (server.openDocuments > 0) return;
    const minutes = this.normalize(this.options.userSettings().languageServers).idleShutdownMinutes;
    server.idleTimer = (this.options.setTimer ?? setTimeout)(() => { if (server.openDocuments === 0) void this.stopServer(server, "stopped"); }, Math.max(0, minutes) * 60_000);
  }
  private clearIdle(server: RunningServer): void { if (server.idleTimer) (this.options.clearTimer ?? clearTimeout)(server.idleTimer); server.idleTimer = undefined; }
  private async stopServer(server: RunningServer, status: LanguageServerStatus): Promise<void> {
    this.clearIdle(server); server.intentionalStop = true;
    if (this.servers.get(server.key) === server) this.servers.delete(server.key);
    try { await server.connection.sendRequest("shutdown"); } catch { /* process may already be gone */ }
    try { await server.connection.sendNotification("exit"); } catch { /* already disposed */ }
    await this.waitForExit(server.child);
    if (server.child.exitCode === null) server.child.kill();
    server.connection.dispose();
    this.emitStatus({ id: server.resolved.id, rootPath: server.descriptor.rootPath, status });
  }
  private runningCount(): number { return this.servers.size; }
  private async waitForExit(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.off("exit", onExit); resolve(); }, 1_000);
      const onExit = (): void => { clearTimeout(timer); resolve(); };
      child.once("exit", onExit);
    });
  }
  private serverKey(id: string, root: string): string { return `${id}\n${path.resolve(root)}`; }
  private emitStatus(event: LanguageServerStatusChange): void { this.statuses.emit("change", event); }
}
