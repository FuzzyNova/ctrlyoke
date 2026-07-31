import * as fs from "fs/promises";
import * as path from "path";
import { Log } from "../../../utils/Log";

type WorkflowHookLayers = {
  ctrlyoke: Record<string, unknown[]>;
  userHooks: Record<string, unknown[]>;
};

export type HookBaselinePolicy = {
  /** Discard provider-owned groups left behind by an interrupted/older run. */
  discardHookGroup?: (group: unknown) => boolean;
};

/**
 * Manages ctrlyoke hook injection into settings.json / hooks.json.
 *
 * Parallel safety: hooks injected by workflow A are preserved until A unregisters,
 * regardless of other workflows. Original hooks restored only on last unregister.
 *
 * Coordinates with SettingsJsonMcpTracker via shared mutex — both trackers
 * modify the same settings.json and must not interleave reads/writes.
 * Callers must wrap registerWorkflow/unregisterWorkflow inside mcpTracker.withLock().
 */
export class SettingsJsonHooksTracker {
  private static instances = new Map<string, SettingsJsonHooksTracker>();

  /** Original hooks section before any ctrlyoke workflow touched it. */
  private baselineHooksSection: Record<string, unknown> | null | undefined =
    undefined;

  /** Whether the target settings/hooks file existed before ctrlyoke touched it. */
  private baselineFileExisted: boolean | undefined = undefined;

  /** Path to a temporary .gitignore we wrote to hide newly-created settings files from git. */
  private gitignorePath: string | undefined;

  /** Per-workflow ctrlyoke hooks + user hooks, keyed by workflowKey. */
  private workflowHooks = new Map<string, WorkflowHookLayers>();

  private readonly toolName: string;
  /** Subdirectory under workspace root (e.g. ".qwen") */
  private readonly settingsDir: string;
  /** Filename within settingsDir. */
  private readonly settingsFile: string;

  private constructor(toolName: string) {
    this.toolName = toolName;
    this.settingsDir = `.${toolName}`;
    this.settingsFile = "settings.json";
  }

  static getInstance(toolName: string): SettingsJsonHooksTracker {
    let instance = this.instances.get(toolName);
    if (!instance) {
      instance = new SettingsJsonHooksTracker(toolName);
      this.instances.set(toolName, instance);
    }
    return instance;
  }

  /** Reset all tracker state. Intended for tests only. */
  static resetAll(): void {
    this.instances.clear();
  }

  /**
   * Register a workflow's hook injection.
   * Must be called under mcpTracker.withLock().
   */
  async registerWorkflow(
    workflowKey: string,
    workspaceRoot: string,
    ctrlyokeHooks: Record<string, unknown[]>,
    workflowUserHooks: Record<string, unknown[]>,
    baselinePolicy?: HookBaselinePolicy
  ): Promise<void> {
    const settingsPath = path.join(
      workspaceRoot,
      this.settingsDir,
      this.settingsFile
    );

    // First registration captures the baseline and records the original-case path
    if (this.workflowHooks.size === 0) {
      const baseline = await this.readBaseline(settingsPath, baselinePolicy);
      this.baselineHooksSection = baseline.hooks;
      this.baselineFileExisted = baseline.fileExisted;
    }

    // Track this workflow's hooks
    this.workflowHooks.set(workflowKey, {
      ctrlyoke: ctrlyokeHooks,
      userHooks: workflowUserHooks,
    });

    // Rebuild and write merged settings
    await this.rebuildAndWriteSettings(settingsPath, workspaceRoot);

    // On first registration: if we just created the settings file fresh, hide it from git.
    if (this.workflowHooks.size === 1 && this.baselineFileExisted === false) {
      await this.writeGitignore(workspaceRoot);
    }
  }

  /**
   * Unregister a workflow. Restores baseline when last workflow unregisters.
   * Must be called under mcpTracker.withLock().
   */
  async unregisterWorkflow(
    workflowKey: string,
    workspaceRoot: string
  ): Promise<void> {
    if (!this.workflowHooks.has(workflowKey)) {
      return;
    }

    this.workflowHooks.delete(workflowKey);

    const settingsPath = path.join(
      workspaceRoot,
      this.settingsDir,
      this.settingsFile
    );

    if (this.workflowHooks.size === 0) {
      // Last workflow — restore baseline
      await this.restoreBaseline(settingsPath);
      this.baselineHooksSection = undefined;
      this.baselineFileExisted = undefined;
    } else {
      // Other workflows still active — rebuild without this one
      await this.rebuildAndWriteSettings(settingsPath, workspaceRoot);
    }
  }

  getActiveWorkflowCount(): number {
    return this.workflowHooks.size;
  }

  /**
   * Write a temporary .gitignore to hide newly-created settings files from git.
   * The .gitignore also hides itself, so neither file appears as untracked.
   * No-op if a .gitignore already exists in the settings directory (user-owned file).
   */
  private async writeGitignore(workspaceRoot: string): Promise<void> {
    const gitignorePath = path.join(
      workspaceRoot,
      this.settingsDir,
      ".gitignore"
    );
    try {
      await fs.access(gitignorePath);
      return; // Existing .gitignore — leave it alone
    } catch {
      // File doesn't exist — write it
    }
    const content = [
      "# ctrlyoke temp files (auto-managed, do not commit)",
      this.settingsFile,
      ".gitignore",
      "",
    ].join("\n");
    await fs.writeFile(gitignorePath, content, "utf-8").catch(() => {});
    this.gitignorePath = gitignorePath;
  }

