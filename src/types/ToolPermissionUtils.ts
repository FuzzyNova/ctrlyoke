import { PERMISSION_MODES } from "./DashboardConstants";
import type { McpServerConfig } from "./CtrlYokeTypes";
import type { ToolPermissionConfig } from "./ExecutionPropertyTypes";

/**
 * Merge per-server MCP denials into the unified tool permission configuration.
 *
 * This is the runtime permission rule for harness preparation. Server-level
 * tool names are bare; harness permission patterns use the
 * `mcp__<server>__<tool>` form. Author-time compatibility analysis owns its
 * MCP diagnostics separately so native and unsupported adapters do not look
 * like general permission failures.
 */
export function mergeServerDeniedTools(
  toolPermissions: ToolPermissionConfig | null | undefined,
  mcpServers: readonly (string | McpServerConfig)[] | null | undefined,
  normalizeServerId: (serverId: string) => string = (serverId) => serverId
): ToolPermissionConfig | null | undefined {
  if (!mcpServers) {
    return toolPermissions;
  }

  const serverDeniedTools = mcpServers.flatMap((server) =>
    typeof server === "object" && server !== null && server.deniedTools?.length
      ? server.deniedTools.map(
          (tool) => `mcp__${normalizeServerId(server.id)}__${tool}`
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
