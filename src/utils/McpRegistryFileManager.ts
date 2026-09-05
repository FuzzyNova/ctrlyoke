import * as fs from "fs";
import * as path from "path";
import type { SettingWriteScope } from "../types/DashboardConstants";
import {
  MCP_TRANSPORTS,
  SETTING_SCOPES,
  SPECIAL_TARGET_IDS,
} from "../types/DashboardConstants";
import type { McpServerConfig } from "../types/CtrlYokeTypes";
import type { ManagedMcpServer } from "../types/WebviewMessageTypes";
import { Log } from "./Log";
import {
  getCtrlYokeUserMcpRegistryPath,
  getCtrlYokeWorkspaceMcpRegistryPath,
} from "./McpConfigPaths";
import {
  MCP_APPEND_STEP_TOOL_NAME,
  MCP_WORKFLOW_STATUS_TOOL_NAME,
} from "./McpToolDefinitions";

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function isBooleanOrStringArray(
  value: unknown
): value is boolean | string[] | undefined {
  return (
    value === undefined || typeof value === "boolean" || isStringArray(value)
  );
}

function isMcpServerConfig(value: unknown): value is McpServerConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const server = value as Record<string, unknown>;
  const hasCommand = typeof server.command === "string";
  const hasUrl = typeof server.url === "string";
  const hasValidTransport =
    server.transport === undefined ||
    server.transport === MCP_TRANSPORTS.STREAMABLE_HTTP ||
    server.transport === MCP_TRANSPORTS.SSE;

  return (
    typeof server.id === "string" &&
    server.id.trim().length > 0 &&
    (hasCommand || hasUrl) &&
    (server.args === undefined || isStringArray(server.args)) &&
    (server.env === undefined || isStringRecord(server.env)) &&
    isBooleanOrStringArray(server.autoApprove) &&
    hasValidTransport &&
    (server.headers === undefined || isStringRecord(server.headers)) &&
    (server.deniedTools === undefined || isStringArray(server.deniedTools))
  );
}

