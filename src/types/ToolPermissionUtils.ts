import {
  PERMISSION_CAPABILITY_KEYS,
  PERMISSION_MODES,
  permissionModeAppliesToolList,
  type PermissionMode,
} from "./DashboardConstants";
import type { McpServerConfig } from "./CtrlYokeTypes";
import type { ToolPermissionConfig } from "./ExecutionPropertyTypes";

/**
 * Merge per-server MCP denials into the unified tool permission configuration.
 *
 * This is the runtime permission rule for harness preparation. Server-level
 * tool names are bare; harness permission patterns use harness-specific names.
 * The optional formatter lets a mapper supply its native convention while
 * preserving the default `mcp__<server>__<tool>` form. Author-time
 * compatibility analysis owns its MCP diagnostics separately so native and
 * unsupported adapters do not look like general permission failures.
 */
export function mergeServerDeniedTools(
  toolPermissions: ToolPermissionConfig | null | undefined,
  mcpServers: readonly (string | McpServerConfig)[] | null | undefined,
  normalizeServerId: (serverId: string) => string = (serverId) => serverId,
  formatDeniedTool: (serverId: string, tool: string) => string = (
    serverId,
    tool
  ) => `mcp__${serverId}__${tool}`
): ToolPermissionConfig | null | undefined {
  if (!mcpServers) {
    return toolPermissions;
  }

  const serverDeniedTools = mcpServers.flatMap((server) =>
    typeof server === "object" && server !== null && server.deniedTools?.length
      ? server.deniedTools.map((tool) =>
          formatDeniedTool(normalizeServerId(server.id), tool)
        )
      : []
  );
  if (serverDeniedTools.length === 0) {
    return toolPermissions;
  }
  if (toolPermissions === null) {
    return null;
  }

  const base = toolPermissions ?? {
    mode: PERMISSION_MODES.ALLOW_ALL,
    allowedTools: [],
    deniedTools: [],
  };
  return {
    ...base,
    deniedTools: [...base.deniedTools, ...serverDeniedTools],
  };
}

