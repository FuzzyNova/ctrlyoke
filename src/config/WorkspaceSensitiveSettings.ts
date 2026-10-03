import { createHash } from "crypto";
import type { PartialCtrlYokeSettings } from "../types/CtrlYokeSettings";
import type { McpServerConfig } from "../types/CtrlYokeTypes";
import {
  SETTING_PATHS,
  WORKSPACE_MCP_REGISTRY_TRUST_PATH,
} from "../types/DashboardConstants";

/**
 * One workspace-scoped value that can choose a program for ctrlyoke to run.
 * A workspace only *requests* these values; they take effect only after a
 * user-local allow decision in `WorkspaceSettingsTrustStore`. The
 * fingerprint covers the whole value, so a later commit that changes it is a
 * new request and is asked about again.
 */
export interface WorkspaceSensitiveSettingRequest {
  /** Setting path the value came from, or `WORKSPACE_MCP_REGISTRY_TRUST_PATH`. */
  settingPath: string;
  /** Stable hash of the requested value. */
  fingerprint: string;
  /** One-line, human-readable description for approval prompts. */
  summary: string;
}

/**
 * How a sensitive setting is shaped:
 * - `value`: one leaf, approved as a whole.
 * - `map`: every key of an object is its own leaf (`defaults.additionalArgs`
 *   is keyed by harness).
 * - `entries`: each array entry is approved on its own, so approving one
 *   hook does not approve a hook added beside it later.
 */
const SENSITIVE_SETTING_SHAPES = {
  VALUE: "value",
  MAP: "map",
  ENTRIES: "entries",
} as const;

type SensitiveSettingShape =
  (typeof SENSITIVE_SETTING_SHAPES)[keyof typeof SENSITIVE_SETTING_SHAPES];

interface SensitiveSettingDescriptor {
  path: string;
  shape: SensitiveSettingShape;
  /** Whether a leaf value / array entry can actually launch anything. */
  isSensitive: (value: unknown) => boolean;
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isPresent(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A stdio MCP server names a command; registry IDs and URL servers do not. */
function isStdioMcpServer(value: unknown): boolean {
  return isPlainObject(value) && isNonEmptyString(value.command);
}

/**
 * Workspace settings that can make ctrlyoke launch a program. Each one is
 * honored from `.ctrlyoke/settings.json` only after the user approves that
 * exact value for that workspace:
 * - the shell for the dashboard terminal and every inline script;
 * - extra harness CLI flags (e.g. `--settings` can inject harness hooks);
 * - hook commands and stdio MCP server commands attached to every step;
 * - default end/pre-conditions, which are scripts run on every step.
 */
const SENSITIVE_WORKSPACE_SETTINGS: readonly SensitiveSettingDescriptor[] = [
  {
    path: SETTING_PATHS.TERMINAL_SHELL_EXECUTABLE,
    shape: SENSITIVE_SETTING_SHAPES.VALUE,
    isSensitive: isNonEmptyString,
  },
  {
    path: SETTING_PATHS.DEFAULTS_ADDITIONAL_ARGS,
    shape: SENSITIVE_SETTING_SHAPES.MAP,
    isSensitive: isNonEmptyString,
  },
  {
    path: SETTING_PATHS.DEFAULTS_HOOKS,
    shape: SENSITIVE_SETTING_SHAPES.ENTRIES,
    isSensitive: isPresent,
  },
  {
    path: SETTING_PATHS.DEFAULTS_MCP_SERVERS,
    shape: SENSITIVE_SETTING_SHAPES.ENTRIES,
    isSensitive: isStdioMcpServer,
  },
  {
    path: SETTING_PATHS.DEFAULTS_END_CONDITION,
    shape: SENSITIVE_SETTING_SHAPES.VALUE,
    isSensitive: isPresent,
  },
  {
    path: SETTING_PATHS.DEFAULTS_PRE_CONDITION,
    shape: SENSITIVE_SETTING_SHAPES.VALUE,
    isSensitive: isPresent,
  },
];

/** JSON with object keys sorted, so equal values always hash equally. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fingerprintOf(value: unknown): string {
  return createHash("sha256")
    .update(stableStringify(value))
    .digest("hex")
    .slice(0, 32);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

const MAX_SUMMARY_VALUE_LENGTH = 160;

function summarizeValue(value: unknown): string {
  const text = typeof value === "string" ? value : stableStringify(value);
  return text.length > MAX_SUMMARY_VALUE_LENGTH
    ? `${text.slice(0, MAX_SUMMARY_VALUE_LENGTH - 1)}…`
    : text;
}

function createRequest(
  settingPath: string,
  value: unknown,
  label: string = settingPath
): WorkspaceSensitiveSettingRequest {
  return {
    settingPath,
    fingerprint: fingerprintOf(value),
    summary: `${label}: ${summarizeValue(value)}`,
  };
}

/** Stable identifier of a request, unique within one workspace. */
export function workspaceSensitiveSettingRequestKey(
  request: Pick<WorkspaceSensitiveSettingRequest, "settingPath" | "fingerprint">
): string {
  return `${request.settingPath}␟${request.fingerprint}`;
}

function getAtPath(settings: unknown, settingPath: string): unknown {
  let current: unknown = settings;
  for (const part of settingPath.split(".")) {
    if (!isPlainObject(current)) return undefined;
    current = current[part];
  }
  return current;
}

function setAtPath(
  settings: Record<string, unknown>,
  settingPath: string,
  value: unknown
): void {
  const parts = settingPath.split(".");
  let current = settings;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!isPlainObject(next)) return;
    // Copy on the way down so the caller's (cached) settings never change.
    current[part] = { ...next };
    current = current[part] as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1]!;
  if (value === undefined) {
    delete current[leaf];
  } else {
    current[leaf] = value;
  }
}

