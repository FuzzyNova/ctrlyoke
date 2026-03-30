import * as fs from "fs/promises";
import * as path from "path";
import { Log } from "../../../utils/Log";

/**
 * Manages FlightPath hook injection into settings.json for Qwen and Gemini CLIs.
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

  /** Original hooks from settings.json before any FlightPath workflow touched it. */
  private baseline: Record<string, unknown[]> | null | undefined = undefined;

  /** Per-workflow FlightPath hooks + user hooks, keyed by workflowKey. */
  private workflowHooks = new Map<
    string,
    {
      flightpath: Record<string, unknown[]>;
      userHooks: Record<string, unknown[]>;
    }
  >();

  private readonly toolName: string;
  private readonly settingsFileName: string;

  private constructor(toolName: string) {
    this.toolName = toolName;
    this.settingsFileName = toolName === "qwen" ? ".qwen" : ".gemini";
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
    flightpathHooks: Record<string, unknown[]>,
    workflowUserHooks: Record<string, unknown[]>
  ): Promise<void> {
    const settingsPath = path.join(
      workspaceRoot,
      this.settingsFileName,
      "settings.json"
    );

    // First registration captures the baseline
    if (this.workflowHooks.size === 0) {
      this.baseline = await this.readHooksFromSettings(settingsPath);
    }

    // Track this workflow's hooks
    this.workflowHooks.set(workflowKey, {
      flightpath: flightpathHooks,
      userHooks: workflowUserHooks,
    });

    // Rebuild and write merged settings
    await this.rebuildAndWriteSettings(settingsPath, workspaceRoot);
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
      this.settingsFileName,
      "settings.json"
    );

    if (this.workflowHooks.size === 0) {
      // Last workflow — restore baseline
      await this.restoreBaseline(settingsPath);
      this.baseline = undefined;
    } else {
      // Other workflows still active — rebuild without this one
      await this.rebuildAndWriteSettings(settingsPath, workspaceRoot);
    }
  }

  getActiveWorkflowCount(): number {
    return this.workflowHooks.size;
  }

  private async readHooksFromSettings(
    settingsPath: string
  ): Promise<Record<string, unknown[]> | null> {
    try {
      const content = await fs.readFile(settingsPath, "utf-8");
      const settings = JSON.parse(content);
      return (settings.hooks as Record<string, unknown[]>) ?? null;
    } catch {
      return null;
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

    // Start with baseline hooks (deep copy arrays)
    const baseHooks: Record<string, unknown[]> = {};
    if (this.baseline) {
      for (const key of Object.keys(this.baseline)) {
        baseHooks[key] = [...(this.baseline[key] || [])];
      }
    }

    // Collect all event names
    const allEvents = new Set<string>();
    for (const key of Object.keys(baseHooks)) {
      allEvents.add(key);
    }
    for (const wfHooks of this.workflowHooks.values()) {
      for (const key of Object.keys(wfHooks.flightpath)) {
        allEvents.add(key);
      }
      for (const key of Object.keys(wfHooks.userHooks)) {
        allEvents.add(key);
      }
    }

    // Merge: FlightPath first, workflow user hooks middle, baseline last
    const mergedHooks: Record<string, unknown[]> = {};
    for (const event of allEvents) {
      const fpHandlers: unknown[] = [];
      const userHandlers: unknown[] = [];

      for (const wfHooks of this.workflowHooks.values()) {
        if (wfHooks.flightpath[event]) {
          fpHandlers.push(...wfHooks.flightpath[event]);
        }
        if (wfHooks.userHooks[event]) {
          userHandlers.push(...wfHooks.userHooks[event]);
        }
      }

      const baselineHandlers = baseHooks[event] ?? [];
      mergedHooks[event] = [...fpHandlers, ...userHandlers, ...baselineHandlers];
    }

    settings.hooks = mergedHooks;

    await fs.mkdir(path.join(workspaceRoot, this.settingsFileName), {
      recursive: true,
    });
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  }

  private async restoreBaseline(settingsPath: string): Promise<void> {
    try {
      let settings: Record<string, unknown> = {};
      try {
        const content = await fs.readFile(settingsPath, "utf-8");
        settings = JSON.parse(content);
      } catch {
        return;
      }

      if (this.baseline === null) {
        delete settings.hooks;
      } else {
        settings.hooks = this.baseline;
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
}
