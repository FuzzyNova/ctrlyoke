import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import { Log } from "../../../utils/Log";

/**
 * Simple async mutex for serializing read-modify-write operations on settings.json.
 *
 * Node.js is single-threaded, but async gaps between `readFile` and `writeFile`
 * allow interleaving when multiple parallel workflows modify the same file.
 * This mutex ensures at most one read-modify-write cycle runs at a time.
 */
class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }
}

/**
 * Options for customizing where a tracker reads/writes its MCP config.
 *
 * Defaults reproduce the Qwen behavior (`.{tool}/settings.json` in the
 * project, `~/.{tool}/settings.json` for the user). Antigravity overrides these
 * to use `.agents/mcp_config.json` (project) and `~/.gemini/config/mcp_config.json`
 * (user), and those files hold a bare `{ "mcpServers": {...} }` object.
 */
export interface SettingsJsonMcpTrackerOptions {
  /** Resolve the project-level config file path. Default: `<ws>/.<tool>/settings.json`. */
  projectConfigPath?: (workspaceRoot: string) => string;
  /** Resolve the user-level config file path. Default: `~/.<tool>/settings.json`. */
  userConfigPath?: () => string;
}

/**
 * Tracks MCP server lifecycle in a JSON config file for Qwen and
 * Antigravity CLIs.
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

  /** Async mutex for serializing all read-modify-write operations on settings.json. */
  private readonly mutex = new AsyncMutex();

  /** MCP server names that existed before ctrlyoke modified anything. */
  private baselineServers = new Set<string>();

  /** Whether baseline capture has completed for this workspace. */
  private baselineCapturedForWorkspace: string | undefined;

  /** Whether the project settings.json existed before ctrlyoke touched it. */
  private baselineProjectSettingsFileExisted = false;

  /** Whether the project settings.json originally had an mcpServers property. */
  private baselineProjectHadMcpServers = false;

  /** Path to the temporary .gitignore written for a newly-created config file. */
  private gitignorePath: string | undefined;

  /** Reference count per ctrlyoke-managed server name. */
  private refCounts = new Map<string, number>();

  /** Per-workflow tracking: which server names each workflow registered. */
  private workflowServers = new Map<string, string[]>();

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
  }

  // ============================================================
  // FILE-LEVEL LOCK
  // ============================================================

  /**
   * Execute a callback while holding the settings.json file lock.
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
    if (this.baselineCapturedForWorkspace === workspaceRoot) {
      return;
    }

    const projectSettings = this.projectConfigPath(workspaceRoot);
    const userSettings = this.userConfigPath();

    this.baselineProjectSettingsFileExisted = false;
    this.baselineProjectHadMcpServers = false;

    for (const filePath of [projectSettings, userSettings]) {
      try {
        const content = await fs.readFile(filePath, "utf-8");
        if (filePath === projectSettings) {
          this.baselineProjectSettingsFileExisted = true;
        }
        const settings = JSON.parse(content);
        if (settings.mcpServers && typeof settings.mcpServers === "object") {
          if (filePath === projectSettings) {
            this.baselineProjectHadMcpServers = true;
          }
          for (const name of Object.keys(settings.mcpServers)) {
            this.baselineServers.add(name);
          }
        }
      } catch {
        // File doesn't exist or invalid JSON — skip
      }
    }

    this.baselineCapturedForWorkspace = workspaceRoot;
    Log.debug(
      `📋 ${this.toolName} MCP baseline captured: [${[...this.baselineServers].join(", ")}]`
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

    // Serialize the file read-modify-write under the mutex
    await this.mutex.acquire();
    try {
      const settingsPath = this.projectConfigPath(workspaceRoot);
      let settings: Record<string, unknown> = {};
      try {
        settings = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
      } catch {
        // Start fresh
      }

      const existingMcp =
        (settings.mcpServers as Record<string, unknown> | undefined) ?? {};
      let changed = false;

      for (const [name, config] of Object.entries(servers)) {
        if (!(name in existingMcp)) {
          existingMcp[name] = config;
          changed = true;
        }
      }

      if (changed) {
        settings.mcpServers = existingMcp;
        await fs.mkdir(path.dirname(settingsPath), {
          recursive: true,
        });
        await fs.writeFile(
          settingsPath,
          JSON.stringify(settings, null, 2),
          "utf-8"
        );
        Log.debug(
          `🔧 ${this.toolName} MCP servers added to settings.json: [${serverNames.join(", ")}]`
        );

        if (!this.baselineProjectSettingsFileExisted) {
          await this.writeGitignore(settingsPath);
        }
      } else {
        Log.debug(
          `♻️ ${this.toolName} MCP servers already in settings.json: [${serverNames.join(", ")}]`
        );
      }
    } finally {
      this.mutex.release();
    }

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
        if (!this.baselineServers.has(name)) {
          toRemove.push(name);
        }
      } else {
        this.refCounts.set(name, count);
      }
    }

    this.workflowServers.delete(workflowKey);

    // Remove zero-ref servers from settings.json (serialized under mutex)
    if (toRemove.length > 0) {
      await this.mutex.acquire();
      try {
        const settingsPath = this.projectConfigPath(workspaceRoot);
        try {
          const settings = JSON.parse(
            await fs.readFile(settingsPath, "utf-8")
          ) as Record<string, unknown>;
          const mcpServers = settings.mcpServers as
            | Record<string, unknown>
            | undefined;
          if (mcpServers) {
            for (const name of toRemove) {
              delete mcpServers[name];
            }
            if (
              Object.keys(mcpServers).length === 0 &&
              !this.baselineProjectHadMcpServers
            ) {
              delete settings.mcpServers;
            } else {
              settings.mcpServers = mcpServers;
            }

            if (
              !this.baselineProjectSettingsFileExisted &&
              Object.keys(settings).length === 0
            ) {
              await fs.unlink(settingsPath).catch(() => {});
            } else {
              await fs.writeFile(
                settingsPath,
                JSON.stringify(settings, null, 2),
                "utf-8"
              );
            }
            Log.debug(
              `🧹 ${this.toolName} MCP servers removed from settings.json: [${toRemove.join(", ")}]`
            );
          }
        } catch {
          // Settings file gone — nothing to clean up
        }
      } finally {
        this.mutex.release();
      }
    }

    if (this.refCounts.size === 0 && !this.baselineProjectSettingsFileExisted) {
      await this.deleteCtrlYokeGitignore();
    }
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
   * @param promptServerNames MCP server names configured for this prompt
   * @returns Array of allowed names, or undefined to skip the flag entirely
   */
  getAllowedServerNames(promptServerNames: string[]): string[] | undefined {
    // If no ctrlyoke-managed servers are active, don't restrict
    if (this.refCounts.size === 0) {
      return undefined;
    }

    // Combine baseline + this prompt's servers
    const allowed = new Set([...this.baselineServers, ...promptServerNames]);
    return [...allowed];
  }

  /**
   * Whether any ctrlyoke-managed servers are currently registered.
   * Used to decide if `--allowed-mcp-server-names` is needed.
   */
  hasActiveManagedServers(): boolean {
    return this.refCounts.size > 0;
  }

  /** Get baseline server names (for debugging/testing). */
  getBaselineServerNames(): ReadonlySet<string> {
    return this.baselineServers;
  }
}
