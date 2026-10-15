import * as fs from "fs/promises";
import * as path from "path";
import { PROMPT_PROPERTIES } from "../../../types/DashboardConstants";
import { withFileLock } from "../../../utils/FileLockUtils";
import { Log } from "../../../utils/Log";
import { AsyncMutex } from "./AsyncMutex";

type WorkflowHookLayers = {
  ctrlyoke: Record<string, unknown[]>;
  userHooks: Record<string, unknown[]>;
};

type WorkflowHooks = {
  settingsPath: string;
  layers: WorkflowHookLayers;
};

type HooksBaseline = {
  hooks: Record<string, unknown> | null;
  fileExisted: boolean;
  dirExisted: boolean;
  gitignorePath: string | undefined;
};

export type HookBaselinePolicy = {
  /** Discard provider-owned groups left behind by an interrupted/older run. */
  discardHookGroup?: (group: unknown) => boolean;
};

/**
 * Manages ctrlyoke hook injection into settings.json / hooks.json.
 *
 * Hook state is isolated by resolved settings path. The in-process mutex
 * serializes callers in this host, and a file lock protects baseline capture
 * and writes from other ctrlyoke processes using the same settings file.
 */
export class SettingsJsonHooksTracker {
  private static instances = new Map<string, SettingsJsonHooksTracker>();

  /** Per-workflow ctrlyoke and user hooks, keyed by workflowKey. */
  private workflowHooks = new Map<string, WorkflowHooks>();

  /** Original state captured before the first workflow touched each path. */
  private baselines = new Map<string, HooksBaseline>();

  /** Serializes hook settings read-modify-write operations in this host. */
  private readonly mutex = new AsyncMutex();

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

