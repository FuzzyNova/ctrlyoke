import type {
  FlightPathGlobalSettings,
  PartialFlightPathSettings,
} from "../types/FlightPathSettings";
import { FLIGHTPATH_SETTINGS_DEFAULTS } from "../types/FlightPathSettings";
import {
  SETTING_SCOPES,
  type SettingScope,
  type SettingWriteScope,
} from "../types/DashboardConstants";

export type SettingSource = "cli" | SettingScope;

export interface ResolvedSetting<T> {
  value: T;
  source: SettingSource;
}

export interface ConfigBackend {
  getAll(): PartialFlightPathSettings;
  set<T>(path: string, value: T): Promise<void>;
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

export class FlightPathConfigService {
  private workspaceBackend?: ConfigBackend;
  private userBackend?: ConfigBackend;
  private cliOverlay?: PartialFlightPathSettings;
  private listeners: Set<() => void> = new Set();

  setWorkspaceBackend(backend: ConfigBackend): void {
    this.workspaceBackend = backend;
  }

  setUserBackend(backend: ConfigBackend): void {
    this.userBackend = backend;
  }

  setCliOverlay(overlay: PartialFlightPathSettings): void {
    this.cliOverlay = overlay;
  }

  /** Get a top-level setting with source tracking */
  resolve<K extends keyof FlightPathGlobalSettings>(
    key: K
  ): ResolvedSetting<FlightPathGlobalSettings[K]> {
    if (this.cliOverlay && key in this.cliOverlay) {
      return { value: this.getAll()[key], source: "cli" };
    }
    if (this.workspaceBackend && key in this.workspaceBackend.getAll()) {
      return { value: this.getAll()[key], source: "workspace" };
    }
    if (this.userBackend && key in this.userBackend.getAll()) {
      return { value: this.getAll()[key], source: "user" };
    }
    return { value: this.getAll()[key], source: "default" };
  }

  /** Get a top-level setting value (no source info) */
  get<K extends keyof FlightPathGlobalSettings>(
    key: K
  ): FlightPathGlobalSettings[K] {
    return this.getAll()[key];
  }

  /** Get a nested setting value using dot notation (e.g. "execution.mode") */
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
  getAll(): FlightPathGlobalSettings {
    let result: FlightPathGlobalSettings = {
      ...FLIGHTPATH_SETTINGS_DEFAULTS,
    } as FlightPathGlobalSettings;

    if (this.userBackend) {
      result = deepMerge(
        result as unknown as Record<string, unknown>,
        this.userBackend.getAll() as unknown as Record<string, unknown>
      ) as unknown as FlightPathGlobalSettings;
    }

    if (this.workspaceBackend) {
      result = deepMerge(
        result as unknown as Record<string, unknown>,
        this.workspaceBackend.getAll() as unknown as Record<string, unknown>
      ) as unknown as FlightPathGlobalSettings;
    }

    if (this.cliOverlay) {
      result = deepMerge(
        result as unknown as Record<string, unknown>,
        this.cliOverlay as unknown as Record<string, unknown>
      ) as unknown as FlightPathGlobalSettings;
    }

    return result;
  }

  /** Set a setting at workspace or user scope using dot notation path */
  async set(
    path: string,
    value: unknown,
    scope: SettingWriteScope
  ): Promise<void> {
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
      walkLeaves(this.workspaceBackend.getAll(), "", "workspace");

    return sources;
  }

  /** Notify all subscribers */
  notify(): void {
    this.listeners.forEach((listener) => listener());
  }
}

export const configService = new FlightPathConfigService();
