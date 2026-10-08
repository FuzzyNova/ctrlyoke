import { createHash } from "node:crypto";
import * as fs from "node:fs";
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
import {
  CTRLYOKE_SETTINGS_DEFAULTS,
  type CtrlYokeGlobalSettings,
  type LanguageServerDefinition,
  type LanguageServersSettings,
} from "../../types/CtrlYokeSettings";
import {
  LANGUAGE_SERVER_STATUSES,
  LSP_METHODS,
} from "../../types/DashboardConstants";
import type { KeyValueStore } from "../../core/HostPorts";
import type { UserInteractionPort } from "../../ui/UserInteractionPort";
import {
  createNodeLanguageServerResolverDependencies,
  resolveLanguageServer,
  type LanguageServerResolverDependencies,
  type ResolvedLanguageServer,
} from "./LanguageServerResolver";
import type {
  LanguageServerBackend,
  LanguageServerDescriptor,
  LanguageServerResolution,
} from "./LanguageServerBackend";
import { LANGUAGE_SERVER_RESOLUTION_REASONS } from "./LanguageServerBackend";
import type { WorkspacePathContext } from "./WorkspacePathContainment";
import { safeResolveWorkspacePath } from "./WorkspacePathContainment";
import { LANGUAGE_SERVER_CATALOG } from "./LanguageServerCatalog";
import { ctrlyokeStateHome } from "../../utils/ProjectStatePaths";

export type LanguageServerStatus =
  (typeof LANGUAGE_SERVER_STATUSES)[keyof typeof LANGUAGE_SERVER_STATUSES];
export interface LanguageServerStatusChange {
  readonly id: string;
  readonly rootPath: string;
  readonly status: LanguageServerStatus;
  readonly detail?: string;
}
export interface ManagedLanguageServerBackendOptions {
  readonly workspaceRoot: string;
  readonly userSettings: () => Pick<CtrlYokeGlobalSettings, "languageServers">;
  readonly workspaceSettings: () => Pick<
    CtrlYokeGlobalSettings,
    "languageServers"
  >;
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

interface RunningServer {
  readonly key: string;
  readonly resolved: ResolvedLanguageServer;
  readonly descriptor: LanguageServerDescriptor;
  readonly connection: MessageConnection;
  readonly child: ChildProcess;
  openDocuments: number;
  initialized: boolean;
  lastUsed: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  stderrLine?: string;
  intentionalStop: boolean;
  restartCount: number;
}
const APPROVAL_KEY = "languageServers.workspaceDefinitionApprovals";

/** Spawns and supervises stdio language servers for a single workspace host. */
export class ManagedLanguageServerBackend implements LanguageServerBackend {
  private readonly servers = new Map<string, RunningServer>();
  private readonly statuses = new EventEmitter();
  private readonly roots: WorkspacePathContext;
  private readonly deps: LanguageServerResolverDependencies;
  private readonly starting = new Map<string, Promise<MessageConnection>>();
  private readonly restartCounts = new Map<string, number>();
  private readonly userStoppedServers = new Set<string>();
  private readonly userStoppedDetails = new Map<
    string,
    {
      key: string;
      resolved: ResolvedLanguageServer;
      descriptor: LanguageServerDescriptor;
      restartCount: number;
    }
  >();
  private readonly restartTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private approvalPrompt?: Promise<boolean>;
  private approvalDismissed = false;
  private disposed = false;

  constructor(private readonly options: ManagedLanguageServerBackendOptions) {
    this.roots = {
      workspaceRoot: path.resolve(options.workspaceRoot),
      namedRoots: [],
    };
    this.deps =
      options.resolverDependencies ??
      createNodeLanguageServerResolverDependencies();
  }

  onStatusChanged(listener: (event: LanguageServerStatusChange) => void): {
    dispose(): void;
  } {
    this.statuses.on("change", listener);
    return { dispose: () => this.statuses.off("change", listener) };
  }

  get runningServerCount(): number {
    return this.servers.size;
  }

  getApprovedWorkspaceDefinitionIds(): string[] {
    const settings = this.normalize(
      this.options.workspaceSettings().languageServers
    );
    const approvals = this.getApprovals();
    return Object.entries(settings.definitions)
      .filter(
        ([id, definition]) =>
          approvals[id] ===
          this.definitionHash(definition, settings.settings[id])
      )
      .map(([id]) => id);
  }

