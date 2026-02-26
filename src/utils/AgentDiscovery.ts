import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { Log } from "./Log";

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
  source: "user" | "workspace-github" | "workspace-claude";
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
 * 1. User prompts directory: %APPDATA%\Code\User\prompts\ (Windows) or ~/.config/Code/User/prompts/ (Linux/Mac)
 * 2. Workspace .github/agents/ (Copilot-style agents)
 * 3. Workspace .claude/agents/ (Claude-style agents)
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

      Log.info(`Discovered ${agents.length} custom agents`);
    } catch (error) {
      Log.error("Error discovering agents:", error);
    }

    return agents;
  }

  /**
   * Discover agents from user prompts directory
   * Location: %APPDATA%\Code\User\prompts\ (Windows) or ~/.config/Code/User/prompts/ (Linux/Mac)
   */
  private static async discoverUserAgents(): Promise<AgentInfo[]> {
    const userPromptsDir = this.getUserPromptsDirectory();
    if (!userPromptsDir) {
      return [];
    }

    return this.discoverAgentsInDirectory(userPromptsDir, "user");
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
      // Check if directory exists
      if (!fs.existsSync(directoryPath)) {
        return [];
      }

      const stat = await fs.promises.stat(directoryPath);
      if (!stat.isDirectory()) {
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
          displayName: this.formatDisplayName(name),
          path: filePath,
          source,
          supportsCopilotCli,
          supportsClaudeCli,
        });
      }

      if (agents.length > 0) {
        Log.info(
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
   * Get the user prompts directory path based on OS
   * Windows: %APPDATA%\Code\User\prompts\
   * Linux/Mac: ~/.config/Code/User/prompts/
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
      } else {
        // Linux/Mac: ~/.config/Code/User/prompts/
        const homeDir = os.homedir();
        baseDir = path.join(homeDir, ".config", "Code", "User", "prompts");
      }

      return baseDir;
    } catch (error) {
      Log.error("Error getting user prompts directory:", error);
      return null;
    }
  }

  /**
   * Format agent name for display in UI
   * Converts kebab-case or snake_case to Title Case
   * @param name Agent filename (without extension)
   */
  private static formatDisplayName(name: string): string {
    // Replace hyphens and underscores with spaces
    const withSpaces = name.replace(/[-_]/g, " ");

    // Title case each word
    return withSpaces
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ");
  }

  /**
   * Filter agents by harness compatibility
   * @param agents List of agents to filter
   * @param harness Harness to filter for ("copilot-cli" or "claude-cli")
   */
  static filterAgentsByHarness(
    agents: AgentInfo[],
    harness: "copilot-cli" | "claude-cli"
  ): AgentInfo[] {
    return agents.filter((agent) => {
      if (harness === "copilot-cli") {
        return agent.supportsCopilotCli;
      } else {
        return agent.supportsClaudeCli;
      }
    });
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