  private async readBaseline(
    settingsPath: string,
    policy?: HookBaselinePolicy
  ): Promise<{
    fileExisted: boolean;
    hooks: Record<string, unknown> | null;
  }> {
    let content: string;
    try {
      content = await fs.readFile(settingsPath, "utf-8");
    } catch {
      return { fileExisted: false, hooks: null };
    }

    try {
      const settings = JSON.parse(content) as Record<string, unknown>;
      const hooks = this.asRecord(settings.hooks);
      const discardHookGroup = policy?.discardHookGroup;
      if (!hooks || !discardHookGroup) {
        return {
          fileExisted: true,
          hooks,
        };
      }

      let discardedGroup = false;
      const sanitizedHooks = Object.fromEntries(
        Object.entries(hooks).map(([event, value]) => {
          if (!Array.isArray(value)) {
            return [event, value];
          }
          const retainedGroups = value.filter((group) => {
            if (!discardHookGroup(group)) {
              return true;
            }
            discardedGroup = true;
            return false;
          });
          return [event, retainedGroups];
        })
      );
      const hasRetainedHookData = Object.values(sanitizedHooks).some((value) =>
        Array.isArray(value)
          ? value.length > 0
          : this.asRecord(value)
            ? Object.keys(this.asRecord(value)!).length > 0
            : value !== null && value !== undefined
      );
      const hasOtherSettings = Object.keys(settings).some(
        (key) => key !== "hooks"
      );
      const containedOnlyDiscardedGroups =
        discardedGroup && !hasRetainedHookData && !hasOtherSettings;

      return {
        // Treat an otherwise-empty provider-owned file like one ctrlyoke
        // originally created so last-unregister removes it instead of restoring
        // stale generated hooks as the baseline.
        fileExisted: !containedOnlyDiscardedGroups,
        hooks: containedOnlyDiscardedGroups ? null : sanitizedHooks,
      };
    } catch {
      return { fileExisted: true, hooks: null };
    }
  }

  private async rebuildAndWriteSettings(
    settingsPath: string,
    workspaceRoot: string
  ): Promise<void> {
    // Read current settings (preserving non-hooks keys like mcpServers)
    let settings: Record<string, unknown> = {};
    try {
      const content = await fs.readFile(settingsPath, "utf-8");
      settings = JSON.parse(content);
    } catch {
      // File doesn't exist — start fresh
    }

    const { events: baseHooks } = this.getBaselineHooksData();

    // Collect all event names
    const allEvents = new Set<string>();
    for (const key of Object.keys(baseHooks)) {
      allEvents.add(key);
    }
    for (const wfHooks of this.workflowHooks.values()) {
      for (const key of Object.keys(wfHooks.ctrlyoke)) {
        allEvents.add(key);
      }
      for (const key of Object.keys(wfHooks.userHooks)) {
        allEvents.add(key);
      }
    }

    // Merge: ctrlyoke first, workflow user hooks middle, baseline last
    const mergedHooks: Record<string, unknown[]> = {};
    for (const event of allEvents) {
      const eventGroups: unknown[] = [];
      for (const wfHooks of this.workflowHooks.values()) {
        for (const group of wfHooks.ctrlyoke[event] ?? []) {
          eventGroups.push(group);
        }

        for (const group of wfHooks.userHooks[event] ?? []) {
          eventGroups.push(group);
        }
      }

      const baselineHandlers = baseHooks[event] ?? [];
      baselineHandlers.forEach((group) => {
        eventGroups.push(group);
      });

      mergedHooks[event] = eventGroups;
    }

    settings.hooks = mergedHooks;

    await fs.mkdir(path.join(workspaceRoot, this.settingsDir), {
      recursive: true,
    });
    await fs.writeFile(
      settingsPath,
      JSON.stringify(settings, null, 2),
      "utf-8"
    );
  }

  private async restoreBaseline(settingsPath: string): Promise<void> {
    try {
      if (this.baselineFileExisted === false) {
        await fs.unlink(settingsPath).catch(() => {});
        if (this.gitignorePath) {
          await fs.unlink(this.gitignorePath).catch(() => {});
          this.gitignorePath = undefined;
        }
        return;
      }

      let settings: Record<string, unknown> = {};
      try {
        const content = await fs.readFile(settingsPath, "utf-8");
        settings = JSON.parse(content);
      } catch {
        return;
      }

      if (this.baselineHooksSection === null) {
        delete settings.hooks;
      } else {
        settings.hooks = this.baselineHooksSection;
      }

      await fs.writeFile(
        settingsPath,
        JSON.stringify(settings, null, 2),
        "utf-8"
      );
    } catch (error) {
      Log.warn(
        `Failed to restore hooks baseline for ${this.toolName}: ${error}`
      );
    }
  }

  private getBaselineHooksData(): {
    events: Record<string, unknown[]>;
  } {
    const events: Record<string, unknown[]> = {};
    const hooksSection = this.baselineHooksSection;
    if (!hooksSection) {
      return { events };
    }

    for (const [key, value] of Object.entries(hooksSection)) {
      if (Array.isArray(value)) {
        events[key] = [...value];
      }
    }

    return { events };
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || Array.isArray(value) || typeof value !== "object") {
      return null;
    }
    return value as Record<string, unknown>;
  }
}