  async resolveForPath(
    viewerPath: string,
    roots: WorkspacePathContext,
    promptForApproval = true,
    allowEviction = true
  ): Promise<LanguageServerResolution> {
    if (this.disposed)
      return { reason: LANGUAGE_SERVER_RESOLUTION_REASONS.NO_SERVER };
    if (!this.options.isWorkspaceTrusted())
      return { reason: LANGUAGE_SERVER_RESOLUTION_REASONS.UNTRUSTED };
    const absolutePath = safeResolveWorkspacePath(viewerPath, roots);
    if (!absolutePath)
      return { reason: LANGUAGE_SERVER_RESOLUTION_REASONS.NO_SERVER };
    const languageId = this.languageForPath(absolutePath);
    if (!languageId)
      return { reason: LANGUAGE_SERVER_RESOLUTION_REASONS.NO_SERVER };
    const userSettings = {
      languageServers: this.normalize(
        this.options.userSettings().languageServers
      ),
    };
    const workspaceSettings = {
      languageServers: this.normalize(
        this.options.workspaceSettings().languageServers
      ),
    };
    const approved = this.getApprovals();
    const selected = workspaceSettings.languageServers.use[languageId];
    if (
      typeof selected === "string" &&
      !userSettings.languageServers.definitions[selected] &&
      workspaceSettings.languageServers.definitions[selected] &&
      approved[selected] !==
        this.definitionHash(
          workspaceSettings.languageServers.definitions[selected],
          workspaceSettings.languageServers.settings[selected]
        )
    ) {
      const approval =
        promptForApproval &&
        (await this.approveWorkspaceDefinitions([selected]));
      if (!approval)
        return { reason: LANGUAGE_SERVER_RESOLUTION_REASONS.NEEDS_APPROVAL };
    }
    const refreshedApprovals = this.getApprovals();
    const ids = new Set(
      Object.entries(workspaceSettings.languageServers.definitions)
        .filter(
          ([id, definition]) =>
            refreshedApprovals[id] ===
            this.definitionHash(
              definition,
              workspaceSettings.languageServers.settings[id]
            )
        )
        .map(([id]) => id)
    );
    const rootMarkers = this.rootMarkersForLanguage(
      languageId,
      userSettings.languageServers,
      workspaceSettings.languageServers
    );
    const rootPath = await this.findServerRoot(
      absolutePath,
      rootMarkers,
      roots
    );
    const resolved = await resolveLanguageServer(
      this.resolverOptions(
        languageId,
        rootPath,
        userSettings,
        workspaceSettings,
        ids
      ),
      this.deps
    );
    if (!resolved) {
      this.emitStatus({
        id: String(
          workspaceSettings.languageServers.use[languageId] ?? languageId
        ),
        rootPath,
        status: LANGUAGE_SERVER_STATUSES.NOT_INSTALLED,
      });
      return { reason: LANGUAGE_SERVER_RESOLUTION_REASONS.NO_SERVER };
    }
    const key = this.serverKey(resolved.id, rootPath);
    if (this.userStoppedServers.has(resolved.id)) {
      return { reason: LANGUAGE_SERVER_RESOLUTION_REASONS.STOPPED };
    }
    const running = this.servers.get(key);
    if (running?.initialized) {
      return {
        descriptor: {
          id: resolved.id,
          languageId,
          rootPath,
          capabilities: running.descriptor.capabilities,
          serverInfo: running.descriptor.serverInfo,
        },
      };
    }
    const inFlight = this.starting.get(key);
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        return { reason: LANGUAGE_SERVER_RESOLUTION_REASONS.NO_SERVER };
      }
      const initialized = this.servers.get(key);
      if (initialized?.initialized) {
        return {
          descriptor: {
            id: resolved.id,
            languageId,
            rootPath,
            capabilities: initialized.descriptor.capabilities,
            serverInfo: initialized.descriptor.serverInfo,
          },
        };
      }
    }
    if (
      allowEviction &&
      !this.servers.has(key) &&
      this.runningCount() >=
        Math.max(1, userSettings.languageServers.maxRunning)
    ) {
      const victim = [...this.servers.values()]
        .filter((server) => server.initialized && server.openDocuments === 0)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!victim) {
        this.emitStatus({
          id: resolved.id,
          rootPath,
          status: LANGUAGE_SERVER_STATUSES.LIMIT_REACHED,
        });
        return { reason: LANGUAGE_SERVER_RESOLUTION_REASONS.LIMIT_REACHED };
      }
      await this.stopServer(victim, LANGUAGE_SERVER_STATUSES.STOPPED);
    }
    const descriptor: LanguageServerDescriptor = {
      id: resolved.id,
      languageId,
      rootPath,
      capabilities: {},
      serverInfo: { name: resolved.id },
    };
    return { descriptor };
  }

  async getConnection(
    descriptor: LanguageServerDescriptor
  ): Promise<MessageConnection> {
    const key = this.serverKey(descriptor.id, descriptor.rootPath);
    const existing = this.servers.get(key);
    if (existing) {
      if (!existing.initialized) {
        const pending = this.starting.get(key);
        if (pending) await pending;
      }
      const initialized = this.servers.get(key);
      if (!initialized?.initialized) {
        throw new Error(`Language server ${descriptor.id} is not initialized.`);
      }
      (descriptor as { capabilities: Record<string, unknown> }).capabilities =
        initialized.descriptor.capabilities;
      existing.lastUsed = Date.now();
      this.resetIdle(existing);
      return existing.connection;
    }
    const pending = this.starting.get(key);
    if (pending) return pending;
    const starting = (async () => {
      const resolved = await this.resolveByDescriptor(descriptor);
      if (!resolved) {
        const error = new Error(
          `Language server ${descriptor.id} is no longer available.`
        );
        this.emitStatus({
          id: descriptor.id,
          rootPath: descriptor.rootPath,
          status: LANGUAGE_SERVER_STATUSES.CRASHED,
          detail: error.message,
        });
        throw error;
      }
      const newlyStarted = this.servers.get(key);
      if (newlyStarted) return newlyStarted.connection;
      const maxRunning = Math.max(
        1,
        this.normalize(this.options.userSettings().languageServers).maxRunning
      );
      if (this.runningCount() >= maxRunning) {
        const victim = [...this.servers.values()]
          .filter((server) => server.initialized && server.openDocuments === 0)
          .sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (!victim) {
          this.emitStatus({
            id: descriptor.id,
            rootPath: descriptor.rootPath,
            status: LANGUAGE_SERVER_STATUSES.LIMIT_REACHED,
          });
          throw new Error(`Language server limit (${maxRunning}) reached.`);
        }
        await this.stopServer(victim, LANGUAGE_SERVER_STATUSES.STOPPED);
      }
      return this.startServer(
        key,
        resolved,
        descriptor,
        this.restartCounts.get(key) ?? 0
      );
    })();
    this.starting.set(key, starting);
    try {
      return await starting;
    } finally {
      if (this.starting.get(key) === starting) this.starting.delete(key);
    }
  }

  listenConnection(_connection: MessageConnection): void {
    // The managed process must be listened to while initialize is in flight;
    // LanguageIntelligenceHost uses this hook to avoid listening twice.
  }

  documentOpened(descriptor: LanguageServerDescriptor): void {
    const server = this.servers.get(
      this.serverKey(descriptor.id, descriptor.rootPath)
    );
    if (!server) return;
    server.openDocuments += 1;
    server.lastUsed = Date.now();
    this.clearIdle(server);
  }
  documentClosed(descriptor: LanguageServerDescriptor): void {
    const server = this.servers.get(
      this.serverKey(descriptor.id, descriptor.rootPath)
    );
    if (!server) return;
    server.openDocuments = Math.max(0, server.openDocuments - 1);
    server.lastUsed = Date.now();
    if (server.openDocuments === 0) {
      this.emitStatus({
        id: server.resolved.id,
        rootPath: server.descriptor.rootPath,
        status: LANGUAGE_SERVER_STATUSES.IDLE,
      });
      this.resetIdle(server);
    }
  }

  async startLanguages(languageIds: readonly string[]): Promise<void> {
    for (const languageId of languageIds) {
      const extension = this.extensionForLanguage(languageId);
      if (!extension) continue;
      const result = await this.resolveForPath(
        path.join(
          this.options.workspaceRoot,
          `__ctrlyoke_start__.${extension}`
        ),
        this.roots,
        false,
        false
      );
      if ("descriptor" in result) {
        const key = this.serverKey(
          result.descriptor.id,
          result.descriptor.rootPath
        );
        if (this.servers.has(key) || this.starting.has(key)) continue;
        const maxRunning = Math.max(
          1,
          this.normalize(this.options.userSettings().languageServers).maxRunning
        );
        if (this.runningCount() >= maxRunning) {
          this.emitStatus({
            id: result.descriptor.id,
            rootPath: result.descriptor.rootPath,
            status: LANGUAGE_SERVER_STATUSES.LIMIT_REACHED,
          });
          continue;
        }
        try {
          await this.getConnection(result.descriptor);
        } catch {
          /* status carries the failure */
        }
      }
    }
  }

  async restartServer(id: string): Promise<void> {
    if (!this.options.isWorkspaceTrusted()) {
      throw new Error(
        "The workspace must be trusted before restarting a language server."
      );
    }
    const server = [...this.servers.values()].find(
      (entry) => entry.resolved.id === id
    );
    this.userStoppedServers.delete(id);
    const stopped = this.userStoppedDetails.get(id);
    this.userStoppedDetails.delete(id);
    if (server) {
      const { descriptor, resolved, key } = server;
      const restartCount = server.restartCount;
      await this.stopServer(server, LANGUAGE_SERVER_STATUSES.STOPPED);
      await this.startServer(key, resolved, descriptor, restartCount);
      return;
    }
    if (stopped) {
      await this.startServer(
        stopped.key,
        stopped.resolved,
        stopped.descriptor,
        stopped.restartCount
      );
      return;
    }
    throw new Error(`Language server ${id} is not running.`);
  }

  async stopManagedServer(id: string): Promise<void> {
    const server = [...this.servers.values()].find(
      (entry) => entry.resolved.id === id
    );
    if (server) {
      this.userStoppedServers.add(id);
      this.userStoppedDetails.set(id, {
        key: server.key,
        resolved: server.resolved,
        descriptor: server.descriptor,
        restartCount: server.restartCount,
      });
      await this.stopServer(server, LANGUAGE_SERVER_STATUSES.STOPPED);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const timer of this.restartTimers.values())
      (this.options.clearTimer ?? clearTimeout)(timer);
    this.restartTimers.clear();
    const running = [...this.servers.values()];
    await Promise.all(
      running.map(async (server) => {
        this.clearIdle(server);
        server.intentionalStop = true;
        try {
          await this.withTimeout(
            server.connection.sendRequest(LSP_METHODS.SHUTDOWN),
            1_000
          );
        } catch {
          /* process may be gone or ignoring shutdown */
        }
        try {
          await server.connection.sendNotification(LSP_METHODS.EXIT);
        } catch {
          /* already closed */
        }
        await this.waitForExit(server.child);
        if (server.child.exitCode === null) server.child.kill();
        server.connection.dispose();
      })
    );
    this.servers.clear();
    this.statuses.removeAllListeners();
  }

  async requestWorkspaceApproval(): Promise<boolean> {
    this.approvalDismissed = false;
    return this.approveWorkspaceDefinitions();
  }

  private async approveWorkspaceDefinitions(
    onlyIds?: readonly string[]
  ): Promise<boolean> {
    if (this.approvalDismissed) return false;
    if (this.approvalPrompt) return this.approvalPrompt;
    const settings = this.normalize(
      this.options.workspaceSettings().languageServers
    );
    const definitions = settings.definitions;
    const approvals = this.getApprovals();
    const pending = Object.entries(definitions).filter(([id, definition]) => {
      if (onlyIds && !onlyIds.includes(id)) return false;
      const hash = this.definitionHash(definition, settings.settings[id]);
      return approvals[id] !== hash && approvals[id] !== `!${hash}`;
    });
    if (!pending.length) return true;
    this.emitStatus({
      id: pending[0][0],
      rootPath: this.options.workspaceRoot,
      status: LANGUAGE_SERVER_STATUSES.NEEDS_APPROVAL,
    });
    if (!this.options.interactionPort.canPrompt()) {
      this.approvalDismissed = true;
      return false;
    }
    const hashes = new Map(
      pending.map(([id, definition]) => [
        id,
        this.definitionHash(definition, settings.settings[id]),
      ])
    );
    const prompt = this.options.interactionPort.requestBatchApproval({
      id: `language-servers-${createHash("sha256").update(path.resolve(this.options.workspaceRoot)).digest("hex").slice(0, 16)}`,
      title: "Approve workspace language servers",
      description:
        "These workspace definitions can run commands on this machine. Review each executable before allowing it.",
      items: pending.map(([id, definition]) => ({
        value: `${id}:${hashes.get(id)}`,
        label: `${id}: ${definition.command.join(" ")}`,
        checked: false,
      })),
    });
    this.approvalPrompt = prompt
      .then(async (response) => {
        if (!response) {
          this.approvalDismissed = true;
          return false;
        }
        for (const value of response.approvedValues) {
          const [id, hash] = value.split(":");
          if (id && hash) approvals[id] = hash;
        }
        for (const value of response.deniedValues) {
          const [id, hash] = value.split(":");
          if (id && hash) approvals[id] = `!${hash}`;
        }
        await this.options.approvalStore.update(APPROVAL_KEY, {
          ...this.options.approvalStore.get<
            Record<string, Record<string, string>>
          >(APPROVAL_KEY),
          [path.resolve(this.options.workspaceRoot)]: approvals,
        });
        return true;
      })
      .finally(() => {
        this.approvalPrompt = undefined;
      });
    return this.approvalPrompt;
  }

  private getApprovals(): Record<string, string> {
    const all =
      this.options.approvalStore.get<Record<string, Record<string, string>>>(
        APPROVAL_KEY
      ) ?? {};
    return { ...(all[path.resolve(this.options.workspaceRoot)] ?? {}) };
  }
  private definitionHash(
    definition: LanguageServerDefinition,
    settings: Record<string, unknown> = {}
  ): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          command: definition.command,
          env: definition.env ?? {},
          initializationOptions: settings,
        })
      )
      .digest("hex");
  }
  private languageForPath(filePath: string): string | undefined {
    const extension = path.extname(filePath).slice(1).toLowerCase();
    const candidates = [
      ...Object.entries(
        this.normalize(this.options.workspaceSettings().languageServers)
          .definitions
      ),
      ...Object.entries(
        this.normalize(this.options.userSettings().languageServers).definitions
      ),
    ];
    for (const [, definition] of candidates)
      if (
        definition.extensions.some((value) => value.toLowerCase() === extension)
      )
        return definition.languages[0];
    return LANGUAGE_SERVER_CATALOG.find((entry) =>
      entry.extensions.some((value) => value.toLowerCase() === extension)
    )?.languages[0];
  }
  private extensionForLanguage(languageId: string): string | undefined {
    return LANGUAGE_SERVER_CATALOG.find((entry) =>
      entry.languages.includes(languageId)
    )?.extensions[0];
  }
  private async resolveByDescriptor(
    descriptor: LanguageServerDescriptor
  ): Promise<ResolvedLanguageServer | undefined> {
    const userSettings = {
      languageServers: this.normalize(
        this.options.userSettings().languageServers
      ),
    };
    const workspaceSettings = {
      languageServers: this.normalize(
        this.options.workspaceSettings().languageServers
      ),
    };
    const approvals = this.getApprovals();
    const ids = new Set(
      Object.entries(workspaceSettings.languageServers.definitions)
        .filter(
          ([id, def]) =>
            approvals[id] ===
            this.definitionHash(
              def,
              workspaceSettings.languageServers.settings[id]
            )
        )
        .map(([id]) => id)
    );
    return resolveLanguageServer(
      this.resolverOptions(
        descriptor.languageId,
        descriptor.rootPath,
        userSettings,
        workspaceSettings,
        ids
      ),
      this.deps
    );
  }

  private resolverOptions(
    languageId: string,
    workspaceRoot: string,
    userSettings: { languageServers: LanguageServersSettings },
    workspaceSettings: { languageServers: LanguageServersSettings },
    approvedWorkspaceDefinitionIds: ReadonlySet<string>
  ) {
    return {
      languageId,
      userSettings,
      workspaceSettings,
      approvedWorkspaceDefinitionIds,
      pathEntries:
        this.options.pathEntries ??
        (process.env.PATH ?? "").split(path.delimiter),
      toolBinDirectory:
        this.options.toolBinDirectory ??
        path.join(ctrlyokeStateHome(), "lsp", "node_modules", ".bin"),
      workspaceRoot,
      platform: this.options.platform ?? process.platform,
    };
  }

  private rootMarkersForLanguage(
    languageId: string,
    userSettings: LanguageServersSettings,
    workspaceSettings: LanguageServersSettings
  ): readonly string[] {
    const hasWorkspaceSelection = Object.prototype.hasOwnProperty.call(
      workspaceSettings.use,
      languageId
    );
    const hasUserSelection = Object.prototype.hasOwnProperty.call(
      userSettings.use,
      languageId
    );
    const selected = hasWorkspaceSelection
      ? workspaceSettings.use[languageId]
      : hasUserSelection
        ? userSettings.use[languageId]
        : undefined;
    if (typeof selected === "string") {
      const definition =
        userSettings.definitions[selected] ??
        workspaceSettings.definitions[selected];
      if (definition) return definition.rootMarkers;
      const entry = LANGUAGE_SERVER_CATALOG.find(
        (candidate) => candidate.id === selected
      );
      if (entry) return entry.rootMarkers;
    }
    return (
      LANGUAGE_SERVER_CATALOG.find((entry) =>
        entry.languages.includes(languageId)
      )?.rootMarkers ?? []
    );
  }

  private async findServerRoot(
    filePath: string,
    markers: readonly string[],
    roots: WorkspacePathContext
  ): Promise<string> {
    const resolveRealRoot = (rootPath: string): string => {
      try {
        return fs.realpathSync(rootPath);
      } catch {
        return path.resolve(rootPath);
      }
    };
    const containingRoots = (
      roots.namedRoots.length
        ? roots.namedRoots.map((root) => resolveRealRoot(root.fsPath))
        : [resolveRealRoot(roots.workspaceRoot)]
    )
      .filter((root) => {
        const relative = path.relative(root, filePath);
        return (
          relative === "" ||
          (!relative.startsWith(`..${path.sep}`) &&
            relative !== ".." &&
            !path.isAbsolute(relative))
        );
      })
      .sort((a, b) => b.length - a.length);
    const workspaceRoot =
      containingRoots[0] ?? resolveRealRoot(roots.workspaceRoot);
    let current = path.dirname(filePath);
    while (
      current === workspaceRoot ||
      current.startsWith(`${workspaceRoot}${path.sep}`)
    ) {
      if (await this.hasRootMarker(current, markers)) return current;
      if (current === workspaceRoot) break;
      current = path.dirname(current);
    }
    return workspaceRoot;
  }

  private async hasRootMarker(
    directory: string,
    markers: readonly string[]
  ): Promise<boolean> {
    for (const marker of markers) {
      if (!marker.includes("*") && !marker.includes("?")) {
        try {
          await fs.promises.access(path.join(directory, marker));
          return true;
        } catch {
          continue;
        }
      }
      const globPattern = [...marker]
        .map((character) => {
          if (character === "*") return ".*";
          if (character === "?") return ".";
          return "\\.^$+()|{}[]".includes(character)
            ? `\\${character}`
            : character;
        })
        .join("");
      const pattern = new RegExp(`^${globPattern}$`);
      try {
        if (
          (await fs.promises.readdir(directory)).some((entry) =>
            pattern.test(entry)
          )
        )
          return true;
      } catch {
        /* root can disappear during lookup */
      }
    }
    return false;
  }
  private async startServer(
    key: string,
    resolved: ResolvedLanguageServer,
    descriptor: LanguageServerDescriptor,
    restartCount: number
  ): Promise<MessageConnection> {
    this.emitStatus({
      id: resolved.id,
      rootPath: descriptor.rootPath,
      status: LANGUAGE_SERVER_STATUSES.STARTING,
    });
    const command = resolved.command;
    const env = { ...process.env, ...resolved.env } as NodeJS.ProcessEnv;
    let child: ChildProcess;
    try {
      child = (this.options.spawnProcess ?? spawn)(
        command.command,
        command.args,
        {
          cwd: descriptor.rootPath,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          ...(command.requiresShellVerbatimArgs
            ? { windowsVerbatimArguments: true }
            : {}),
        }
      );
    } catch (error) {
      this.emitStatus({
        id: resolved.id,
        rootPath: descriptor.rootPath,
        status: LANGUAGE_SERVER_STATUSES.CRASHED,
        detail: String(error),
      });
      throw error;
    }
    const reader = new StreamMessageReader(child.stdout!);
    const writer = new StreamMessageWriter(child.stdin!);
    const connection = createMessageConnection(reader, writer);
    const server: RunningServer = {
      key,
      resolved,
      descriptor,
      connection,
      child,
      openDocuments: 0,
      initialized: false,
      lastUsed: Date.now(),
      intentionalStop: false,
      restartCount,
    };
    this.servers.set(key, server);
    connection.onError((errors) => {
      if (server.intentionalStop || this.disposed) return;
      const detail = errors
        .map((error) =>
          error instanceof Error ? error.message : String(error)
        )
        .join("; ");
      this.crashed(
        server,
        new Error(detail || "Language server JSON-RPC connection failed.")
      );
    });
    child.stderr?.on("data", (data: Buffer) => {
      const lines = `${server.stderrLine ?? ""}${data.toString("utf8")}`.split(
        /\r?\n/
      );
      server.stderrLine = lines.pop();
      const nonEmpty = lines.filter(Boolean);
      const line = nonEmpty[nonEmpty.length - 1];
      if (line) server.stderrLine = line;
    });
    child.once("error", (error) => this.crashed(server, error));
    child.once("exit", (code, signal) => {
      if (!server.intentionalStop)
        this.crashed(
          server,
          new Error(
            `Language server exited (${code ?? signal}). ${server.stderrLine ?? ""}`
          )
        );
    });
    connection.onRequest(
      "workspace/configuration",
      (params: { items?: Array<{ section?: string }> }) =>
        (params.items ?? []).map((item) =>
          this.configurationValue(resolved.settings, item.section)
        )
    );
    connection.onRequest("client/registerCapability", () => null);
    connection.onRequest("client/unregisterCapability", () => null);
    connection.listen();
    try {
      const initialized = await connection.sendRequest(LSP_METHODS.INITIALIZE, {
        processId: process.pid,
        rootUri: pathToFileURL(descriptor.rootPath).toString(),
        capabilities: {
          workspace: { configuration: true },
          textDocument: {
            completion: { completionItem: { snippetSupport: true } },
            hover: {},
            publishDiagnostics: {},
          },
        },
        initializationOptions: resolved.settings,
      });
      const caps =
        (initialized as { capabilities?: Record<string, unknown> })
          .capabilities ?? {};
      (
        server.descriptor as { capabilities: Record<string, unknown> }
      ).capabilities = caps;
      server.initialized = true;
      connection.sendNotification(LSP_METHODS.INITIALIZED, {});
      this.emitStatus({
        id: resolved.id,
        rootPath: descriptor.rootPath,
        status: LANGUAGE_SERVER_STATUSES.RUNNING,
      });
      if (server.openDocuments === 0)
        this.emitStatus({
          id: resolved.id,
          rootPath: descriptor.rootPath,
          status: LANGUAGE_SERVER_STATUSES.IDLE,
        });
      this.resetIdle(server);
      return connection;
    } catch (error) {
      await this.stopServer(server, LANGUAGE_SERVER_STATUSES.CRASHED);
      throw error;
    }
  }
  private configurationValue(
    settings: Record<string, unknown>,
    section?: string
  ): unknown {
    if (!section) return settings;
    return section
      .split(".")
      .reduce<unknown>(
        (value, key) =>
          value && typeof value === "object"
            ? (value as Record<string, unknown>)[key]
            : undefined,
        settings
      );
  }
  private normalize(
    value: Partial<LanguageServersSettings>
  ): LanguageServersSettings {
    const defaults = CTRLYOKE_SETTINGS_DEFAULTS.languageServers;
    return {
      ...defaults,
      ...value,
      definitions: value.definitions ?? {},
      use: value.use ?? {},
      settings: value.settings ?? {},
    };
  }
  private crashed(server: RunningServer, error: Error): void {
    if (this.servers.get(server.key) !== server) return;
    this.servers.delete(server.key);
    this.clearIdle(server);
    try {
      if (server.child.exitCode === null) server.child.kill();
    } catch {
      /* process may already have exited */
    }
    this.emitStatus({
      id: server.resolved.id,
      rootPath: server.descriptor.rootPath,
      status: LANGUAGE_SERVER_STATUSES.CRASHED,
      detail: error.message,
    });
    if (
      !this.disposed &&
      (server.openDocuments > 0 || server.restartCount > 0) &&
      server.restartCount < 5
    ) {
      const restartCount = server.restartCount + 1;
      this.restartCounts.set(server.key, restartCount);
      const delay = Math.min(30_000, 500 * 2 ** server.restartCount);
      this.emitStatus({
        id: server.resolved.id,
        rootPath: server.descriptor.rootPath,
        status: LANGUAGE_SERVER_STATUSES.STARTING,
        detail: `Restarting in ${delay} ms`,
      });
      const timer = (this.options.setTimer ?? setTimeout)(() => {
        this.restartTimers.delete(server.key);
        if (
          this.disposed ||
          this.servers.has(server.key) ||
          this.starting.has(server.key)
        )
          return;
        void this.startServer(
          server.key,
          server.resolved,
          server.descriptor,
          restartCount
        ).catch(() => undefined);
      }, delay);
      this.restartTimers.set(server.key, timer);
    }
  }
  private resetIdle(server: RunningServer): void {
    this.clearIdle(server);
    if (server.openDocuments > 0) return;
    const minutes = this.normalize(
      this.options.userSettings().languageServers
    ).idleShutdownMinutes;
    server.idleTimer = (this.options.setTimer ?? setTimeout)(
      () => {
        if (server.openDocuments === 0)
          void this.stopServer(server, LANGUAGE_SERVER_STATUSES.STOPPED);
      },
      Math.max(0, minutes) * 60_000
    );
  }
  private clearIdle(server: RunningServer): void {
    if (server.idleTimer)
      (this.options.clearTimer ?? clearTimeout)(server.idleTimer);
    server.idleTimer = undefined;
  }
  private async stopServer(
    server: RunningServer,
    status: LanguageServerStatus
  ): Promise<void> {
    this.clearIdle(server);
    server.intentionalStop = true;
    const restartTimer = this.restartTimers.get(server.key);
    if (restartTimer) (this.options.clearTimer ?? clearTimeout)(restartTimer);
    this.restartTimers.delete(server.key);
    this.restartCounts.delete(server.key);
    if (this.servers.get(server.key) === server)
      this.servers.delete(server.key);
    // The host invalidates browser proxies while the connection is still
    // alive, so their didClose notifications cannot hit a disposed transport.
    this.emitStatus({
      id: server.resolved.id,
      rootPath: server.descriptor.rootPath,
      status,
    });
    try {
      await this.withTimeout(
        server.connection.sendRequest(LSP_METHODS.SHUTDOWN),
        1_000
      );
    } catch {
      /* process may be gone or ignoring shutdown */
    }
    try {
      await server.connection.sendNotification(LSP_METHODS.EXIT);
    } catch {
      /* already disposed */
    }
    await this.waitForExit(server.child);
    if (server.child.exitCode === null) server.child.kill();
    server.connection.dispose();
  }
  private runningCount(): number {
    return this.servers.size;
  }
  private async waitForExit(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.off("exit", onExit);
        resolve();
      }, 1_000);
      const onExit = (): void => {
        clearTimeout(timer);
        resolve();
      };
      child.once("exit", onExit);
    });
  }
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = (this.options.setTimer ?? setTimeout)(
            () => reject(new Error("Language server shutdown timed out.")),
            timeoutMs
          );
        }),
      ]);
    } finally {
      if (timer) (this.options.clearTimer ?? clearTimeout)(timer);
    }
  }
  private serverKey(id: string, root: string): string {
    return `${id}\n${path.resolve(root)}`;
  }
  private emitStatus(event: LanguageServerStatusChange): void {
    this.statuses.emit("change", event);
  }
}
