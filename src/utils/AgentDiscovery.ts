import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { Log } from "./Log";
import { formatDisplayName, isAccessibleDirectory } from "./DiscoveryUtils";
import { PATH_CONSTANTS } from "./ConfigurationUtils";

/**
 * Represents a discovered agent file
 */
export interface AgentInfo {
  /** Agent name (without .agent.md extension) */
  name: string;
  /** Display name for UI (formatted from filename) */
  displayName: string;
  /** Full path to the agent file */
  path: string;
  /** Source location of the agent */
  source:
    | "user"
    | "workspace-github"
    | "workspace-claude"
    | "workspace-flightpath";
  /** Whether this agent is compatible with Copilot CLI (always true; agents use prompt prepending) */
  supportsCopilotCli: boolean;
  /** Whether this agent is compatible with Claude CLI (always true; agents use prompt prepending) */
  supportsClaudeCli: boolean;
}

/**
 * AgentDiscovery
 *
 * RESPONSIBILITY: Discover custom agent files from multiple locations
 *
 * Agent discovery locations:
 * 1. User prompts directory: %APPDATA%\Code\User\prompts\ (Windows), ~/Library/Application Support/Code/User/prompts/ (macOS), or $XDG_CONFIG_HOME/Code/User/prompts/ (Linux)
 * 2. Workspace .github/agents/ (Copilot-style agents)
 * 3. Workspace .claude/agents/ (Claude-style agents)
 * 4. Workspace .flightpath/agents/ (FlightPath-exclusive agents — not scraped by any harness)
 *
 * AGENT COMPATIBILITY: ✅ ALL PROVIDERS SUPPORTED
 * - Agents now work with ALL harnesses (Copilot CLI, Claude CLI, Codex CLI, Chat)
 * - AgentExpander reads the .agent.md file and prepends <agentInstructions> into each prompt
 * - This resolves the previously broken Claude CLI --agent flag (GitHub issue #9930)
 * - No provider-specific CLI flags are needed; prompt prepending is universal
 *
 * The `supportsCopilotCli` and `supportsClaudeCli` flags on AgentInfo are retained
 * for backward compatibility (UI filtering) but are always true.
 *
 * See: https://code.visualstudio.com/docs/copilot/customization/custom-agents
 */
export class AgentDiscovery {
  /**
   * Discover all available agents from all supported locations
   * @param workspaceFolder Current workspace folder (optional)
   * @returns Array of discovered agents
   */
  static async discoverAgents(
    workspaceFolder?: vscode.WorkspaceFolder
  ): Promise<AgentInfo[]> {
    const agents: AgentInfo[] = [];

    try {
      // 1. Discover from user prompts directory
      const userAgents = await this.discoverUserAgents();
      agents.push(...userAgents);

      // 2. Discover from workspace .github/agents/
      if (workspaceFolder) {
        const githubAgents = await this.discoverWorkspaceAgents(
          workspaceFolder,
          ".github/agents"
        );
        agents.push(...githubAgents);
      }

      // 3. Discover from workspace .claude/agents/
      if (workspaceFolder) {
        const claudeAgents = await this.discoverWorkspaceAgents(
          workspaceFolder,
          ".claude/agents"
        );
        agents.push(...claudeAgents);
      }

      // 4. Discover from workspace .flightpath/agents/ (FlightPath-exclusive agents)
      // Agents placed here are only discovered by FlightPath — no harness scrapes this
      // directory, preventing duplicate context injection when using harness-native dirs.
      if (workspaceFolder) {
        const flightpathAgents = await this.discoverWorkspaceAgents(
          workspaceFolder,
          `${PATH_CONSTANTS.FLIGHTPATH_DIR}/${PATH_CONSTANTS.AGENTS_DIR}`
        );
        agents.push(...flightpathAgents);
      }

      Log.debug(`Discovered ${agents.length} custom agents`);
    } catch (error) {
      Log.error("Error discovering agents:", error);
    }

    return agents;
  }