  /** Execute a hook mutation while holding this tracker's in-process lock. */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.mutex.acquire();
    try {
      return await fn();
    } finally {
      this.mutex.release();
    }
  }

  /** Register a workflow's hook injection. Must be called under withLock(). */
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
    const resolvedSettingsPath = path.resolve(settingsPath);
    const dirExisted = await fs
      .access(path.dirname(settingsPath))
      .then(() => true)
      .catch(() => false);
    // The lock file lives beside settings.json, so ensure its parent exists.
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });

    await withFileLock(settingsPath, async () => {
      let baseline = this.baselines.get(resolvedSettingsPath);
      if (!baseline) {
        const snapshot = await this.readBaseline(settingsPath, baselinePolicy);
        baseline = {
          hooks: snapshot.hooks,
          fileExisted: snapshot.fileExisted,
          dirExisted,
          gitignorePath: undefined,
        };
        this.baselines.set(resolvedSettingsPath, baseline);
      }

      this.workflowHooks.set(workflowKey, {
        settingsPath,
        layers: {
          ctrlyoke: ctrlyokeHooks,
          userHooks: workflowUserHooks,
        },
      });

      await this.rebuildAndWriteSettings(settingsPath, resolvedSettingsPath);

      if (!baseline.fileExisted && !baseline.gitignorePath) {
        baseline.gitignorePath = await this.writeGitignore(workspaceRoot);
      }
    });
  }

  /** Unregisters using the settings path captured at registration time. */
  async unregisterWorkflow(
    workflowKey: string,
    _workspaceRoot: string
  ): Promise<void> {
    const workflow = this.workflowHooks.get(workflowKey);
    if (!workflow) return;

    const resolvedSettingsPath = path.resolve(workflow.settingsPath);
    let removeSettingsDir = false;
    await withFileLock(workflow.settingsPath, async () => {
      this.workflowHooks.delete(workflowKey);

      if (this.hasWorkflowsForPath(resolvedSettingsPath)) {
        await this.rebuildAndWriteSettings(
          workflow.settingsPath,
          resolvedSettingsPath
        );
        return;
      }

      const baseline = this.baselines.get(resolvedSettingsPath);
      if (baseline) {
        await this.restoreBaseline(workflow.settingsPath, baseline);
        removeSettingsDir = !baseline.dirExisted && !baseline.fileExisted;
        this.baselines.delete(resolvedSettingsPath);
      }
    });
    // The file lock itself lives in this directory, so remove the directory
    // only after withFileLock has released and deleted its lock file.
    if (removeSettingsDir) {
      await fs.rmdir(path.dirname(workflow.settingsPath)).catch(() => {});
    }
  }

  getActiveWorkflowCount(): number {
    return this.workflowHooks.size;
  }

  private hasWorkflowsForPath(resolvedSettingsPath: string): boolean {
    return [...this.workflowHooks.values()].some(
      (workflow) => path.resolve(workflow.settingsPath) === resolvedSettingsPath
    );
  }

  /**
   * Write a temporary .gitignore to hide newly-created settings files from git.
   * Return its path only when this tracker created it.
   */
  private async writeGitignore(
    workspaceRoot: string
  ): Promise<string | undefined> {
    const gitignorePath = path.join(
      workspaceRoot,
      this.settingsDir,
      ".gitignore"
    );
    try {
      await fs.access(gitignorePath);
      return undefined;
    } catch {
      // File doesn't exist — write it.
    }
    const content = [
      "# ctrlyoke temp files (auto-managed, do not commit)",
      this.settingsFile,
      ".gitignore",
      "",
    ].join("\n");
    try {
      await fs.writeFile(gitignorePath, content, "utf-8");
      return gitignorePath;
    } catch {
      return undefined;
    }
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
        return { fileExisted: true, hooks };
      }

      let discardedGroup = false;
      const sanitizedHooks = Object.fromEntries(
        Object.entries(hooks).map(([event, value]) => {
          if (!Array.isArray(value)) return [event, value];
          const retainedGroups = value.filter((group) => {
            if (!discardHookGroup(group)) return true;
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
        (key) => key !== PROMPT_PROPERTIES.HOOKS
      );
      const containedOnlyDiscardedGroups =
        discardedGroup && !hasRetainedHookData && !hasOtherSettings;

      return {
        fileExisted: !containedOnlyDiscardedGroups,
        hooks: containedOnlyDiscardedGroups ? null : sanitizedHooks,
      };
    } catch {
      return { fileExisted: true, hooks: null };
    }
  }

  private async rebuildAndWriteSettings(
    settingsPath: string,
    resolvedSettingsPath: string
  ): Promise<void> {
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    } catch {
      // File doesn't exist — start fresh.
    }

    const baseline = this.baselines.get(resolvedSettingsPath);
    const baseHooks = this.getBaselineHooksData(baseline?.hooks);
    const pathWorkflows = [...this.workflowHooks.values()].filter(
      (workflow) => path.resolve(workflow.settingsPath) === resolvedSettingsPath
    );
    const allEvents = new Set<string>(Object.keys(baseHooks));
    for (const workflow of pathWorkflows) {
      for (const key of Object.keys(workflow.layers.ctrlyoke)) allEvents.add(key);
      for (const key of Object.keys(workflow.layers.userHooks)) allEvents.add(key);
    }

    const mergedHooks: Record<string, unknown[]> = {};
    for (const event of allEvents) {
      const eventGroups: unknown[] = [];
      for (const workflow of pathWorkflows) {
        eventGroups.push(...(workflow.layers.ctrlyoke[event] ?? []));
        eventGroups.push(...(workflow.layers.userHooks[event] ?? []));
      }
      eventGroups.push(...(baseHooks[event] ?? []));
      mergedHooks[event] = eventGroups;
    }

    settings.hooks = mergedHooks;
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  }

  private async restoreBaseline(
    settingsPath: string,
    baseline: HooksBaseline
  ): Promise<void> {
    try {
      if (!baseline.fileExisted) {
        await fs.unlink(settingsPath).catch(() => {});
        if (baseline.gitignorePath) {
          await fs.unlink(baseline.gitignorePath).catch(() => {});
        }
        return;
      }

      let settings: Record<string, unknown> = {};
      try {
        settings = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
      } catch {
        return;
      }

      if (baseline.hooks === null) {
        delete settings.hooks;
      } else {
        settings.hooks = baseline.hooks;
      }
      await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
    } catch (error) {
      Log.warn(
        `[SettingsJsonHooksTracker] Failed to restore hooks baseline for ${this.toolName}: ${error}`
      );
    }
  }

  private getBaselineHooksData(
    hooksSection: Record<string, unknown> | null | undefined
  ): Record<string, unknown[]> {
    const events: Record<string, unknown[]> = {};
    if (!hooksSection) return events;
    for (const [key, value] of Object.entries(hooksSection)) {
      if (Array.isArray(value)) events[key] = [...value];
    }
    return events;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || Array.isArray(value) || typeof value !== "object") {
      return null;
    }
    return value as Record<string, unknown>;
  }
}