/** Visit every sensitive leaf/entry of a workspace settings object. */
function forEachSensitiveValue(
  workspace: PartialCtrlYokeSettings,
  user: PartialCtrlYokeSettings,
  visit: (
    request: WorkspaceSensitiveSettingRequest,
    autoApproved: boolean
  ) => void
): void {
  for (const descriptor of SENSITIVE_WORKSPACE_SETTINGS) {
    const workspaceValue = getAtPath(workspace, descriptor.path);
    const userValue = getAtPath(user, descriptor.path);
    if (workspaceValue === undefined) continue;

    if (descriptor.shape === SENSITIVE_SETTING_SHAPES.VALUE) {
      if (descriptor.isSensitive(workspaceValue)) {
        visit(
          createRequest(descriptor.path, workspaceValue),
          valuesEqual(workspaceValue, userValue)
        );
      }
      continue;
    }

    if (descriptor.shape === SENSITIVE_SETTING_SHAPES.MAP) {
      if (!isPlainObject(workspaceValue)) continue;
      for (const [key, value] of Object.entries(workspaceValue)) {
        if (!descriptor.isSensitive(value)) continue;
        const leafPath = `${descriptor.path}.${key}`;
        visit(
          createRequest(leafPath, value),
          valuesEqual(
            value,
            isPlainObject(userValue) ? userValue[key] : undefined
          )
        );
      }
      continue;
    }

    if (!Array.isArray(workspaceValue)) continue;
    const userEntries = Array.isArray(userValue) ? userValue : [];
    for (const entry of workspaceValue) {
      if (!descriptor.isSensitive(entry)) continue;
      visit(
        createRequest(descriptor.path, entry),
        userEntries.some((userEntry) => valuesEqual(entry, userEntry))
      );
    }
  }
}

/**
 * Every sensitive value the workspace settings request that is not already
 * identical to the user's own setting. A value the user configured
 * themselves needs no second approval just because the workspace repeats it.
 */