function getManagedDisplayName(server: McpServerConfig): string {
  const raw = server as unknown as Record<string, unknown>;
  if (
    typeof raw.displayName === "string" &&
    raw.displayName.trim().length > 0
  ) {
    return raw.displayName;
  }
  if (typeof raw.name === "string" && raw.name.trim().length > 0) {
    return raw.name;
  }
  return server.id;
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    const content = await fs.promises.readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function writeJsonFileAtomic(
  filePath: string,
  data: unknown
): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(
      tempPath,
      JSON.stringify(data, null, 2),
      "utf-8"
    );
    await fs.promises.rename(tempPath, filePath);
  } catch (error) {
    await fs.promises.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export class McpRegistryFileManager {
  constructor(private readonly workspaceRoot?: string) {}

  async readAll(): Promise<ManagedMcpServer[]> {
    const workspacePath = this.getScopePath(SETTING_SCOPES.WORKSPACE);
    const userPath = this.getScopePath(SETTING_SCOPES.USER);
    const [workspaceServers, userServers] = await Promise.all([
      this.readScope(SETTING_SCOPES.WORKSPACE),
      this.readScope(SETTING_SCOPES.USER),
    ]);

    const byId = new Map<string, ManagedMcpServer>();

    const addServers = (
      servers: McpServerConfig[],
      scope: SettingWriteScope,
      registryPath: string | null,
      allowOverride: boolean
    ) => {
      if (!registryPath) return;
      for (const server of servers) {
        const managedLocation = {
          targetId: SPECIAL_TARGET_IDS.CTRLYOKE,
          scope,
          path: registryPath,
        };
        const existing = byId.get(server.id);
        if (!existing) {
          byId.set(server.id, {
            id: server.id,
            displayName: getManagedDisplayName(server),
            config: server,
            locations: [managedLocation],
          });
          continue;
        }

        existing.locations = sortLocations([
          ...existing.locations,
          ...(!existing.locations.some(
            (current) =>
              current.targetId === managedLocation.targetId &&
              current.scope === managedLocation.scope &&
              current.path === managedLocation.path
          )
            ? [managedLocation]
            : []),
        ]);

        if (allowOverride) {
          existing.config = server;
          existing.displayName = getManagedDisplayName(server);
        }
      }
    };

    addServers(userServers, SETTING_SCOPES.USER, userPath, false);
    addServers(workspaceServers, SETTING_SCOPES.WORKSPACE, workspacePath, true);

    return Array.from(byId.values()).sort((a, b) =>
      a.displayName.localeCompare(b.displayName, undefined, {
        sensitivity: "base",
      })
    );
  }

  async readScope(scope: SettingWriteScope): Promise<McpServerConfig[]> {
    const filePath = this.getScopePath(scope);
    if (!filePath) return [];

    const parsed = await readJsonFile(filePath);
    if (!Array.isArray(parsed)) return [];

    const servers: McpServerConfig[] = [];
    for (const entry of parsed) {
      if (isMcpServerConfig(entry)) {
        servers.push(entry);
        continue;
      }
      Log.warn(
        `[McpRegistryFileManager] Ignoring invalid MCP registry entry in ${filePath}`
      );
    }
    return servers;
  }

  async addOrUpdate(
    server: McpServerConfig,
    scope: SettingWriteScope
  ): Promise<void> {
    if (!isMcpServerConfig(server)) {
      throw new Error("Invalid MCP server config.");
    }

    const filePath = this.getRequiredScopePath(scope);
    const current = await this.readScope(scope);
    const next = [...current];
    const existingIndex = next.findIndex((entry) => entry.id === server.id);

    if (existingIndex >= 0) {
      next[existingIndex] = server;
    } else {
      next.push(server);
    }

    await writeJsonFileAtomic(filePath, next);
  }

  async remove(id: string, scope: SettingWriteScope): Promise<void> {
    const filePath = this.getRequiredScopePath(scope);
    const current = await this.readScope(scope);
    const next = current.filter((server) => server.id !== id);
    await writeJsonFileAtomic(filePath, next);
  }

  private getRequiredScopePath(scope: SettingWriteScope): string {
    const filePath = this.getScopePath(scope);
    if (filePath) return filePath;

    throw new Error(
      scope === SETTING_SCOPES.WORKSPACE
        ? "Workspace MCP registry is unavailable because no workspace folder is open."
        : "Could not resolve the user MCP registry path."
    );
  }

  private getScopePath(scope: SettingWriteScope): string | null {
    if (scope === SETTING_SCOPES.USER) {
      return getCtrlYokeUserMcpRegistryPath();
    }
    if (!this.workspaceRoot) {
      return null;
    }
    return getCtrlYokeWorkspaceMcpRegistryPath(this.workspaceRoot);
  }
}

/**
 * Static metadata for `/mcp:ctrlyoke` — the reserved built-in-server sentinel
 * is never a registry entry (see {@link resolveCtrlYokeMcpInvocation}, which
 * only resolves user-registered servers), so completion and preview surfaces
 * need a synthetic descriptor instead of a real {@link ManagedMcpServer}.
 */
export const CTRLYOKE_BUILTIN_MCP_SERVER_INFO = {
  id: SPECIAL_TARGET_IDS.CTRLYOKE,
  description:
    "ctrlyoke's built-in MCP server. Gives the model workflow-status and append-step tools scoped to the current workflow run.",
  tools: [MCP_WORKFLOW_STATUS_TOOL_NAME, MCP_APPEND_STEP_TOOL_NAME],
} as const;

/** Find a managed MCP server by its ctrlyoke registry ID. */
export function findManagedMcpServerByName(
  servers: readonly ManagedMcpServer[],
  name: string
): ManagedMcpServer | undefined {
  return servers.find((server) => server.id === name);
}

/** Resolve a ctrlyoke registry ID to the config consumed by harnesses. */
export function resolveCtrlYokeMcpInvocation(
  servers: readonly ManagedMcpServer[],
  name: string
): McpServerConfig | undefined {
  return findManagedMcpServerByName(servers, name)?.config;
}

function sortLocations(
  locations: ManagedMcpServer["locations"]
): ManagedMcpServer["locations"] {
  return [...locations].sort((a, b) => {
    if (a.scope === b.scope) {
      return a.path.localeCompare(b.path, undefined, { sensitivity: "base" });
    }
    return a.scope === SETTING_SCOPES.WORKSPACE ? -1 : 1;
  });
}
