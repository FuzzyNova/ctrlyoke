import type {
  CtrlYokeGlobalSettings,
  PartialCtrlYokeSettings,
} from "../types/CtrlYokeSettings";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "../types/CtrlYokeSettings";
import {
  SETTING_SCOPES,
  SETTING_PATHS,
  type SettingScope,
  type SettingWriteScope,
} from "../types/DashboardConstants";

export type SettingSource = "cli" | SettingScope;

export interface ResolvedSetting<T> {
  value: T;
  source: SettingSource;
}

export interface ConfigBackend {
  getAll(): PartialCtrlYokeSettings;
  set<T>(path: string, value: T): Promise<void>;
  /** Backing file path used in diagnostics when available. */
  readonly filePath?: string;
}

const WORKSPACE_FORBIDDEN_SETTING_ROOTS = [
  SETTING_PATHS.WORKTREES,
  SETTING_PATHS.STORAGE,
] as const;

function getWorkspaceForbiddenSettingRoot(
  settingPath: string
): (typeof WORKSPACE_FORBIDDEN_SETTING_ROOTS)[number] | undefined {
  return WORKSPACE_FORBIDDEN_SETTING_ROOTS.find(
    (root) => settingPath === root || settingPath.startsWith(`${root}.`)
  );
}

/** Deep merge: source properties override target; objects are merged recursively, arrays/primitives are replaced */
function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>
): T {
  const result = { ...target };
  for (const key of Object.keys(source) as (keyof T)[]) {
    const sourceVal = source[key];
    const targetVal = result[key];
    if (
      sourceVal !== undefined &&
      sourceVal !== null &&
      typeof sourceVal === "object" &&
      !Array.isArray(sourceVal) &&
      typeof targetVal === "object" &&
      targetVal !== null &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>
      ) as T[keyof T];
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal as T[keyof T];
    }
  }
  return result;
}

export class CtrlYokeConfigService {
  private workspaceBackend?: ConfigBackend;
  private userBackend?: ConfigBackend;
  private cliOverlay?: PartialCtrlYokeSettings;
  private listeners: Set<() => void> = new Set();
  private warnedWorkspaceStorageBackends = new WeakSet<ConfigBackend>();

  setWorkspaceBackend(backend: ConfigBackend): void {
    this.workspaceBackend = backend;
  }

  setUserBackend(backend: ConfigBackend): void {
    this.userBackend = backend;
  }

  setCliOverlay(overlay: PartialCtrlYokeSettings): void {
    this.cliOverlay = overlay;
  }

  /** Get a top-level setting with source tracking */
  resolve<K extends keyof CtrlYokeGlobalSettings>(
    key: K
  ): ResolvedSetting<CtrlYokeGlobalSettings[K]> {
    if (this.cliOverlay && key in this.cliOverlay) {
      return { value: this.getAll()[key], source: "cli" };
    }
    if (key in this.getWorkspaceSettings()) {
      return { value: this.getAll()[key], source: "workspace" };
    }
    if (this.userBackend && key in this.userBackend.getAll()) {
      return { value: this.getAll()[key], source: "user" };
    }
    return { value: this.getAll()[key], source: "default" };
  }

  /** Get a top-level setting value (no source info) */
  get<K extends keyof CtrlYokeGlobalSettings>(
    key: K
  ): CtrlYokeGlobalSettings[K] {
    return this.getAll()[key];
  }

  /** Return the configured user-scope worktree root, if one is set. */
  getConfiguredWorktreeRoot(): string | undefined {
    const root = this.get("worktrees").root.trim();
    return root || undefined;
  }

  /**
   * Get a top-level setting from exactly one backend, with no cross-scope
   * merge — `undefined` when that backend doesn't define the key at all.
   * Use this (instead of `get`/`getAll`) when a caller needs to reason about
   * user-scope and workspace-scope values separately, e.g. to union array
   * settings explicitly rather than letting the normal deep-merge replace one
   * scope's array with another's.
   */
  getScoped<K extends keyof CtrlYokeGlobalSettings>(
    key: K,
    scope: SettingWriteScope
  ): PartialCtrlYokeSettings[K] | undefined {
    const backend =
      scope === SETTING_SCOPES.WORKSPACE
        ? this.workspaceBackend
        : this.userBackend;
    if (scope === SETTING_SCOPES.WORKSPACE) {
      return this.getWorkspaceSettings()[key];
    }
    return backend?.getAll()[key];
  }

