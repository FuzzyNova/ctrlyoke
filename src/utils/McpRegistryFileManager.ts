import * as fs from "fs";
import * as path from "path";
import { uniqueAtomicTempPath } from "../config/AtomicFileWrite";
import type { SettingWriteScope } from "../types/DashboardConstants";
import {
  MCP_TRANSPORTS,
  SETTING_SCOPES,
  SPECIAL_TARGET_IDS,
  TRUST_DECISIONS,
} from "../types/DashboardConstants";
import {
  collectWorkspaceMcpRegistryRequests,
  workspaceSensitiveSettingRequestKey,
  type WorkspaceSensitiveSettingRequest,
} from "../config/WorkspaceSensitiveSettings";
import {
  WorkspaceSettingsTrustStore,
  workspaceSettingsTrustStore,
  type WorkspaceSettingsTrustDecisions,
} from "../config/WorkspaceSettingsTrustStore";
import type { WorkspaceSensitiveSettingState } from "../config/CtrlYokeConfigService";
import type { McpServerConfig } from "../types/CtrlYokeTypes";
import type { ManagedMcpServer } from "../types/WebviewMessageTypes";
import { Log } from "./Log";
import { stripLeadingBom } from "./TextUtils";
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
    hasCommand !== hasUrl &&
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
    return JSON.parse(stripLeadingBom(content));
  } catch {
    return null;
  }
}

