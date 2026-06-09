import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PATH_CONSTANTS } from "./ConfigurationUtils";

function getHomeDir(): string {
  return os.homedir();
}

function pickExistingPath(
  candidates: string[],
  fallback: string
): string {
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? fallback;
}

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
  const home = getHomeDir();
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
  return path.join(getHomeDir(), ".claude.json");
}

/**
 * Returns the Copilot CLI workspace MCP config path.
 *
 * GitHub Copilot's canonical project-level MCP location is `.github/mcp.json`.
 * Returned as an array for compatibility with discovery callers.
 */
export function getCopilotWorkspaceMcpConfigPaths(workspaceRoot: string): string[] {
  return [path.join(workspaceRoot, ".github", "mcp.json")];
}

export function getPreferredCopilotWorkspaceMcpConfigPath(
  workspaceRoot: string
): string {
  const candidates = getCopilotWorkspaceMcpConfigPaths(workspaceRoot);
  return pickExistingPath(candidates, candidates[0]!);
}

/**
 * Returns the Copilot CLI user MCP config file path.
 *
 * GitHub documents `~/.copilot/mcp-config.json` by default and allows
 * overriding the base directory with `COPILOT_HOME`.
 */
export function getCopilotUserMcpConfigPath(): string {
  const configuredHome = process.env.COPILOT_HOME?.trim();
  if (configuredHome) {
    return path.join(configuredHome, "mcp-config.json");
  }
  return path.join(getHomeDir(), ".copilot", "mcp-config.json");
}

/**
 * Returns the Codex workspace MCP config path.
 *
 * Project-local Codex config is inferred from the official Codex repository's
 * current config layering behavior (`.codex/config.toml` in the workspace).
 */
export function getCodexWorkspaceMcpConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".codex", "config.toml");
}

/**
 * Returns the Codex user MCP config path.
 *
 * OpenAI documents `~/.codex/config.toml` and Codex also supports overriding
 * the config home with `CODEX_HOME`.
 */
export function getCodexUserMcpConfigPath(): string {
  const configuredHome = process.env.CODEX_HOME?.trim();
  if (configuredHome) {
    return path.join(configuredHome, "config.toml");
  }
  return path.join(getHomeDir(), ".codex", "config.toml");
}

/**
 * Returns the OpenCode workspace MCP config path (`opencode.json`).
 */
export function getOpenCodeWorkspaceMcpConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, "opencode.json");
}

/**
 * Returns the OpenCode user MCP config path.
 *
 * OpenCode supports both `OPENCODE_CONFIG` (exact file) and
 * `OPENCODE_CONFIG_DIR` (config directory override).
 */
export function getOpenCodeUserMcpConfigPath(): string {
  const configuredFile = process.env.OPENCODE_CONFIG?.trim();
  if (configuredFile) {
    return configuredFile;
  }

  const configuredDir = process.env.OPENCODE_CONFIG_DIR?.trim();
  if (configuredDir) {
    return path.join(configuredDir, "opencode.json");
  }

  return path.join(getHomeDir(), ".config", "opencode", "opencode.json");
}

/**
 * Returns the Qwen Code workspace MCP settings path (`.qwen/settings.json`).
 */
export function getQwenWorkspaceMcpConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".qwen", "settings.json");
}

/**
 * Returns the Qwen Code user MCP settings path (`~/.qwen/settings.json`).
 */
export function getQwenUserMcpConfigPath(): string {
  return path.join(getHomeDir(), ".qwen", "settings.json");
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
    getHomeDir(),
    PATH_CONSTANTS.FLIGHTPATH_DIR,
    PATH_CONSTANTS.MCP_DIR,
    PATH_CONSTANTS.MCP_SERVERS_FILE
  );
}