  /**
   * Discover agents from user prompts directory
   * Location: %APPDATA%\Code\User\prompts\ (Windows), ~/Library/Application Support/Code/User/prompts/ (macOS), or $XDG_CONFIG_HOME/Code/User/prompts/ (Linux)
   * On WSL: also checks the Windows host AppData path at /mnt/c/Users/<winuser>/AppData/Roaming/Code/User/prompts
   */
  private static async discoverUserAgents(): Promise<AgentInfo[]> {
    const dirs: string[] = [];

    const userPromptsDir = this.getUserPromptsDirectory();
    if (userPromptsDir) {
      dirs.push(userPromptsDir);
    }

    // On WSL, VS Code agents stored on the Windows host are not visible via the
    // Linux ~/.config path. Scan the Windows AppData prompts directory as well.
    if (this.isWSL()) {
      dirs.push(...this.getWSLWindowsPromptsDirs());
    }

    const results: AgentInfo[] = [];
    for (const dir of dirs) {
      const agents = await this.discoverAgentsInDirectory(dir, "user");
      results.push(...agents);
    }
    return results;
  }

  /**
   * Discover agents from workspace subdirectory
   * @param workspaceFolder Workspace folder
   * @param relativePath Relative path within workspace (e.g., ".github/agents")
   */
  private static async discoverWorkspaceAgents(
    workspaceFolder: vscode.WorkspaceFolder,
    relativePath: string
  ): Promise<AgentInfo[]> {
    const agentsDir = path.join(workspaceFolder.uri.fsPath, relativePath);
    const source =
      relativePath === ".github/agents"
        ? "workspace-github"
        : relativePath ===
            `${PATH_CONSTANTS.FLIGHTPATH_DIR}/${PATH_CONSTANTS.AGENTS_DIR}`
          ? "workspace-flightpath"
          : "workspace-claude";

    return this.discoverAgentsInDirectory(agentsDir, source);
  }

  /**
   * Discover all .agent.md files in a directory
   * @param directoryPath Path to search
   * @param source Source location identifier
   */
  private static async discoverAgentsInDirectory(
    directoryPath: string,
    source: AgentInfo["source"]
  ): Promise<AgentInfo[]> {
    const agents: AgentInfo[] = [];

    try {
      if (!(await isAccessibleDirectory(directoryPath))) {
        return [];
      }

      // Read directory contents
      const files = await fs.promises.readdir(directoryPath);

      // Filter for .agent.md files
      const agentFiles = files.filter((file) => file.endsWith(".agent.md"));

      for (const file of agentFiles) {
        const filePath = path.join(directoryPath, file);

        // Extract agent name (remove .agent.md extension)
        const name = file.replace(/\.agent\.md$/, "");

        // All agents now work with all providers via prompt prepending (AgentExpander).
        // The supportsCopilotCli/supportsClaudeCli flags are retained for backward
        // compatibility but are always true regardless of source location.
        const supportsCopilotCli = true;
        const supportsClaudeCli = true;

        agents.push({
          name,
          displayName: formatDisplayName(name),
          path: filePath,
          source,
          supportsCopilotCli,
          supportsClaudeCli,
        });
      }

      if (agents.length > 0) {
        Log.debug(
          `Found ${agents.length} agent(s) in ${directoryPath}:`,
          agents.map((a) => a.name).join(", ")
        );
      }
    } catch (error) {
      Log.error(`Error discovering agents in ${directoryPath}:`, error);
    }

    return agents;
  }

  /**
   * Detect if running inside WSL (Windows Subsystem for Linux).
   * In WSL, VS Code's UI runs on Windows, so agent files stored in the Windows
   * user prompts directory are not visible via the Linux ~/.config path.
   */
  private static isWSL(): boolean {
    return !!(
      process.env.WSL_DISTRO_NAME ||
      process.env.WSLENV ||
      (process.env.PATH && process.env.PATH.includes("/mnt/c/"))
    );
  }

