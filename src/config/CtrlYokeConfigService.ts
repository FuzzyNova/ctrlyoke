import type {
  CtrlYokeGlobalSettings,
  PartialCtrlYokeSettings,
} from "../types/CtrlYokeSettings";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "../types/CtrlYokeSettings";
import settingsSchema from "../../schemas/settings-schema.json";
import workflowSchema from "../../schemas/workflow-schema.json";
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
  readonly isReadOnly?: boolean;
}

const WORKSPACE_FORBIDDEN_SETTING_ROOTS = [
  SETTING_PATHS.WORKTREES,
  SETTING_PATHS.STORAGE,
  SETTING_PATHS.STATUS_LINE,
  SETTING_PATHS.USAGE_TRACKING_ENABLED,
] as const;

function getWorkspaceForbiddenSettingRoot(
  settingPath: string
): (typeof WORKSPACE_FORBIDDEN_SETTING_ROOTS)[number] | undefined {
  return WORKSPACE_FORBIDDEN_SETTING_ROOTS.find(
    (root) => settingPath === root || settingPath.startsWith(`${root}.`)
  );
}

function hasSettingPath(settings: unknown, settingPath: string): boolean {
  let current: unknown = settings;
  for (const part of settingPath.split(".")) {
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(current, part)
    ) {
      return false;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return true;
}

type JsonSchema = {
  [key: string]: unknown;
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
};

const SCHEMA_DOCUMENTS: Record<string, JsonSchema> = {
  "settings.json": settingsSchema as JsonSchema,
  "workflow.json": workflowSchema as JsonSchema,
};

function resolveSchemaRef(schema: JsonSchema): JsonSchema {
  if (!schema.$ref) return schema;
  const [document = "settings.json", pointer = ""] = schema.$ref.split("#");
  const root = SCHEMA_DOCUMENTS[document.split("/").pop() ?? document];
  if (!root || !pointer) return schema;
  return pointer
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<JsonSchema | undefined>((current, part) => {
      const referenced = current?.[part];
      return referenced && typeof referenced === "object"
        ? (referenced as JsonSchema)
        : undefined;
    }, root) ?? schema;
}

function schemaAllowsNull(
  schema: JsonSchema,
  seen = new Set<JsonSchema>()
): boolean {
  if (seen.has(schema)) return false;
  seen.add(schema);
  if (
    schema.type === "null" ||
    (Array.isArray(schema.type) && schema.type.includes("null"))
  ) {
    return true;
  }
  if (schema.$ref) return schemaAllowsNull(resolveSchemaRef(schema), seen);
  return [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])].some((branch) =>
    schemaAllowsNull(branch, seen)
  );
}

/**
 * Derive nullable setting leaves from the same schemas used to validate files,
 * so merge exceptions cannot drift from settings-schema.json.
 */
