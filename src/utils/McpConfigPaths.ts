import * as os from "os";
import * as path from "path";
import { PATH_CONSTANTS } from "./ConfigurationUtils";

/**
 * Returns the workspace VS Code MCP config path (.vscode/mcp.json).
 */
export function getVscodeWorkspaceMcpConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".vscode", "mcp.json");
}

/**
 * Returns the workspace Claude MCP config path (.mcp.json).
 */
export function getClaudeWorkspaceMcpConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".mcp.json");
}

/**
 * Returns the platform-specific path to the VS Code user MCP config file.
 *
 * VS Code uses `servers` as the top-level key (not `mcpServers`).
 */
export function getVscodeUserMcpConfigPath(): string {
  const home = os.homedir();
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return path.join(appData, "Code", "User", "mcp.json");
  }
  if (process.platform === "darwin") {
    return path.join(
      home,
      "Library",
      "Application Support",
      "Code",
      "User",
      "mcp.json"
    );
  }
  return path.join(home, ".config", "Code", "User", "mcp.json");
}

/**
 * Returns the path to the Claude Code user config file (~/.claude.json).
 * This file stores user-scope MCP servers at the top-level `mcpServers` key.
 */
export function getClaudeUserConfigPath(): string {
  return path.join(os.homedir(), ".claude.json");
}

/**
 * Returns the workspace FlightPath MCP registry path.
 */
export function getFlightpathWorkspaceMcpRegistryPath(
  workspaceRoot: string
): string {
  return path.join(
    workspaceRoot,
    PATH_CONSTANTS.FLIGHTPATH_DIR,
    PATH_CONSTANTS.MCP_DIR,
    PATH_CONSTANTS.MCP_SERVERS_FILE
  );
}

/**
 * Returns the user FlightPath MCP registry path (~/.flightpath/mcp/servers.json).
 */
export function getFlightpathUserMcpRegistryPath(): string {
  return path.join(
    os.homedir(),
    PATH_CONSTANTS.FLIGHTPATH_DIR,
    PATH_CONSTANTS.MCP_DIR,
    PATH_CONSTANTS.MCP_SERVERS_FILE
  );
}
