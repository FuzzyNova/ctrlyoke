import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import { randomUUID } from "crypto";
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

export type SettingsJsonPermissionDecision = "allow" | "ask" | "deny";
export type SettingsJsonPermissionPolicy = Record<
  string,
  | SettingsJsonPermissionDecision
  | Record<string, SettingsJsonPermissionDecision>
>;

interface ValueLease {
  normalizedRequestedValue: string;
  owners: Map<string, LeaseOwnerState>;
  baselineHadKey: boolean;
  baselineValue: unknown;
  appliedValue: unknown;
}

interface LeaseOwnerState {
  pid: number;
  token: string;
  workflowKey: string;
  ts: number;
}

interface LeaseSidecar {
  baseline: unknown;
  baselineHadKey: boolean;
  owners: LeaseOwnerState[];
  normalizedRequestedValue?: string;
  appliedValue?: unknown;
}

interface BaselineState {
  settingsFileExisted: boolean;
  hadMcpServers: boolean;
  hadSchema: boolean;
  servers: Set<string>;
}

/**
 * Tracks MCP server lifecycle in a JSON config file for Qwen, Antigravity,
 * and Antigravity CLIs. It also owns generic single-value leases used by
 * config-driven state such as Antigravity's statusline registration.
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

  /** Random identity component shared by every lease owned by this process. */
  private readonly processOwnerToken: string = randomUUID();

  /** Path to the temporary .gitignore written for a newly-created config file. */
  private gitignorePath: string | undefined;

  /** Reference count per ctrlyoke-managed server name. */
  private refCounts = new Map<string, number>();

  /** Per-workflow tracking: which server names each workflow registered. */
  private workflowServers = new Map<string, string[]>();

  /** Values ctrlyoke inserted, used to avoid deleting user edits during cleanup. */
  private managedServerValues = new Map<string, unknown>();

  /** Active single-value leases keyed by settings path and top-level key. */
  private valueLeases = new Map<string, ValueLease>();

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
      `📋 ${this.toolName} MCP baseline captured for ${projectSettings}: [${[...baselineServers].join(", ")}]`
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
    servers: Record<string, unknown>
  ): Promise<string[]> {
    await this.captureBaseline(workspaceRoot);

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
    const existing = this.workflowServers.get(workflowKey) ?? [];
    const newServerNames = serverNames.filter(
      (name) => !existing.includes(name)
    );
    this.workflowServers.set(workflowKey, [
      ...new Set([...existing, ...serverNames]),
    ]);

    // Increment ref counts only for newly associated workflow/server pairs.
    for (const name of newServerNames) {
      this.refCounts.set(name, (this.refCounts.get(name) ?? 0) + 1);
    }

    const settingsPath = this.getProjectConfigPath(workspaceRoot);
    // Serialize the complete read-modify-write across processes as well as
    // within this process.
    await this.withMutationLock(settingsPath, async () => {
      const settings = await this.readProjectConfig(settingsPath);

      const existingMcp =
        (settings[this.mcpServersProperty] as
          | Record<string, unknown>
          | undefined) ?? {};
      let changed = false;

      for (const [name, config] of Object.entries(servers)) {
        if (!(name in existingMcp)) {
          existingMcp[name] = config;
          this.managedServerValues.set(name, this.cloneJson(config));
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
        Log.debug(
          `🔧 ${this.toolName} MCP servers added to settings.json: [${serverNames.join(", ")}]`
        );

        if (!this.getBaseline(settingsPath).settingsFileExisted) {
          await this.writeGitignore(settingsPath);
        }
      } else {
        Log.debug(
          `♻️ ${this.toolName} MCP servers already in settings.json: [${serverNames.join(", ")}]`
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
    workspaceRoot: string
  ): Promise<void> {
    const serverNames = this.workflowServers.get(workflowKey);
    if (!serverNames || serverNames.length === 0) {
      this.workflowServers.delete(workflowKey);
      return;
    }

    // Decrement ref counts and determine which servers to remove
    const toRemove: string[] = [];
    for (const name of serverNames) {
      const count = (this.refCounts.get(name) ?? 1) - 1;
      if (count <= 0) {
        this.refCounts.delete(name);
        // Only remove from settings if it wasn't a baseline server
        if (!this.getBaseline(this.getProjectConfigPath(workspaceRoot)).servers.has(name)) {
          toRemove.push(name);
        }
      } else {
        this.refCounts.set(name, count);
      }
    }

    this.workflowServers.delete(workflowKey);

    // Remove zero-ref servers from settings.json (serialized under mutex)
    if (toRemove.length > 0) {
      const settingsPath = this.getProjectConfigPath(workspaceRoot);
      await this.withMutationLock(settingsPath, async () => {
        try {
          const settings = JSON.parse(
            await fs.readFile(settingsPath, "utf-8")
          ) as Record<string, unknown>;
          const mcpServers = settings[this.mcpServersProperty] as
            | Record<string, unknown>
            | undefined;
          if (mcpServers) {
            for (const name of toRemove) {
              const managedValue = this.managedServerValues.get(name);
              if (
                managedValue !== undefined &&
                this.jsonEquals(mcpServers[name], managedValue)
              ) {
                delete mcpServers[name];
              } else if (managedValue !== undefined) {
                Log.warn(
                  `${this.toolName} MCP cleanup preserved user-modified server "${name}"`
                );
              }
              this.managedServerValues.delete(name);
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
              `🧹 ${this.toolName} MCP servers removed from settings.json: [${toRemove.join(", ")}]`
            );
          }
        } catch {
          // Settings file gone — nothing to clean up
        }
      });
    }

    if (
      this.refCounts.size === 0 &&
      !this.hasValueLeaseForWorkspace(workspaceRoot) &&
      !this.getBaseline(this.getProjectConfigPath(workspaceRoot)).settingsFileExisted
    ) {
      await this.deleteCtrlYokeGitignore();
    }
  }

  // ============================================================
  // SINGLE-VALUE LEASE
  // ============================================================

  /**
   * Apply an ownership-aware value to the same project config used for MCP
   * servers. Identical values share one lease; conflicting values are rejected
   * without replacing another workflow's active controls.
   */
  async registerValueLease(
    workflowKey: string,
    workspaceRoot: string,
    key: string,
    value: unknown,
    merge: (existing: unknown, requested: unknown) => unknown = (
      _existing,
      requested
    ) => requested
  ): Promise<"acquired" | "shared"> {
    await this.captureBaseline(workspaceRoot);

    const settingsPath = this.getProjectConfigPath(workspaceRoot);
    return this.withMutationLock(settingsPath, async () => {
      const leaseKey = this.getLeaseKey(settingsPath, key);
      await this.pruneLeaseOwnersLocked(settingsPath, key);
      const normalizedRequestedValue = JSON.stringify(value);
      const ownerId = this.getOwnerId(workflowKey);
      let activeLease = this.valueLeases.get(leaseKey);

      if (activeLease) {
        if (activeLease.normalizedRequestedValue !== normalizedRequestedValue) {
          const otherOwners = [...activeLease.owners.entries()]
            .filter(([activeOwnerId]) => activeOwnerId !== ownerId)
            .map(([, owner]) => owner.workflowKey);
          if (otherOwners.length > 0) {
            const conflictDescription =
              key === "permission"
                ? "permission policy conflict"
                : `${key} value conflict`;
            throw new Error(
              `${this.toolName} ${conflictDescription} in ${settingsPath}; active owner: ${otherOwners[0]}`
            );
          }

          this.valueLeases.delete(leaseKey);
          await this.deleteLeaseSidecar(settingsPath, key);
          await this.restoreValueLease(settingsPath, key, activeLease);
          activeLease = undefined;
        } else {
          const wasShared = !activeLease.owners.has(ownerId);
          activeLease.owners.set(ownerId, {
            pid: process.pid,
            token: this.processOwnerToken,
            workflowKey,
            ts: Date.now(),
          });
          await this.writeLeaseSidecar(settingsPath, key, activeLease);
          return wasShared ? "shared" : "acquired";
        }
      }

      const settings = await this.readProjectConfig(settingsPath);
      const sidecar = await this.readLeaseSidecar(settingsPath, key);
      if (sidecar?.owners.length) {
        if (sidecar.normalizedRequestedValue !== normalizedRequestedValue) {
          const activeOwner = sidecar.owners[0].workflowKey;
          throw new Error(
            `${this.toolName} ${
              key === "permission" ? "permission policy conflict" : `${key} value conflict`
            } in ${settingsPath}; active owner: ${activeOwner}`
          );
        }

        const sharedLease: ValueLease = {
          normalizedRequestedValue,
          owners: new Map(
            sidecar.owners.map((owner) => [
              this.getOwnerId(owner.workflowKey, owner.pid, owner.token),
              owner,
            ])
          ),
          baselineHadKey: sidecar.baselineHadKey,
          baselineValue: this.cloneJson(sidecar.baseline),
          appliedValue: this.cloneJson(sidecar.appliedValue),
        };
        const wasShared = sharedLease.owners.has(ownerId);
        sharedLease.owners.set(ownerId, {
          pid: process.pid,
          token: this.processOwnerToken,
          workflowKey,
          ts: Date.now(),
        });
        this.valueLeases.set(leaseKey, sharedLease);
        await this.writeLeaseSidecar(settingsPath, key, sharedLease);
        return wasShared ? "acquired" : "shared";
      }
      const baselineHadKey = sidecar?.baselineHadKey ?? key in settings;
      const baselineValue = sidecar
        ? this.cloneJson(sidecar.baseline)
        : this.cloneJson(settings[key]);
      const appliedValue = merge(settings[key], value);

      settings[key] = appliedValue;
      this.addOwnedSchema(settings);
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2));
      if (!this.getBaseline(settingsPath).settingsFileExisted) {
        await this.writeGitignore(settingsPath);
      }

      const lease: ValueLease = {
        normalizedRequestedValue,
        owners: new Map(
          (sidecar?.owners ?? []).map((owner) => [
            this.getOwnerId(owner.workflowKey, owner.pid, owner.token),
            owner,
          ])
        ),
        baselineHadKey,
        baselineValue,
        appliedValue: this.cloneJson(appliedValue),
      };
      lease.owners.set(ownerId, {
        pid: process.pid,
        token: this.processOwnerToken,
        workflowKey,
        ts: Date.now(),
      });
      this.valueLeases.set(leaseKey, lease);
      Log.debug(
        `🔐 ${this.toolName} ${key} value lease applied to ${settingsPath}`
      );
      await this.writeLeaseSidecar(settingsPath, key, lease);
      return "acquired";
    });
  }

  /**
   * Release one workflow's value lease and restore the original value after the
   * final owner exits. User edits made while the workflow was running are
   * preserved instead of being overwritten.
   */
  async unregisterValueLease(
    workflowKey: string,
    workspaceRoot: string,
    key: string
  ): Promise<void> {
    const settingsPath = this.getProjectConfigPath(workspaceRoot);

    try {
      await this.withMutationLock(settingsPath, async () => {
        await this.pruneLeaseOwnersLocked(settingsPath, key);
        const leaseKey = this.getLeaseKey(settingsPath, key);
        const lease = this.valueLeases.get(leaseKey);
        if (!lease) {
          const sidecar = await this.readLeaseSidecar(settingsPath, key);
          if (!sidecar) {
            return;
          }
          const remainingOwners = sidecar.owners.filter(
            (owner) =>
              this.getOwnerId(owner.workflowKey, owner.pid, owner.token) !==
              this.getOwnerId(workflowKey)
          );
          if (remainingOwners.length > 0) {
            await writeFileAtomic(
              this.getLeaseSidecarPath(settingsPath, key),
              JSON.stringify({ ...sidecar, owners: remainingOwners }, null, 2)
            );
            return;
          }

          const settings = await this.readProjectConfig(settingsPath);
          if (sidecar.baselineHadKey) {
            settings[key] = this.cloneJson(sidecar.baseline);
          } else {
            delete settings[key];
          }
          await this.writeOrRemoveManagedConfig(settingsPath, settings);
          await this.deleteLeaseSidecar(settingsPath, key);
          return;
        }

        lease.owners.delete(this.getOwnerId(workflowKey));
        if (lease.owners.size > 0) {
          await this.writeLeaseSidecar(settingsPath, key, lease);
          return;
        }

        this.valueLeases.delete(leaseKey);
        await this.deleteLeaseSidecar(settingsPath, key);
        await this.restoreValueLease(settingsPath, key, lease);
      });
    } catch (error) {
      Log.warn(
        `${this.toolName} ${key} lease cleanup failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    if (
      this.refCounts.size === 0 &&
      !this.hasValueLeaseForWorkspace(workspaceRoot) &&
      !this.getBaseline(settingsPath).settingsFileExisted
    ) {
      await this.deleteCtrlYokeGitignore();
    }
  }

  /** Prune dead owners and restore the baseline when the lease is orphaned. */
  async pruneDeadOwners(workspaceRoot: string, key: string): Promise<void> {
    const settingsPath = this.getProjectConfigPath(workspaceRoot);
    try {
      await this.withMutationLock(settingsPath, async () => {
        await this.pruneLeaseOwnersLocked(settingsPath, key);
      });
    } catch (error) {
      Log.warn(
        `${this.toolName} ${key} dead-owner cleanup failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Return the value captured before the active lease was applied.
   *
   * Providers use this to forward a user's pre-existing configuration while
   * ctrlyoke temporarily owns the setting. Callers should only use the value
   * after successfully registering a lease.
   */
  getValueLeaseBaseline(workspaceRoot: string, key: string): unknown {
    const settingsPath = this.getProjectConfigPath(workspaceRoot);
    const lease = this.valueLeases.get(this.getLeaseKey(settingsPath, key));
    if (!lease || !lease.baselineHadKey) {
      return undefined;
    }
    return this.cloneJson(lease.baselineValue);
  }

  private getLeaseKey(settingsPath: string, key: string): string {
    return `${settingsPath}::${key}`;
  }

  private getOwnerId(
    workflowKey: string,
    pid = process.pid,
    token = this.processOwnerToken
  ): string {
    return `${pid}:${token}:${workflowKey}`;
  }

  private getLeaseSidecarPath(settingsPath: string, key: string): string {
    const sanitizedKey = key.replace(/[^a-zA-Z0-9._-]/g, "_");
    return path.join(
      path.dirname(settingsPath),
      `.ctrlyoke-lease-${sanitizedKey}.json`
    );
  }

  private isProcessAlive(pid: number): boolean {
    if (pid === process.pid) {
      return true;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  private async readLeaseSidecar(
    settingsPath: string,
    key: string
  ): Promise<LeaseSidecar | undefined> {
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.getLeaseSidecarPath(settingsPath, key), "utf-8")
      ) as Partial<LeaseSidecar>;
      if (
        typeof parsed.baselineHadKey !== "boolean" ||
        !Array.isArray(parsed.owners)
      ) {
        throw new Error("invalid lease sidecar shape");
      }
      return {
        baseline: parsed.baseline,
        baselineHadKey: parsed.baselineHadKey,
        owners: parsed.owners.filter(
          (owner): owner is LeaseOwnerState =>
            !!owner &&
            typeof owner === "object" &&
            typeof owner.pid === "number" &&
            typeof owner.token === "string" &&
            typeof owner.workflowKey === "string" &&
            typeof owner.ts === "number"
        ),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw new Error(
        `Cannot safely read lease state for ${settingsPath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async writeLeaseSidecar(
    settingsPath: string,
    key: string,
    lease: ValueLease
  ): Promise<void> {
    const sidecar: LeaseSidecar = {
      baseline: lease.baselineHadKey
        ? this.cloneJson(lease.baselineValue)
        : null,
      baselineHadKey: lease.baselineHadKey,
      owners: [...lease.owners.values()],
      normalizedRequestedValue: lease.normalizedRequestedValue,
      appliedValue: this.cloneJson(lease.appliedValue),
    };
    const sidecarPath = this.getLeaseSidecarPath(settingsPath, key);
    await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
    await writeFileAtomic(sidecarPath, JSON.stringify(sidecar, null, 2));
  }

  private async deleteLeaseSidecar(
    settingsPath: string,
    key: string
  ): Promise<void> {
    await fs
      .unlink(this.getLeaseSidecarPath(settingsPath, key))
      .catch(() => {});
  }

  private async pruneLeaseOwnersLocked(
    settingsPath: string,
    key: string
  ): Promise<void> {
    const sidecar = await this.readLeaseSidecar(settingsPath, key);
    if (!sidecar) {
      return;
    }

    const liveOwners = sidecar.owners.filter(
      (owner) =>
        this.isProcessAlive(owner.pid) &&
        (owner.pid !== process.pid || owner.token === this.processOwnerToken)
    );
    if (liveOwners.length > 0) {
      const lease = this.valueLeases.get(this.getLeaseKey(settingsPath, key));
      if (lease) {
        lease.owners = new Map(
          liveOwners.map((owner) => [
            this.getOwnerId(owner.workflowKey, owner.pid, owner.token),
            owner,
          ])
        );
        await this.writeLeaseSidecar(settingsPath, key, lease);
      } else if (liveOwners.length !== sidecar.owners.length) {
        await writeFileAtomic(
          this.getLeaseSidecarPath(settingsPath, key),
          JSON.stringify({ ...sidecar, owners: liveOwners }, null, 2)
        );
      }
      return;
    }

    const leaseKey = this.getLeaseKey(settingsPath, key);
    const activeLease = this.valueLeases.get(leaseKey);
    if (activeLease) {
      this.valueLeases.delete(leaseKey);
      await this.restoreValueLease(settingsPath, key, activeLease);
    } else {
      const settings = await this.readProjectConfig(settingsPath);
      if (sidecar.baselineHadKey) {
        settings[key] = this.cloneJson(sidecar.baseline);
      } else {
        delete settings[key];
      }
      await this.writeOrRemoveManagedConfig(settingsPath, settings);
    }
    await this.deleteLeaseSidecar(settingsPath, key);
  }

  private async restoreValueLease(
    settingsPath: string,
    key: string,
    lease: ValueLease
  ): Promise<void> {
    const settings = await this.readProjectConfig(settingsPath);
    if (!this.jsonEquals(settings[key], lease.appliedValue)) {
      Log.warn(
        key === "permission"
          ? `${this.toolName} permission cleanup preserved user-modified permission rules in ${settingsPath}`
          : `${this.toolName} ${key} cleanup preserved user-modified value in ${settingsPath}`
      );
      return;
    }

    if (lease.baselineHadKey) {
      settings[key] = this.cloneJson(lease.baselineValue);
    } else {
      delete settings[key];
    }
    await this.writeOrRemoveManagedConfig(settingsPath, settings);
    Log.debug(`🧹 ${this.toolName} ${key} value restored in ${settingsPath}`);
  }

  private hasValueLeaseForWorkspace(workspaceRoot: string): boolean {
    const settingsPath = this.getProjectConfigPath(workspaceRoot);
    return [...this.valueLeases.keys()].some((leaseKey) =>
      leaseKey.startsWith(`${settingsPath}::`)
    );
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
    const hasManagedState =
      this.refCounts.size > 0 ||
      [...this.valueLeases.keys()].some((leaseKey) =>
        leaseKey.startsWith(`${settingsPath}::`)
      );
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
    if (this.gitignorePath) {
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
    this.gitignorePath = gitignorePath;
  }

  /** Delete the temporary .gitignore only when it still has ctrlyoke's marker. */
  private async deleteCtrlYokeGitignore(): Promise<void> {
    const gitignorePath = this.gitignorePath;
    this.gitignorePath = undefined;
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

  /**
   * Get the `--allowed-mcp-server-names` values for a prompt.
   *
   * Returns `undefined` when no ctrlyoke-managed servers are active (no
   * restriction needed). Otherwise returns baseline servers plus the prompt's
   * explicitly configured server names.
   *
   * @param workspaceRoot Workspace root used to resolve the project config
   * @param promptServerNames MCP server names configured for this prompt
   * @returns Array of allowed names, or undefined to skip the flag entirely
   */
  getAllowedServerNames(
    workspaceRoot: string,
    promptServerNames: string[]
  ): string[] | undefined {
    // If no ctrlyoke-managed servers are active, don't restrict
    if (this.refCounts.size === 0) {
      return undefined;
    }

    const projectSettings = this.getProjectConfigPath(workspaceRoot);
    const userSettings = this.getUserConfigPath();
    const baselineServers = new Set<string>();
    for (const baseline of [
      this.getBaseline(projectSettings),
      this.getBaseline(userSettings),
    ]) {
      for (const name of baseline.servers) {
        baselineServers.add(name);
      }
    }
    const allowed = new Set([...baselineServers, ...promptServerNames]);
    return [...allowed];
  }
}
