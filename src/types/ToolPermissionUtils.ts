import { PERMISSION_MODES } from "./DashboardConstants";
import type { McpServerConfig } from "./CtrlYokeTypes";
import type { ToolPermissionConfig } from "./ExecutionPropertyTypes";

/**
 * Merge per-server MCP denials into the unified tool permission configuration.
 *
 * This is the single permission rule shared by author-time compatibility
 * analysis and runtime harness preparation. Server-level tool names are bare;
 * harness permission patterns use the `mcp__<server>__<tool>` form.
 */
export function mergeServerDeniedTools(
  toolPermissions: ToolPermissionConfig | null | undefined,
  mcpServers: readonly (string | McpServerConfig)[] | null | undefined
): ToolPermissionConfig | null | undefined {
  if (!mcpServers) {
    return toolPermissions;
  }

  const serverDeniedTools = mcpServers.flatMap((server) =>
    typeof server === "object" && server !== null && server.deniedTools?.length
      ? server.deniedTools.map((tool) => `mcp__${server.id}__${tool}`)
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