/** Match Claude Code's MCP server name normalization for permission rules. */
export function normalizeClaudeMcpServerId(serverId: string): string {
  return serverId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Result of {@link foldMcpToolDenialsIntoServers}. */
export interface FoldedMcpToolDenials {
  /** `mcpServers` with each foldable denial added to its server's `deniedTools`. */
  readonly mcpServers: readonly (string | McpServerConfig)[] | undefined;
  /** The `deniedTools` patterns that no attached server could take. */
  readonly unfolded: readonly string[];
}

/**
 * Move `mcp__<server>__<tool>` denials onto the attached server entry they
 * name, for harnesses that filter MCP tools in the server's own config rather
 * than through permission patterns (Codex `disabled_tools`). The inverse of
 * {@link mergeServerDeniedTools}.
 *
 * Only object entries in `mcpServers` can take a denial: a server the harness
 * loads from its own config is not known to ctrlyoke, and Codex refuses to
 * start when an override names a server it has no transport for. A wildcard
 * tool name stays unfolded because `disabled_tools` matches exact names.
 * The ctrlyoke server is left alone: its denials are enforced by the server
 * itself from its `mcpServers` entry.
 */
export function foldMcpToolDenialsIntoServers(
  toolPermissions: ToolPermissionConfig | null | undefined,
  mcpServers: readonly (string | McpServerConfig)[] | null | undefined,
  excludedServerIds: ReadonlySet<string> = new Set()
): FoldedMcpToolDenials {
  const servers = mcpServers ?? undefined;
  if (
    !toolPermissions ||
    !permissionModeAppliesToolList(
      toolPermissions.mode,
      PERMISSION_CAPABILITY_KEYS.DENIED_TOOLS
    )
  ) {
    return { mcpServers: servers, unfolded: [] };
  }

  const attached = (servers ?? []).filter(
    (server): server is McpServerConfig =>
      typeof server === "object" &&
      server !== null &&
      !excludedServerIds.has(server.id)
  );
  const added = new Map<McpServerConfig, string[]>();
  const unfolded: string[] = [];
  for (const pattern of toolPermissions.deniedTools) {
    const match = findMcpToolDenialTarget(pattern, attached);
    if (match) {
      added.set(match.server, [
        ...(added.get(match.server) ?? []),
        match.toolName,
      ]);
    } else {
      unfolded.push(pattern);
    }
  }
  if (added.size === 0) {
    return { mcpServers: servers, unfolded };
  }

  return {
    mcpServers: servers?.map((server) => {
      const tools = typeof server === "object" ? added.get(server) : undefined;
      return tools && typeof server === "object"
        ? {
            ...server,
            deniedTools: [
              ...new Set([...(server.deniedTools ?? []), ...tools]),
            ],
          }
        : server;
    }),
    unfolded,
  };
}

/** Breadth of each managed mode; `none` defers to the harness and has no rank. */
const PERMISSION_MODE_BREADTH: Partial<Record<PermissionMode, number>> = {
  [PERMISSION_MODES.CUSTOM]: 0,
  [PERMISSION_MODES.ALLOW_ALL]: 1,
  [PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL]: 2,
};

/** `null` and mode `none` both pass no flags, leaving the harness's own config. */
function defersToHarness(config: ToolPermissionConfig | null): boolean {
  return config === null || config.mode === PERMISSION_MODES.NONE;
}

/**
 * True when `candidate` provably lets a harness do no more without asking
 * than `baseline`. Patterns compare as exact strings, so anything this can't
 * prove narrower (a reworded pattern, deferring to the harness's own config
 * while the baseline does not) counts as wider.
 */
export function isToolPermissionConfigNoWiderThan(
  candidate: ToolPermissionConfig | null,
  baseline: ToolPermissionConfig | null
): boolean {
  if (defersToHarness(candidate) || defersToHarness(baseline)) {
    return defersToHarness(candidate) && defersToHarness(baseline);
  }
  const candidateConfig = candidate!;
  const baselineConfig = baseline!;
  const candidateBreadth = PERMISSION_MODE_BREADTH[candidateConfig.mode]!;
  const baselineBreadth = PERMISSION_MODE_BREADTH[baselineConfig.mode]!;
  if (candidateBreadth > baselineBreadth) return false;
  if (candidateConfig.mode === PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL) {
    return true;
  }

  const appliedList = (
    config: ToolPermissionConfig,
    list:
      | typeof PERMISSION_CAPABILITY_KEYS.ALLOWED_TOOLS
      | typeof PERMISSION_CAPABILITY_KEYS.DENIED_TOOLS
  ): readonly string[] =>
    permissionModeAppliesToolList(config.mode, list) ? config[list] : [];

  const candidateDenied = new Set(
    appliedList(candidateConfig, PERMISSION_CAPABILITY_KEYS.DENIED_TOOLS)
  );
  const keepsBaselineDenials = appliedList(
    baselineConfig,
    PERMISSION_CAPABILITY_KEYS.DENIED_TOOLS
  ).every((pattern) => candidateDenied.has(pattern));
  if (!keepsBaselineDenials) return false;

  // A custom allow-list only widens anything against another custom list;
  // against allowAll it is already a subset.
  if (
    candidateConfig.mode !== PERMISSION_MODES.CUSTOM ||
    baselineConfig.mode !== PERMISSION_MODES.CUSTOM
  ) {
    return true;
  }
  const baselineAllowed = new Set(baselineConfig.allowedTools);
  return candidateConfig.allowedTools.every((pattern) =>
    baselineAllowed.has(pattern)
  );
}

function findMcpToolDenialTarget(
  pattern: string,
  servers: readonly McpServerConfig[]
): { server: McpServerConfig; toolName: string } | undefined {
  // Prefer the longest matching id so `mcp__a__b__c` picks server `a__b`
  // over server `a` when both are attached.
  let best: { server: McpServerConfig; toolName: string } | undefined;
  for (const server of servers) {
    const prefix = `mcp__${server.id}__`;
    if (!pattern.startsWith(prefix)) continue;
    const toolName = pattern.slice(prefix.length);
    if (!toolName || toolName.includes("*")) continue;
    if (!best || server.id.length > best.server.id.length) {
      best = { server, toolName };
    }
  }
  return best;
}
