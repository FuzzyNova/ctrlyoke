import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import { Log } from "../../../utils/Log";
import { writeFileAtomic } from "../../../utils/AtomicFileUtils";
import { withFileLock } from "../../../utils/FileLockUtils";
import { AsyncMutex } from "./AsyncMutex";

/**
 * Options for customizing where a tracker reads/writes its MCP config.
 *
 * Defaults reproduce the Qwen behavior (`.{tool}/settings.json` in the
 * project, `~/.{tool}/settings.json` for the user). Antigravity overrides the
 * paths, while Antigravity overrides the paths and MCP property for its
 * workspace-discovered MCP config.
 */
export interface SettingsJsonMcpTrackerOptions {
  /** Resolve the project-level config file path. Default: `<ws>/.<tool>/settings.json`. */
  projectConfigPath?: (workspaceRoot: string) => string;
  /** Resolve the user-level config file path. Default: `~/.<tool>/settings.json`. */
  userConfigPath?: () => string;
  /** Property containing MCP server entries. Default: `mcpServers`. */
  mcpServersProperty?: string;
  /** Schema URL to add while ctrlyoke owns a mutation, when the file has none. */
  schemaUrl?: string;
}

export interface SettingsJsonMcpRegisterOptions {
  /** File mode for secret-bearing generated settings (POSIX: 0600). */
  fileMode?: number;
}

export type SettingsJsonPermissionDecision = "allow" | "ask" | "deny";
export type SettingsJsonPermissionPolicy = Record<
  string,
  | SettingsJsonPermissionDecision
  | Record<string, SettingsJsonPermissionDecision>
>;

export const STATUS_LINE_SETTING_KEY = "statusLine" as const;
export type SettingsJsonPersistentValueKey = string;

/** {@link SettingsJsonPersistentValueInstallResult} discriminant for an actual write. */
export const SETTINGS_JSON_INSTALL_KIND_WRITTEN = "written" as const;

export interface SettingsJsonPersistentValueCaptureResult {
  readonly proceed?: boolean;
}

export type SettingsJsonPersistentValueCapture = (
  preexistingValue: unknown,
  hadKey: boolean
) =>
  | void
  | SettingsJsonPersistentValueCaptureResult
  | Promise<void | SettingsJsonPersistentValueCaptureResult>;

export type SettingsJsonPersistentValueUninstall =
  | { readonly action: "restore"; readonly value: unknown }
  | { readonly action: "delete" };

export type SettingsJsonPersistentValueInstallResult =
  | {
      readonly kind: "no-op";
      readonly preexistingValue: unknown;
      readonly hadKey: boolean;
    }
  | {
      readonly kind: typeof SETTINGS_JSON_INSTALL_KIND_WRITTEN;
      readonly preexistingValue: unknown;
      readonly hadKey: boolean;
    }
  | {
      readonly kind: "declined";
      readonly preexistingValue: unknown;
      readonly hadKey: boolean;
    };

export type SettingsJsonPersistentValueAlreadyInstalled = (
  currentValue: unknown,
  hadKey: boolean
) => boolean;

interface BaselineState {
  settingsFileExisted: boolean;
  hadMcpServers: boolean;
  hadSchema: boolean;
  servers: Set<string>;
}

interface WorkflowServerState {
  readonly settingsPath: string;
  readonly serverNames: string[];
}

interface PathValue {
  readonly value: unknown;
  readonly hadKey: boolean;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getAtPath(
  settings: Record<string, unknown>,
  key: SettingsJsonPersistentValueKey
): PathValue {
  let current: unknown = settings;

  for (const segment of key.split(".")) {
    if (!isJsonObject(current)) {
      return { value: undefined, hadKey: false };
    }

    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return { value: undefined, hadKey: false };
    }

    current = current[segment];
  }

  return { value: current, hadKey: true };
}

function setAtPath(
  settings: Record<string, unknown>,
  key: SettingsJsonPersistentValueKey,
  value: unknown
): void {
  const segments = key.split(".");
  const leaf = segments.pop()!;
  let current = settings;

  for (const segment of segments) {
    if (!isJsonObject(current[segment])) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }

  current[leaf] = value;
}