function getSettingSchema(settingPath: string): JsonSchema | undefined {
  let current: JsonSchema | undefined = SCHEMA_DOCUMENTS["settings.json"];
  for (const part of settingPath.split(".")) {
    if (!current) return undefined;
    current = resolveSchemaRef(current).properties?.[part];
  }
  return current;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Remove forbidden and malformed workspace sections without mutating data. */
function filterWorkspaceSettings(
  settings: Record<string, unknown>,
  prefix = "",
  defaults: unknown = CTRLYOKE_SETTINGS_DEFAULTS
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  const entries = Object.entries(settings);

  for (const [key, value] of entries) {
    const settingPath = prefix ? `${prefix}.${key}` : key;
    if (getWorkspaceForbiddenSettingRoot(settingPath)) {
      continue;
    }

    const defaultValue = isPlainObject(defaults) ? defaults[key] : undefined;
    if (
      isPlainObject(defaultValue) &&
      !isPlainObject(value) &&
      !(
        value === null &&
        schemaAllowsNull(getSettingSchema(settingPath) ?? {})
      )
    ) {
      continue;
    }

    if (isPlainObject(value)) {
      const nested = filterWorkspaceSettings(
        value as Record<string, unknown>,
        settingPath,
        defaultValue
      );
      if (Object.keys(nested).length > 0) {
        filtered[key] = nested;
      }
      continue;
    }

    filtered[key] = value;
  }

  return filtered;
}

/** Recursively merge compatible objects, keeping defaults for malformed sections. */
function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>,
  prefix = ""
): T {
  const result = { ...target };
  for (const key of Object.keys(source) as (keyof T)[]) {
    const sourceVal = source[key];
    const targetVal = result[key];
    const settingPath = prefix ? `${prefix}.${String(key)}` : String(key);
    if (
      isPlainObject(targetVal) &&
      !isPlainObject(sourceVal) &&
      !(
        sourceVal === null &&
        schemaAllowsNull(getSettingSchema(settingPath) ?? {})
      )
    ) {
      continue;
    }
    if (
      isPlainObject(sourceVal) &&
      isPlainObject(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
        settingPath
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
  private warnedWorkspaceForbiddenPaths = new WeakMap<
    ConfigBackend,
    Set<string>
  >();

  setWorkspaceBackend(backend: ConfigBackend): void {
    this.workspaceBackend = backend;
  }

  setUserBackend(backend: ConfigBackend): void {
    this.userBackend = backend;
  }

  setCliOverlay(overlay: PartialCtrlYokeSettings): void {
    this.cliOverlay = overlay;
  }

  /** Absolute path of the active user-scope settings.json backend, when configured. */
  getUserFilePath(): string | undefined {
    return this.userBackend?.filePath;
  }

  /** Absolute path of the active workspace-scope settings.json backend, when configured. */
  getWorkspaceFilePath(): string | undefined {
    return this.workspaceBackend?.filePath;
  }

  /** Whether either persisted settings scope belongs to a newer ctrlyoke. */
  isSettingsReadOnly(): boolean {
    return Boolean(
      this.userBackend?.isReadOnly || this.workspaceBackend?.isReadOnly
    );
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
    if (
      forbiddenRoot === SETTING_PATHS.STATUS_LINE ||
      forbiddenRoot === SETTING_PATHS.USAGE_TRACKING_ENABLED
    ) {
      throw new Error(
        `The ${path} setting is machine-scoped and cannot be written at workspace scope.`
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

  /** Return workspace settings after removing forbidden user/machine paths. */
  private getWorkspaceSettings(): PartialCtrlYokeSettings {
    if (!this.workspaceBackend) {
      return {};
    }

    const settings = this.workspaceBackend.getAll();
    for (const forbiddenPath of WORKSPACE_FORBIDDEN_SETTING_ROOTS) {
      if (!hasSettingPath(settings, forbiddenPath)) {
        continue;
      }

      let warnedPaths = this.warnedWorkspaceForbiddenPaths.get(
        this.workspaceBackend
      );
      if (!warnedPaths) {
        warnedPaths = new Set<string>();
        this.warnedWorkspaceForbiddenPaths.set(
          this.workspaceBackend,
          warnedPaths
        );
      }
      if (warnedPaths.has(forbiddenPath)) {
        continue;
      }
      warnedPaths.add(forbiddenPath);

      const scopeDescription =
        forbiddenPath === SETTING_PATHS.STORAGE ||
        forbiddenPath === SETTING_PATHS.WORKTREES
          ? "user-only"
          : "machine-scoped";
      console.warn(
        `[ctrlyoke] Ignoring ${scopeDescription} ${forbiddenPath} settings in workspace file ${this.workspaceBackend.filePath ?? "<workspace settings file>"}.`
      );
    }

    return filterWorkspaceSettings(
      settings as unknown as Record<string, unknown>
    ) as PartialCtrlYokeSettings;
  }
}

export const configService = new CtrlYokeConfigService();