  /**
   * Return all candidate Windows-host prompts directories when running in WSL.
   * Tries USERPROFILE first, then falls back to scanning /mnt/c/Users/*.
   * Path: /mnt/c/Users/<winuser>/AppData/Roaming/Code/User/prompts
   */
  private static getWSLWindowsPromptsDirs(): string[] {
    const dirs: string[] = [];
    const windowsMountBase = "/mnt/c/Users";

    const addPromptsPath = (appDataRoaming: string) => {
      // Support both the primary VS Code variant and the plain "Code" fallback
      const variant = this.getVSCodeVariant();
      const candidates = [path.join(appDataRoaming, variant, "User", "prompts")];
      if (variant !== "Code") {
        candidates.push(path.join(appDataRoaming, "Code", "User", "prompts"));
      }
      for (const p of candidates) {
        if (!dirs.includes(p)) {
          dirs.push(p);
        }
      }
    };

    // Prefer USERPROFILE env var (often set in WSL to /mnt/c/Users/<winuser>)
    const userProfile = process.env.USERPROFILE;
    if (userProfile) {
      const normalizedProfile = userProfile.replace(/\\/g, "/");
      addPromptsPath(path.join(normalizedProfile, "AppData", "Roaming"));
    }

    // Fall back: scan /mnt/c/Users/* for any Windows user profile
    try {
      if (fs.existsSync(windowsMountBase)) {
        const windowsUsers = fs.readdirSync(windowsMountBase);
        for (const winUser of windowsUsers) {
          if (
            winUser === "Public" ||
            winUser === "Default" ||
            winUser === "All Users" ||
            winUser.startsWith(".")
          ) {
            continue;
          }
          addPromptsPath(
            path.join(windowsMountBase, winUser, "AppData", "Roaming")
          );
        }
      }
    } catch {
      // /mnt/c may not be accessible; ignore
    }

    return dirs;
  }

  /**
   * Detect which VS Code variant is running (e.g. "Code", "Code - Insiders", "VSCodium").
   */
  private static getVSCodeVariant(): string {
    const execPath = process.execPath.toLowerCase();
    if (execPath.includes("insiders")) {
      return "Code - Insiders";
    } else if (execPath.includes("vscodium")) {
      return "VSCodium";
    } else {
      return "Code";
    }
  }

  /**
   * Get the user prompts directory path based on OS
   * Windows: %APPDATA%\Code\User\prompts\
   * macOS: ~/Library/Application Support/Code/User/prompts/
   * Linux: $XDG_CONFIG_HOME/Code/User/prompts/ (default: ~/.config/Code/User/prompts/)
   */
  private static getUserPromptsDirectory(): string | null {
    try {
      const platform = os.platform();
      let baseDir: string;

      if (platform === "win32") {
        // Windows: %APPDATA%\Code\User\prompts\
        const appData = process.env.APPDATA;
        if (!appData) {
          Log.warn("APPDATA environment variable not found");
          return null;
        }
        baseDir = path.join(appData, "Code", "User", "prompts");
      } else if (platform === "darwin") {
        // macOS: ~/Library/Application Support/Code/User/prompts/
        const homeDir = os.homedir();
        baseDir = path.join(homeDir, "Library", "Application Support", "Code", "User", "prompts");
      } else {
        // Linux: ~/.config/Code/User/prompts/ (respects XDG_CONFIG_HOME if set)
        const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
        baseDir = path.join(configDir, "Code", "User", "prompts");
      }

      return baseDir;
    } catch (error) {
      Log.error("Error getting user prompts directory:", error);
      return null;
    }
  }

  /**
   * Find an agent by name
   * @param agents List of agents to search
   * @param name Agent name to find
   */
  static findAgentByName(
    agents: AgentInfo[],
    name: string
  ): AgentInfo | undefined {
    return agents.find((agent) => agent.name === name);
  }
}