function deleteAtPath(
  settings: Record<string, unknown>,
  key: SettingsJsonPersistentValueKey
): void {
  const segments = key.split(".");
  const leaf = segments.pop()!;
  let current: unknown = settings;

  for (const segment of segments) {
    if (
      !isJsonObject(current) ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return;
    }
    current = current[segment];
  }

  if (isJsonObject(current)) {
    delete current[leaf];
  }
}

/**
 * Tracks MCP server lifecycle in a JSON config file for Qwen, Antigravity,
 * and Antigravity CLIs. It also manages persistent config values such as
 * Antigravity's statusline registration.
 *
 * These CLIs auto-discover MCP servers from a JSON file's `mcpServers` key
 * (`.{tool}/settings.json` for Qwen, `.agents/mcp_config.json` for
 * Antigravity). When multiple
 * parallel workflows add/remove MCP servers, this tracker ensures:
 *
 * 1. **Reference counting** — servers aren't removed from settings.json while
 *    another workflow still needs them.
 * 2. **Scoped access** — each prompt gets `--allowed-mcp-server-names` with only
 *    its explicitly configured servers plus any pre-existing baseline servers.
 * 3. **Baseline preservation** — servers configured outside ctrlyoke are never
 *    removed and are always included in allowed lists.
 * 4. **Idempotent adds** — if a server already exists in settings.json (from another
 *    workflow or manually configured), it's not re-written.
 * 5. **File-level serialization** — an async mutex prevents concurrent read-modify-write
 *    races on the shared settings.json file between parallel workflows.
 *
 * Usage per tool (one static singleton per tool name):
 * ```typescript
 * const tracker = SettingsJsonMcpTracker.getInstance("qwen");
 * // Before prompt: register servers and get allowed names
 * const allowed = await tracker.registerServers(workflowKey, workspaceRoot, entries);
 * // Build CLI args: --allowed-mcp-server-names ...allowed
 * // After workflow: unregister and clean up
 * await tracker.unregisterWorkflow(workflowKey, workspaceRoot);
 * // For non-MCP mutations (hooks), use withLock to serialize:
 * await tracker.withLock(async () => { ... });
 * ```
 */
export class SettingsJsonMcpTracker {
  // ============================================================
  // SINGLETON PER TOOL
  // ============================================================

  private static instances = new Map<string, SettingsJsonMcpTracker>();

  /**
   * Get or create the singleton tracker for a tool.
   *
   * @param toolName CLI tool name (for example "qwen" or "antigravity")
   */
  static getInstance(
    toolName: string,
    options?: SettingsJsonMcpTrackerOptions
  ): SettingsJsonMcpTracker {
    let instance = this.instances.get(toolName);
    if (!instance) {
      instance = new SettingsJsonMcpTracker(toolName, options);
      this.instances.set(toolName, instance);
    }
    return instance;
  }

  /** Reset all tracker state. Intended for tests only. */
  static resetAll(): void {
    this.instances.clear();
  }

  // ============================================================
  // INSTANCE STATE
  // ============================================================

  /** Tool's settings subdirectory (e.g. ".qwen") */
  private readonly settingsSubdir: string;

  /** Resolves the project-level config file path from a workspace root. */
  private readonly projectConfigPath: (workspaceRoot: string) => string;

  /** Resolves the user-level config file path. */
  private readonly userConfigPath: () => string;

  /** Property containing MCP server entries in this tool's config schema. */
  private readonly mcpServersProperty: string;

  /** Optional schema URL added only while ctrlyoke owns file mutations. */
  private readonly schemaUrl: string | undefined;

  /** In-process mutex for serializing tracker read-modify-write operations. */
  private readonly mutex = new AsyncMutex();

  /** Baseline snapshots keyed by the resolved config file path. */
  private readonly baselines = new Map<string, BaselineState>();

  /** Temporary .gitignore paths keyed by the config file they protect. */
  private gitignorePaths = new Map<string, string>();

  /** Reference counts per resolved config file and managed server name. */
  private refCounts = new Map<string, Map<string, number>>();

  /** Per-workflow tracking, including the config file used at registration. */
  private workflowServers = new Map<string, WorkflowServerState>();

  /** Inserted values keyed by config path, to preserve user edits during cleanup. */
  private managedServerValues = new Map<string, Map<string, unknown>>();

