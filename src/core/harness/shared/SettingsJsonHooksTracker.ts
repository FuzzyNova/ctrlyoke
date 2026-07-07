import * as crypto from "crypto";
import * as nodeFs from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import { normalizeCodexHookMatcher } from "./CodexHookUtils";
import { Log } from "../../../utils/Log";

type HookStateEntry = {
  enabled?: boolean;
  trusted_hash?: string;
};

type WorkflowHookLayers = {
  ctrlyoke: Record<string, unknown[]>;
  userHooks: Record<string, unknown[]>;
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

  /** Original-case settingsPath from first registerWorkflow call, used for true-case path resolution. */
  private registeredSettingsPath: string | undefined;

  private readonly toolName: string;
  /** Subdirectory under workspace root (e.g. ".qwen", ".codex") */
  private readonly settingsDir: string;
  /** Filename within settingsDir (e.g. "settings.json" or "hooks.json") */
  private readonly settingsFile: string;

  private constructor(toolName: string) {
    this.toolName = toolName;
    if (toolName === "codex") {
      this.settingsDir = ".codex";
      this.settingsFile = "hooks.json";
    } else {
      this.settingsDir = `.${toolName}`;
      this.settingsFile = "settings.json";
    }
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
    workflowUserHooks: Record<string, unknown[]>
  ): Promise<void> {
    const settingsPath = path.join(
      workspaceRoot,
      this.settingsDir,
      this.settingsFile
    );

    // First registration captures the baseline and records the original-case path
    if (this.workflowHooks.size === 0) {
      const baseline = await this.readBaseline(settingsPath);
      this.baselineHooksSection = baseline.hooks;
      this.baselineFileExisted = baseline.fileExisted;
      this.registeredSettingsPath = settingsPath;
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

  private async readBaseline(settingsPath: string): Promise<{
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
      const settings = JSON.parse(content);
      return {
        fileExisted: true,
        hooks: this.asRecord(settings.hooks),
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
    state: Record<string, HookStateEntry>;
  } {
    const events: Record<string, unknown[]> = {};
    const state: Record<string, HookStateEntry> = {};
    const hooksSection = this.baselineHooksSection;
    if (!hooksSection) {
      return { events, state };
    }

    for (const [key, value] of Object.entries(hooksSection)) {
      if (key === "state") {
        const stateEntries = this.asRecord(value);
        if (!stateEntries) {
          continue;
        }

        for (const [stateKey, rawState] of Object.entries(stateEntries)) {
          const parsed = this.parseHookStateEntry(rawState);
          if (parsed) {
            state[stateKey] = parsed;
          }
        }
        continue;
      }

      if (Array.isArray(value)) {
        events[key] = [...value];
      }
    }

    return { events, state };
  }

  getCodexTrustState(workspaceRoot: string): Record<string, HookStateEntry> {
    if (this.toolName !== "codex") {
      return {};
    }

    const settingsPath = path.join(
      workspaceRoot,
      this.settingsDir,
      this.settingsFile
    );
    return this.buildCodexMergedState(settingsPath);
  }

  static serializeCodexInlineTrustOverride(
    state: Record<string, HookStateEntry>
  ): string[] {
    if (Object.keys(state).length === 0) {
      return [];
    }

    return ["-c", `hooks.state=${this.toInlineTomlValue(state)}`];
  }

  private parseHookStateEntry(value: unknown): HookStateEntry | null {
    const entry = this.asRecord(value);
    if (!entry) {
      return null;
    }

    const parsed: HookStateEntry = {};
    if (typeof entry.enabled === "boolean") {
      parsed.enabled = entry.enabled;
    }

    const trustedHash =
      typeof entry.trusted_hash === "string"
        ? entry.trusted_hash
        : typeof entry.trustedHash === "string"
          ? entry.trustedHash
          : undefined;
    if (trustedHash) {
      parsed.trusted_hash = trustedHash;
    }

    return Object.keys(parsed).length > 0 ? parsed : null;
  }

  private addCodexTrustedState(
    mergedState: Record<string, HookStateEntry>,
    settingsPaths: string[],
    event: string,
    groupIndex: number,
    group: unknown
  ): void {
    const matcher = normalizeCodexHookMatcher(
      event,
      this.getHookGroupMatcher(group)
    );
    const handlers = this.getHookHandlers(group);
    handlers.forEach((handler, handlerIndex) => {
      const commandHook = this.parseCodexCommandHook(handler);
      if (!commandHook) {
        return;
      }

      for (const settingsPath of settingsPaths) {
        mergedState[
          this.buildCodexHookKey(settingsPath, event, groupIndex, handlerIndex)
        ] = {
          trusted_hash: this.computeCodexTrustedHash(
            event,
            matcher,
            commandHook.command,
            commandHook.timeout,
            commandHook.statusMessage
          ),
        };
      }
    });
  }

  private buildCodexMergedState(
    settingsPath: string
  ): Record<string, HookStateEntry> {
    const { events: baseHooks, state: baseState } = this.getBaselineHooksData();
    const mergedState: Record<string, HookStateEntry> = {};
    const settingsPathVariants =
      this.getCodexHookSourcePathVariants(settingsPath);

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

    for (const event of allEvents) {
      let groupIndex = 0;
      for (const wfHooks of this.workflowHooks.values()) {
        for (const group of wfHooks.ctrlyoke[event] ?? []) {
          this.addCodexTrustedState(
            mergedState,
            settingsPathVariants,
            event,
            groupIndex,
            group
          );
          groupIndex += 1;
        }

        for (const group of wfHooks.userHooks[event] ?? []) {
          this.addCodexTrustedState(
            mergedState,
            settingsPathVariants,
            event,
            groupIndex,
            group
          );
          groupIndex += 1;
        }
      }

      const baselineHandlers = baseHooks[event] ?? [];
      baselineHandlers.forEach((group, baselineGroupIndex) => {
        this.remapCodexBaselineState(
          mergedState,
          baseState,
          settingsPathVariants,
          event,
          baselineGroupIndex,
          groupIndex,
          group
        );
        groupIndex += 1;
      });
    }

    this.logCodexTrustState(settingsPath, settingsPathVariants, mergedState);
    return mergedState;
  }

  private getCodexHookSourcePathVariants(settingsPath: string): string[] {
    // Prefer the original-case path from registration for true filesystem case resolution.
    // On Windows, realpathSync given a lowercase path may not restore the true case.
    const pathForRealpath = this.registeredSettingsPath ?? settingsPath;
    let resolvedPath: string;
    try {
      resolvedPath = nodeFs.realpathSync(pathForRealpath);
    } catch {
      try {
        resolvedPath = nodeFs.realpathSync(settingsPath);
      } catch {
        resolvedPath = path.resolve(settingsPath);
      }
    }

    const withoutExtendedPrefix = resolvedPath.startsWith("\\\\?\\")
      ? resolvedPath.slice(4)
      : resolvedPath;

    const upperDriveResolvedPath = withoutExtendedPrefix.replace(
      /^([a-z]):/,
      (match) => match.toUpperCase()
    );

    // Codex appears sensitive to the exact path string used in hook discovery.
    // Keep the workspace-derived path first because that matched the previously
    // working Windows command, and add the resolved form as a fallback.
    return Array.from(new Set([settingsPath, upperDriveResolvedPath]));
  }

  private logCodexTrustState(
    originalSettingsPath: string,
    settingsPathVariants: string[],
    state: Record<string, HookStateEntry>
  ): void {
    const keys = Object.keys(state).sort((left, right) =>
      left.localeCompare(right)
    );
    Log.debug(
      `[CodexHookTrust] sourcePath=${originalSettingsPath}; sourcePathVariants=${settingsPathVariants.join(" | ")}; trustEntryCount=${keys.length}`
    );
    if (keys.length > 0) {
      Log.trace(`[CodexHookTrust] trustKeys=${keys.join(" | ")}`);
    }
  }

  private remapCodexBaselineState(
    mergedState: Record<string, HookStateEntry>,
    baselineState: Record<string, HookStateEntry>,
    settingsPaths: string[],
    event: string,
    baselineGroupIndex: number,
    mergedGroupIndex: number,
    group: unknown
  ): void {
    const handlers = this.getHookHandlers(group);
    handlers.forEach((_, handlerIndex) => {
      const originalState = settingsPaths
        .map(
          (settingsPath) =>
            baselineState[
              this.buildCodexHookKey(
                settingsPath,
                event,
                baselineGroupIndex,
                handlerIndex
              )
            ]
        )
        .find((state) => state !== undefined);
      if (!originalState) {
        return;
      }

      for (const settingsPath of settingsPaths) {
        mergedState[
          this.buildCodexHookKey(
            settingsPath,
            event,
            mergedGroupIndex,
            handlerIndex
          )
        ] = { ...originalState };
      }
    });
  }

  private getHookGroupMatcher(group: unknown): string | undefined {
    const parsed = this.asRecord(group);
    return typeof parsed?.matcher === "string" ? parsed.matcher : undefined;
  }

  private getHookHandlers(group: unknown): unknown[] {
    const parsed = this.asRecord(group);
    return Array.isArray(parsed?.hooks) ? parsed.hooks : [];
  }

  private parseCodexCommandHook(
    handler: unknown
  ): { command: string; timeout: number; statusMessage?: string } | null {
    const parsed = this.asRecord(handler);
    if (
      !parsed ||
      parsed.type !== "command" ||
      typeof parsed.command !== "string"
    ) {
      return null;
    }

    const timeoutSource =
      typeof parsed.timeout === "number"
        ? parsed.timeout
        : typeof parsed.timeoutSec === "number"
          ? parsed.timeoutSec
          : undefined;
    const timeout =
      timeoutSource === undefined
        ? 600
        : Math.max(1, Math.trunc(timeoutSource));

    const statusMessage =
      typeof parsed.statusMessage === "string"
        ? parsed.statusMessage
        : typeof parsed.status_message === "string"
          ? parsed.status_message
          : undefined;

    return {
      command: parsed.command,
      timeout,
      statusMessage,
    };
  }

  private computeCodexTrustedHash(
    event: string,
    matcher: string | undefined,
    command: string,
    timeout: number,
    statusMessage?: string
  ): string {
    const identity: Record<string, unknown> = {
      event_name: this.getCodexEventKeyLabel(event),
      hooks: [
        {
          async: false,
          command,
          timeout,
          type: "command",
          ...(statusMessage !== undefined ? { statusMessage } : {}),
        },
      ],
      ...(matcher !== undefined ? { matcher } : {}),
    };

    const canonical = this.canonicalizeJson(identity);
    const serialized = JSON.stringify(canonical);
    const hex = crypto
      .createHash("sha256")
      .update(serialized, "utf8")
      .digest("hex");
    return `sha256:${hex}`;
  }

  private canonicalizeJson(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.canonicalizeJson(item));
    }

    const record = this.asRecord(value);
    if (!record) {
      return value;
    }

    return Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .reduce<Record<string, unknown>>((sorted, key) => {
        sorted[key] = this.canonicalizeJson(record[key]);
        return sorted;
      }, {});
  }

  private static toInlineTomlValue(value: unknown): string {
    if (typeof value === "string") {
      return JSON.stringify(value);
    }

    if (typeof value === "boolean") {
      return value ? "true" : "false";
    }

    if (typeof value === "number") {
      return Number.isFinite(value) ? String(value) : "0";
    }

    if (Array.isArray(value)) {
      return `[${value.map((item) => this.toInlineTomlValue(item)).join(", ")}]`;
    }

    if (!value || typeof value !== "object") {
      return "{}";
    }

    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)} = ${this.toInlineTomlValue(entryValue)}`
      )
      .join(", ");
    return `{ ${entries} }`;
  }

  private buildCodexHookKey(
    settingsPath: string,
    event: string,
    groupIndex: number,
    handlerIndex: number
  ): string {
    return `${settingsPath}:${this.getCodexEventKeyLabel(event)}:${groupIndex}:${handlerIndex}`;
  }

  private getCodexEventKeyLabel(event: string): string {
    switch (event) {
      case "PreToolUse":
        return "pre_tool_use";
      case "PermissionRequest":
        return "permission_request";
      case "PostToolUse":
        return "post_tool_use";
      case "PreCompact":
        return "pre_compact";
      case "PostCompact":
        return "post_compact";
      case "SessionStart":
        return "session_start";
      case "UserPromptSubmit":
        return "user_prompt_submit";
      case "Stop":
        return "stop";
      default:
        return event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    }
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || Array.isArray(value) || typeof value !== "object") {
      return null;
    }
    return value as Record<string, unknown>;
  }
}