  /** Get a nested setting value using dot notation (e.g. "execution.injectMode") */
  getNested(path: string): unknown {
    const parts = path.split(".");
    let current: unknown = this.getAll();
    for (const part of parts) {
      if (
        current === null ||
        current === undefined ||
        typeof current !== "object"
      ) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  /** Get all settings merged from all backends */
  getAll(): CtrlYokeGlobalSettings {
    let result: CtrlYokeGlobalSettings = {
      ...CTRLYOKE_SETTINGS_DEFAULTS,
    } as CtrlYokeGlobalSettings;

    if (this.userBackend) {
      result = deepMerge(
        result as unknown as Record<string, unknown>,
        this.userBackend.getAll() as unknown as Record<string, unknown>
      ) as unknown as CtrlYokeGlobalSettings;
    }

    if (this.workspaceBackend) {
      result = deepMerge(
        result as unknown as Record<string, unknown>,
        this.getWorkspaceSettings() as unknown as Record<string, unknown>
      ) as unknown as CtrlYokeGlobalSettings;
    }

    if (this.cliOverlay) {
      result = deepMerge(
        result as unknown as Record<string, unknown>,
        this.cliOverlay as unknown as Record<string, unknown>
      ) as unknown as CtrlYokeGlobalSettings;
    }

    return result;
  }

  /** Set a setting at workspace or user scope using dot notation path */
  async set(
    path: string,
    value: unknown,
    scope: SettingWriteScope
  ): Promise<void> {
    const forbiddenRoot =
      scope === SETTING_SCOPES.WORKSPACE
        ? getWorkspaceForbiddenSettingRoot(path)
        : undefined;
    if (forbiddenRoot === SETTING_PATHS.WORKTREES) {
      throw new Error(
        "The worktrees.root setting is user-scope only and cannot be written at workspace scope."
      );
    }
    if (forbiddenRoot === SETTING_PATHS.STORAGE) {
      throw new Error(
        "The storage.runHistoryLocation setting is user-scope only and cannot be written at workspace scope."
      );
    }
    const backend =
      scope === SETTING_SCOPES.WORKSPACE
        ? this.workspaceBackend
        : this.userBackend;
    if (!backend) {
      throw new Error(`No ${scope} backend configured`);
    }
    await backend.set(path, value);
    this.notify();
  }

  /** Subscribe to config changes */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Build a dot-notation leaf path → source map by walking workspace and user backends.
   * workspace wins over user when both have the same leaf path.
   */
  getLeafSources(): Record<string, SettingSource> {
    const sources: Record<string, SettingSource> = {};

    function walkLeaves(
      obj: unknown,
      prefix: string,
      source: SettingSource
    ): void {
      if (
        obj === null ||
        obj === undefined ||
        typeof obj !== "object" ||
        Array.isArray(obj)
      ) {
        if (prefix) sources[prefix] = source;
        return;
      }

      // Record the object path itself so aggregate editors (for example
      // workflow.defaultEndCondition) can still show source and reset state.
      if (prefix) {
        sources[prefix] = source;
      }

      for (const [key, value] of Object.entries(
        obj as Record<string, unknown>
      )) {
        walkLeaves(value, prefix ? `${prefix}.${key}` : key, source);
      }
    }

    if (this.userBackend) walkLeaves(this.userBackend.getAll(), "", "user");
    if (this.workspaceBackend)
      walkLeaves(this.getWorkspaceSettings(), "", "workspace");

    return sources;
  }

  /** Notify all subscribers */
  notify(): void {
    this.listeners.forEach((listener) => listener());
  }

  /**
   * Return workspace settings after removing user-only sections. Workspace
   * config is still read for diagnostics, but forbidden values never enter the
   * effective hierarchy or source map.
   */
  private getWorkspaceSettings(): PartialCtrlYokeSettings {
    if (!this.workspaceBackend) {
      return {};
    }

    const settings = this.workspaceBackend.getAll();
    if (
      settings.storage !== undefined &&
      !this.warnedWorkspaceStorageBackends.has(this.workspaceBackend)
    ) {
      this.warnedWorkspaceStorageBackends.add(this.workspaceBackend);
      console.warn(
        `[ctrlyoke] Ignoring user-only storage settings in workspace file ${this.workspaceBackend.filePath ?? "<workspace settings file>"}.`
      );
    }

    if (settings.storage === undefined) {
      return settings;
    }

    const { storage: _ignoredStorage, ...allowedSettings } = settings;
    return allowedSettings;
  }
}

export const configService = new CtrlYokeConfigService();