  private constructor(
    private readonly toolName: string,
    options?: SettingsJsonMcpTrackerOptions
  ) {
    this.settingsSubdir = `.${toolName}`;
    this.projectConfigPath =
      options?.projectConfigPath ??
      ((workspaceRoot: string) =>
        path.join(workspaceRoot, this.settingsSubdir, "settings.json"));
    this.userConfigPath =
      options?.userConfigPath ??
      (() => path.join(os.homedir(), this.settingsSubdir, "settings.json"));
    this.mcpServersProperty = options?.mcpServersProperty ?? "mcpServers";
    this.schemaUrl = options?.schemaUrl;
  }

  // ============================================================
  // FILE-LEVEL LOCK
  // ============================================================

  /**
   * Execute a callback while holding this process's settings mutation mutex.
   *
   * This does not provide cross-process locking. Tracker-owned file mutations
   * use `withFileLock()` around this mutex; callers that use this hook for
   * another tracker must provide the appropriate file lock themselves.
   *
   * Use this to wrap non-MCP read-modify-write operations (e.g., hooks
   * backup/restore) that touch the same settings.json file. MCP operations
   * (`registerServers`, `unregisterWorkflow`) acquire the lock internally.
   *
   * @param fn Async callback to execute under the lock
   * @returns The callback's return value
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.mutex.acquire();
    try {
      return await fn();
    } finally {
      this.mutex.release();
    }
  }

  /** Serialize one tracker mutation both within and across ctrlyoke processes. */
  private async withMutationLock<T>(
    settingsPath: string,
    fn: () => Promise<T>
  ): Promise<T> {
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    return withFileLock(settingsPath, () => this.withLock(fn));
  }

  private getBaseline(settingsPath: string): BaselineState {
    return (
      this.baselines.get(settingsPath) ?? {
        settingsFileExisted: false,
        hadMcpServers: false,
        hadSchema: false,
        servers: new Set<string>(),
      }
    );
  }

  private getProjectConfigPath(workspaceRoot: string): string {
    return path.resolve(this.projectConfigPath(workspaceRoot));
  }

  private getUserConfigPath(): string {
    return path.resolve(this.userConfigPath());
  }

  // ============================================================
  // BASELINE CAPTURE
  // ============================================================

  /**
   * Capture pre-existing MCP server names from project and user-level settings.
   *
   * Reads both `{workspaceRoot}/.{tool}/settings.json` and `~/.{tool}/settings.json`
   * to discover all servers configured before ctrlyoke runs. These servers are
   * always included in `--allowed-mcp-server-names` and never removed by cleanup.
   *
   * Called lazily on first use per workspace root. Thread-safe (idempotent).
   */
  async captureBaseline(workspaceRoot: string): Promise<void> {
    const projectSettings = this.getProjectConfigPath(workspaceRoot);
    const userSettings = this.getUserConfigPath();

    for (const filePath of new Set([projectSettings, userSettings])) {
      if (this.baselines.has(filePath)) {
        continue;
      }

      const baseline: BaselineState = {
        settingsFileExisted: false,
        hadMcpServers: false,
        hadSchema: false,
        servers: new Set(),
      };
      try {
        const content = await fs.readFile(filePath, "utf-8");
        const settings = JSON.parse(content) as Record<string, unknown>;
        baseline.settingsFileExisted = true;
        baseline.hadSchema = "$schema" in settings;
        const mcpServers = settings[this.mcpServersProperty];
        if (mcpServers && typeof mcpServers === "object") {
          baseline.hadMcpServers = true;
          for (const name of Object.keys(mcpServers)) {
            baseline.servers.add(name);
          }
        }
      } catch {
        // File doesn't exist or invalid JSON — skip
      }
      this.baselines.set(filePath, baseline);
    }

    const baselineServers = new Set<string>();
    for (const filePath of [projectSettings, userSettings]) {
      for (const name of this.getBaseline(filePath).servers) {
        baselineServers.add(name);
      }
    }
    Log.debug(
      `[SettingsJsonMcpTracker] ${this.toolName} MCP baseline captured for ${projectSettings}: [${[...baselineServers].join(", ")}]`
    );
  }

  // ============================================================
  // REGISTER / UNREGISTER
  // ============================================================