async function writeJsonFileAtomic(
  filePath: string,
  data: unknown
): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = uniqueAtomicTempPath(filePath);
  try {
    await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2), {
      encoding: "utf-8",
      flag: "wx",
    });
    await fs.promises.rename(tempPath, filePath);
  } catch (error) {
    await fs.promises.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

const mutationQueues = new Map<string, Promise<void>>();

async function serializeMutation<T>(
  filePath: string,
  mutation: () => Promise<T>
): Promise<T> {
  const resolvedPath = path.resolve(filePath);
  const previous = mutationQueues.get(resolvedPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  mutationQueues.set(resolvedPath, current);
  await previous.catch(() => undefined);
  try {
    return await mutation();
  } finally {
    release();
    if (mutationQueues.get(resolvedPath) === current) {
      mutationQueues.delete(resolvedPath);
    }
  }
}

async function readRawArrayForMutation(filePath: string): Promise<unknown[]> {
  let content: string;
  try {
    content = await fs.promises.readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripLeadingBom(content));
  } catch {
    throw new Error(
      `Cannot modify MCP registry "${filePath}": file contains invalid JSON. Fix the file before saving.`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Cannot modify MCP registry "${filePath}": expected a JSON array. Fix the file before saving.`
    );
  }
  return parsed;
}

function hasServerId(entry: unknown, id: string): boolean {
  return (
    entry !== null &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    (entry as Record<string, unknown>).id === id
  );
}

export interface McpRegistryReadOptions {
  /**
   * Include workspace entries that launch a command the user has not
   * approved. Only for showing the registry files as written (the MCP
   * manager); anything that attaches servers must leave this off.
   */
  includeUntrustedWorkspaceServers?: boolean;
}

export class McpRegistryFileManager {
  constructor(
    private readonly workspaceRoot?: string,
    private readonly trust: WorkspaceSettingsTrustDecisions = workspaceSettingsTrustStore
  ) {}

  async readAll(
    options: McpRegistryReadOptions = {}
  ): Promise<ManagedMcpServer[]> {
    const workspacePath = this.getScopePath(SETTING_SCOPES.WORKSPACE);
    const userPath = this.getScopePath(SETTING_SCOPES.USER);
    const [requestedWorkspaceServers, userServers] = await Promise.all([
      this.readScope(SETTING_SCOPES.WORKSPACE),
      this.readScope(SETTING_SCOPES.USER),
    ]);
    const workspaceServers = options.includeUntrustedWorkspaceServers
      ? requestedWorkspaceServers
      : this.withholdUntrustedWorkspaceServers(
          requestedWorkspaceServers,
          userServers
        );

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

  /**
   * Workspace registry entries that launch a command, with the user's
   * recorded decision (`undefined` = not yet decided). Entries identical
   * to the user's own registry entry are not listed.
   */
  async getWorkspaceTrustStates(): Promise<WorkspaceSensitiveSettingState[]> {
    const identity = this.getWorkspaceTrustIdentity();
    const requests = await this.readWorkspaceTrustRequests();
    return requests.map((request) => ({
      request,
      decision: identity
        ? this.trust.getDecision(identity, request)
        : undefined,
    }));
  }

  async addOrUpdate(
    server: McpServerConfig,
    scope: SettingWriteScope
  ): Promise<void> {
    if (!isMcpServerConfig(server)) {
      throw new Error("Invalid MCP server config.");
    }

    const filePath = this.getRequiredScopePath(scope);
    const requestedBefore =
      scope === SETTING_SCOPES.WORKSPACE
        ? await this.readWorkspaceTrustRequests()
        : undefined;
    await serializeMutation(filePath, async () => {
      const next = await readRawArrayForMutation(filePath);
      const existingIndex = next.findIndex((entry) =>
        hasServerId(entry, server.id)
      );

      if (existingIndex >= 0) {
        next[existingIndex] = server;
      } else {
        next.push(server);
      }

      await writeJsonFileAtomic(filePath, next);
    });
    if (requestedBefore) {
      await this.approveNewWorkspaceServers(requestedBefore);
    }
  }

  async add(server: McpServerConfig, scope: SettingWriteScope): Promise<void> {
    if (!isMcpServerConfig(server)) {
      throw new Error("Invalid MCP server config.");
    }
    const filePath = this.getRequiredScopePath(scope);
    const requestedBefore =
      scope === SETTING_SCOPES.WORKSPACE
        ? await this.readWorkspaceTrustRequests()
        : undefined;
    await serializeMutation(filePath, async () => {
      const next = await readRawArrayForMutation(filePath);
      if (next.some((entry) => hasServerId(entry, server.id))) {
        throw new Error(
          `An MCP registry server with id "${server.id}" already exists.`
        );
      }
      next.push(server);
      await writeJsonFileAtomic(filePath, next);
    });
    if (requestedBefore) await this.approveNewWorkspaceServers(requestedBefore);
  }

  async rename(
    previousId: string,
    server: McpServerConfig,
    scope: SettingWriteScope
  ): Promise<void> {
    if (!isMcpServerConfig(server)) {
      throw new Error("Invalid MCP server config.");
    }
    const filePath = this.getRequiredScopePath(scope);
    const requestedBefore =
      scope === SETTING_SCOPES.WORKSPACE
        ? await this.readWorkspaceTrustRequests()
        : undefined;
    await serializeMutation(filePath, async () => {
      const next = await readRawArrayForMutation(filePath);
      const previousIndex = next.findIndex((entry) =>
        hasServerId(entry, previousId)
      );
      if (previousIndex < 0) {
        throw new Error(
          `MCP registry server "${previousId}" no longer exists.`
        );
      }
      if (
        next.some(
          (entry, index) =>
            index !== previousIndex && hasServerId(entry, server.id)
        )
      ) {
        throw new Error(
          `An MCP registry server with id "${server.id}" already exists.`
        );
      }
      next[previousIndex] = server;
      await writeJsonFileAtomic(filePath, next);
    });
    if (requestedBefore) await this.approveNewWorkspaceServers(requestedBefore);
  }

  async remove(id: string, scope: SettingWriteScope): Promise<void> {
    const filePath = this.getRequiredScopePath(scope);
    await serializeMutation(filePath, async () => {
      const current = await readRawArrayForMutation(filePath);
      const next = current.filter((entry) => !hasServerId(entry, id));
      await writeJsonFileAtomic(filePath, next);
    });
  }

  private getWorkspaceTrustIdentity(): string | undefined {
    return this.workspaceRoot
      ? WorkspaceSettingsTrustStore.canonicalizeWorkspace(this.workspaceRoot)
      : undefined;
  }

  private async readWorkspaceTrustRequests(): Promise<
    WorkspaceSensitiveSettingRequest[]
  > {
    const [workspaceServers, userServers] = await Promise.all([
      this.readScope(SETTING_SCOPES.WORKSPACE),
      this.readScope(SETTING_SCOPES.USER),
    ]);
    return collectWorkspaceMcpRegistryRequests(workspaceServers, userServers);
  }

  /**
   * Drop workspace entries that launch an unapproved command, so a
   * same-ID user entry keeps applying. Undecided ones are reported so a host
   * can ask the user.
   */
  private withholdUntrustedWorkspaceServers(
    workspaceServers: McpServerConfig[],
    userServers: McpServerConfig[]
  ): McpServerConfig[] {
    const identity = this.getWorkspaceTrustIdentity();
    const undecided: WorkspaceSensitiveSettingRequest[] = [];
    const trusted = workspaceServers.filter((server) => {
      const [request] = collectWorkspaceMcpRegistryRequests(
        [server],
        userServers
      );
      if (!request) return true;
      const decision = identity
        ? this.trust.getDecision(identity, request)
        : undefined;
      if (decision === undefined) undecided.push(request);
      return decision === TRUST_DECISIONS.ALLOW;
    });
    if (identity && undecided.length > 0) {
      this.trust.reportUndecided(identity, undecided);
    }
    return trusted;
  }

  /** A workspace entry the user saved through ctrlyoke is their own choice. */
  private async approveNewWorkspaceServers(
    before: readonly WorkspaceSensitiveSettingRequest[]
  ): Promise<void> {
    const identity = this.getWorkspaceTrustIdentity();
    if (!identity) return;
    const previousKeys = new Set(
      before.map((request) => workspaceSensitiveSettingRequestKey(request))
    );
    const added = (await this.readWorkspaceTrustRequests()).filter(
      (request) =>
        !previousKeys.has(workspaceSensitiveSettingRequestKey(request))
    );
    await this.trust.setDecisions(identity, added, TRUST_DECISIONS.ALLOW);
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