export function collectWorkspaceSensitiveSettingRequests(
  workspace: PartialCtrlYokeSettings,
  user: PartialCtrlYokeSettings
): WorkspaceSensitiveSettingRequest[] {
  const requests: WorkspaceSensitiveSettingRequest[] = [];
  const seen = new Set<string>();
  forEachSensitiveValue(workspace, user, (request, autoApproved) => {
    const key = workspaceSensitiveSettingRequestKey(request);
    if (autoApproved || seen.has(key)) return;
    seen.add(key);
    requests.push(request);
  });
  return requests;
}

/**
 * Return a copy of `workspace` with every sensitive value `isAllowed`
 * rejects removed, so the user/default value applies instead. An `entries`
 * array emptied by the filter is removed entirely rather than left as `[]`,
 * which would otherwise replace (and so erase) the user's own list.
 */
export function removeUntrustedWorkspaceSensitiveSettings(
  workspace: PartialCtrlYokeSettings,
  user: PartialCtrlYokeSettings,
  isAllowed: (request: WorkspaceSensitiveSettingRequest) => boolean
): PartialCtrlYokeSettings {
  const result = { ...workspace } as Record<string, unknown>;
  for (const descriptor of SENSITIVE_WORKSPACE_SETTINGS) {
    const workspaceValue = getAtPath(result, descriptor.path);
    if (workspaceValue === undefined) continue;
    const userValue = getAtPath(user, descriptor.path);
    const keep = (path: string, value: unknown, autoApproved: boolean) =>
      !descriptor.isSensitive(value) ||
      autoApproved ||
      isAllowed(createRequest(path, value));

    if (descriptor.shape === SENSITIVE_SETTING_SHAPES.VALUE) {
      if (
        !keep(
          descriptor.path,
          workspaceValue,
          valuesEqual(workspaceValue, userValue)
        )
      ) {
        setAtPath(result, descriptor.path, undefined);
      }
      continue;
    }

    if (descriptor.shape === SENSITIVE_SETTING_SHAPES.MAP) {
      if (!isPlainObject(workspaceValue)) continue;
      const kept = Object.fromEntries(
        Object.entries(workspaceValue).filter(([key, value]) =>
          keep(
            `${descriptor.path}.${key}`,
            value,
            valuesEqual(
              value,
              isPlainObject(userValue) ? userValue[key] : undefined
            )
          )
        )
      );
      if (Object.keys(kept).length !== Object.keys(workspaceValue).length) {
        setAtPath(
          result,
          descriptor.path,
          Object.keys(kept).length > 0 ? kept : undefined
        );
      }
      continue;
    }

    if (!Array.isArray(workspaceValue)) continue;
    const userEntries = Array.isArray(userValue) ? userValue : [];
    const kept = workspaceValue.filter((entry) =>
      keep(
        descriptor.path,
        entry,
        userEntries.some((userEntry) => valuesEqual(entry, userEntry))
      )
    );
    if (kept.length !== workspaceValue.length) {
      setAtPath(result, descriptor.path, kept.length > 0 ? kept : undefined);
    }
  }
  return result as PartialCtrlYokeSettings;
}

/**
 * Requests for workspace MCP registry entries that launch a command. A
 * workspace entry overrides a user entry with the same ID, so an unapproved
 * one could otherwise swap the command behind a server the user already
 * attaches. Entries identical to the user's own entry need no approval.
 */
export function collectWorkspaceMcpRegistryRequests(
  workspaceServers: readonly McpServerConfig[],
  userServers: readonly McpServerConfig[]
): WorkspaceSensitiveSettingRequest[] {
  return workspaceServers
    .filter(
      (server) =>
        isStdioMcpServer(server) &&
        !userServers.some(
          (userServer) =>
            userServer.id === server.id && valuesEqual(userServer, server)
        )
    )
    .map((server) =>
      createRequest(
        WORKSPACE_MCP_REGISTRY_TRUST_PATH,
        server,
        `MCP registry server "${server.id}"`
      )
    );
}