  /**
   * Register MCP servers for a workflow and merge them into settings.json.
   *
   * - Increments ref counts only when this workflow first registers a server.
   * - Only writes new entries to settings.json (skips existing ones).
   * - Tracks which servers belong to this workflow for cleanup.
   *
   * @param workflowKey Unique key for this workflow (typically workingFilePath)
   * @param workspaceRoot Workspace root directory
   * @param servers MCP server entries keyed by server name (from buildSettingsJsonMcpEntries)
   * @returns Server names that were registered for this workflow
   */
  async registerServers(
    workflowKey: string,
    workspaceRoot: string,
    servers: Record<string, unknown>,
    options?: SettingsJsonMcpRegisterOptions
  ): Promise<string[]> {
    await this.captureBaseline(workspaceRoot);

    const settingsPath = this.getProjectConfigPath(workspaceRoot);
    const serverNames = Object.keys(servers);
    if (serverNames.length === 0) {
      return [];
    }

    // A provider builds CLI args once per prompt, so a multi-step workflow can
    // register the same MCP server repeatedly. Count each server at most once
    // per workflow; cleanup likewise unregisters each workflow/server pair
    // once. Without this, a completed multi-step workflow leaves stale MCP
    // entries behind because its ref count is incremented per step but
    // decremented only once during workflow cleanup.
    const existingState = this.workflowServers.get(workflowKey);
    const existing = existingState?.serverNames ?? [];
    const newServerNames = serverNames.filter(
      (name) => !existing.includes(name)
    );
    this.workflowServers.set(workflowKey, {
      settingsPath,
      serverNames: [...new Set([...existing, ...serverNames])],
    });

    // Increment ref counts only for newly associated workflow/server pairs.
    let pathRefCounts = this.refCounts.get(settingsPath);
    if (!pathRefCounts) {
      pathRefCounts = new Map();
      this.refCounts.set(settingsPath, pathRefCounts);
    }
    for (const name of newServerNames) {
      pathRefCounts.set(name, (pathRefCounts.get(name) ?? 0) + 1);
    }

    // Serialize the complete read-modify-write across processes as well as
    // within this process.
    await this.withMutationLock(settingsPath, async () => {
      const settings = await this.readProjectConfig(settingsPath);

      const existingMcp =
        (settings[this.mcpServersProperty] as
          Record<string, unknown> | undefined) ?? {};
      let changed = false;

      for (const [name, config] of Object.entries(servers)) {
        if (!(name in existingMcp)) {
          existingMcp[name] = config;
          let pathManagedValues = this.managedServerValues.get(settingsPath);
          if (!pathManagedValues) {
            pathManagedValues = new Map();
            this.managedServerValues.set(settingsPath, pathManagedValues);
          }
          pathManagedValues.set(name, this.cloneJson(config));
          changed = true;
        }
      }

      if (changed) {
        settings[this.mcpServersProperty] = existingMcp;
        this.addOwnedSchema(settings);
        await fs.mkdir(path.dirname(settingsPath), {
          recursive: true,
        });
        await writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2));
        if (options?.fileMode !== undefined) {
          await fs.chmod(settingsPath, options.fileMode).catch(() => undefined);
        }
        Log.debug(
          `[SettingsJsonMcpTracker] ${this.toolName} MCP servers added to settings.json: [${serverNames.join(", ")}]`
        );

        if (!this.getBaseline(settingsPath).settingsFileExisted) {
          await this.writeGitignore(settingsPath);
        }
      } else {
        if (options?.fileMode !== undefined) {
          await fs.chmod(settingsPath, options.fileMode).catch(() => undefined);
        }
        Log.debug(
          `[SettingsJsonMcpTracker] ${this.toolName} MCP servers already in settings.json: [${serverNames.join(", ")}]`
        );
      }
    });

    return serverNames;
  }

  /**
   * Unregister a workflow and remove its servers from settings.json if no longer needed.
   *
   * Decrements ref counts for each server this workflow registered. Servers
   * whose ref count reaches 0 AND are not in the baseline set are removed
   * from settings.json.
   *
   * @param workflowKey Unique key for this workflow (typically workingFilePath)
   * @param workspaceRoot Workspace root directory
   */
  async unregisterWorkflow(
    workflowKey: string,
    _workspaceRoot: string
  ): Promise<void> {
    const workflowState = this.workflowServers.get(workflowKey);
    if (!workflowState || workflowState.serverNames.length === 0) {
      this.workflowServers.delete(workflowKey);
      return;
    }
    const { settingsPath, serverNames } = workflowState;
    const pathRefCounts = this.refCounts.get(settingsPath);

    // Decrement ref counts and determine which servers to remove
    const toRemove: string[] = [];
    for (const name of serverNames) {
      const count = (pathRefCounts?.get(name) ?? 1) - 1;
      if (count <= 0) {
        pathRefCounts?.delete(name);
        // Only remove from settings if it wasn't a baseline server
        if (!this.getBaseline(settingsPath).servers.has(name)) {
          toRemove.push(name);
        }
      } else {
        pathRefCounts?.set(name, count);
      }
    }
    if (pathRefCounts?.size === 0) {
      this.refCounts.delete(settingsPath);
    }

    this.workflowServers.delete(workflowKey);

    // Remove zero-ref servers from settings.json (serialized under mutex)
    if (toRemove.length > 0) {
      await this.withMutationLock(settingsPath, async () => {
        try {
          const settings = JSON.parse(
            await fs.readFile(settingsPath, "utf-8")
          ) as Record<string, unknown>;
          const mcpServers = settings[this.mcpServersProperty] as
            Record<string, unknown> | undefined;
          if (mcpServers) {
            for (const name of toRemove) {
              const pathManagedValues =
                this.managedServerValues.get(settingsPath);
              const managedValue = pathManagedValues?.get(name);
              if (
                managedValue !== undefined &&
                this.jsonEquals(mcpServers[name], managedValue)
              ) {
                delete mcpServers[name];
              } else if (managedValue !== undefined) {
                Log.warn(
                  `[SettingsJsonMcpTracker] ${this.toolName} MCP cleanup preserved user-modified server "${name}"`
                );
              }
              pathManagedValues?.delete(name);
            }
            if (this.managedServerValues.get(settingsPath)?.size === 0) {
              this.managedServerValues.delete(settingsPath);
            }
            if (
              Object.keys(mcpServers).length === 0 &&
              !this.getBaseline(settingsPath).hadMcpServers
            ) {
              delete settings[this.mcpServersProperty];
            } else {
              settings[this.mcpServersProperty] = mcpServers;
            }

            await this.writeOrRemoveManagedConfig(settingsPath, settings);
            Log.debug(
              `[SettingsJsonMcpTracker] ${this.toolName} MCP servers removed from settings.json: [${toRemove.join(", ")}]`
            );
          }
        } catch {
          // Settings file gone — nothing to clean up
        }
      });
    }

    if (
      !this.refCounts.has(settingsPath) &&
      !this.getBaseline(settingsPath).settingsFileExisted
    ) {
      await this.deleteCtrlYokeGitignore(settingsPath);
    }
  }

  // ============================================================
  // PERSISTENT CONFIG VALUE
  // ============================================================

  /**
   * Install the persistent statusLine value.
   *
   * The callback is part of the locked read/check/capture/write sequence. This
   * ordering lets a caller persist a captured user value before replacing the
   * only copy in the harness settings file.
   */
  async installPersistentValue(
    workspaceRoot: string,
    key: SettingsJsonPersistentValueKey,
    value: unknown,
    capture?: SettingsJsonPersistentValueCapture,
    alreadyInstalled?: SettingsJsonPersistentValueAlreadyInstalled
  ): Promise<SettingsJsonPersistentValueInstallResult> {
    const settingsPath = this.getProjectConfigPath(workspaceRoot);

    return this.withMutationLock(settingsPath, async () => {
      const settings = await this.readProjectConfig(settingsPath);
      const existing = getAtPath(settings, key);
      const hadKey = existing.hadKey;
      const preexistingValue = this.cloneJson(existing.value);

      if (
        alreadyInstalled?.(this.cloneJson(existing.value), hadKey) === true ||
        (hadKey && this.jsonEquals(preexistingValue, value)) ||
        (!hadKey && value === undefined)
      ) {
        return {
          kind: "no-op",
          preexistingValue,
          hadKey,
        };
      }

      const captureResult = await capture?.(
        this.cloneJson(preexistingValue),
        hadKey
      );
      if (captureResult !== undefined && captureResult.proceed === false) {
        return {
          kind: "declined",
          preexistingValue,
          hadKey,
        };
      }

      setAtPath(settings, key, this.cloneJson(value));
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2));
      return {
        kind: "written",
        preexistingValue,
        hadKey,
      };
    });
  }

  /** The current value at `key`, `undefined` when absent. Unlocked read. */
  async readPersistentValue(
    workspaceRoot: string,
    key: SettingsJsonPersistentValueKey
  ): Promise<unknown> {
    const settings = await this.readProjectConfig(
      this.getProjectConfigPath(workspaceRoot)
    );
    return getAtPath(settings, key).value;
  }

  /**
   * Restore or delete the persistent statusLine value while holding the
   * settings-file mutation lock.
   */
  async uninstallPersistentValue(
    workspaceRoot: string,
    key: SettingsJsonPersistentValueKey,
    operation: SettingsJsonPersistentValueUninstall
  ): Promise<void> {
    const settingsPath = this.getProjectConfigPath(workspaceRoot);

    await this.withMutationLock(settingsPath, async () => {
      const settings = await this.readProjectConfig(settingsPath);
      const existing = getAtPath(settings, key);
      const hadKey = existing.hadKey;

      if (operation.action === "restore") {
        if (hadKey && this.jsonEquals(existing.value, operation.value)) {
          return;
        }
        setAtPath(settings, key, this.cloneJson(operation.value));
      } else {
        if (!hadKey) {
          return;
        }
        deleteAtPath(settings, key);
      }

      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2));
    });
  }

  private async readProjectConfig(
    settingsPath: string
  ): Promise<Record<string, unknown>> {
    try {
      return JSON.parse(await fs.readFile(settingsPath, "utf-8")) as Record<
        string,
        unknown
      >;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw new Error(
        `Cannot safely update ${settingsPath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private addOwnedSchema(settings: Record<string, unknown>): void {
    if (this.schemaUrl && !("$schema" in settings)) {
      settings.$schema = this.schemaUrl;
    }
  }

  private async writeOrRemoveManagedConfig(
    settingsPath: string,
    settings: Record<string, unknown>
  ): Promise<void> {
    const hasManagedState = (this.refCounts.get(settingsPath)?.size ?? 0) > 0;
    if (
      !hasManagedState &&
      this.schemaUrl &&
      !this.getBaseline(settingsPath).hadSchema &&
      settings.$schema === this.schemaUrl
    ) {
      delete settings.$schema;
    }

    if (
      !this.getBaseline(settingsPath).settingsFileExisted &&
      Object.keys(settings).length === 0
    ) {
      await fs.unlink(settingsPath).catch(() => {});
      return;
    }
    await writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2));
  }

  private cloneJson<T>(value: T): T {
    return value === undefined
      ? value
      : (JSON.parse(JSON.stringify(value)) as T);
  }

  private jsonEquals(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  /**
   * Hide a config file created by ctrlyoke from Git while it is needed by an
   * active workflow. The file ignores itself as well, and user-owned
   * .gitignore files are never modified.
   */
  private async writeGitignore(settingsPath: string): Promise<void> {
    if (this.gitignorePaths.has(settingsPath)) {
      return;
    }

    const gitignorePath = path.join(path.dirname(settingsPath), ".gitignore");
    try {
      await fs.access(gitignorePath);
      return;
    } catch {
      // File doesn't exist — write a temporary ctrlyoke-owned one.
    }

    const content = [
      "# ctrlyoke temp files (auto-managed, do not commit)",
      path.basename(settingsPath),
      ".gitignore",
      "",
    ].join("\n");
    await fs.writeFile(gitignorePath, content, "utf-8").catch(() => {});
    this.gitignorePaths.set(settingsPath, gitignorePath);
  }

  /** Delete the temporary .gitignore only when it still has ctrlyoke's marker. */
  private async deleteCtrlYokeGitignore(settingsPath: string): Promise<void> {
    const gitignorePath = this.gitignorePaths.get(settingsPath);
    this.gitignorePaths.delete(settingsPath);
    if (!gitignorePath) {
      return;
    }

    try {
      const content = await fs.readFile(gitignorePath, "utf-8");
      if (content.startsWith("# ctrlyoke temp files")) {
        await fs.unlink(gitignorePath).catch(() => {});
      }
    } catch {
      // File doesn't exist or is unreadable — nothing to clean up.
    }
  }

  // ============================================================
  // QUERY
  // ============================================================
}
