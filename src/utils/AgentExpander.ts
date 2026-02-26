import * as fs from "fs";
import * as vscode from "vscode";
import { AgentDiscovery } from "./AgentDiscovery";
import { Log } from "./Log";

/**
 * AgentExpander
 *
 * RESPONSIBILITY: Read and expand agent file content for prompt prepending
 *
 * Agents (.agent.md files) can be discovered from:
 * 1. User prompts directory (%APPDATA%\Code\User\prompts\)
 * 2. Workspace .github/agents/ directory
 * 3. Workspace .claude/agents/ directory
 *
 * DESIGN:
 * - Uses AgentDiscovery to locate agent files
 * - Returns raw file content (no wrapping) - caller is responsible for XML tags
 * - Handles missing agents gracefully (returns null)
 * - No caching (file reads are fast, prevents stale content during development)
 */
export class AgentExpander {
  /**
   * Expand an agent reference to its file content.
   *
   * @param agentName Agent name (without .agent.md extension)
   * @param workspaceRoot Workspace root for resolving workspace agents
   * @returns Raw agent file content, or null if agent not found
   */
  static async expandAgent(
    agentName: string,
    workspaceRoot?: string
  ): Promise<string | null> {
    // Resolve workspace folder from workspace root path
    let workspaceFolder: vscode.WorkspaceFolder | undefined;
    if (workspaceRoot) {
      workspaceFolder = vscode.workspace.workspaceFolders?.find(
        (folder) => folder.uri.fsPath === workspaceRoot
      );

      // Fall back to first workspace folder if exact match not found
      if (!workspaceFolder) {
        workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      }
    } else {
      workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    }

    // Discover all available agents
    const agents = await AgentDiscovery.discoverAgents(workspaceFolder);

    // Find the requested agent by name
    const agent = AgentDiscovery.findAgentByName(agents, agentName);
    if (!agent || !agent.path) {
      Log.warn(`⚠️ Agent "${agentName}" not found among discovered agents`);
      return null;
    }

    // Read agent file content
    try {
      const content = await fs.promises.readFile(agent.path, "utf-8");
      Log.info(`🤖 Agent "${agentName}" loaded from ${agent.path}`);
      return AgentExpander.stripFrontmatter(content, agentName);
    } catch (error) {
      Log.warn(`⚠️ Failed to read agent file "${agent.path}": ${error}`);
      return null;
    }
  }

  /**
   * Strip YAML frontmatter from agent file content, returning only the markdown body.
   *
   * FlightPath does NOT honor agent-level model or tool overrides:
   * - `model`: FlightPath uses its own harness/model settings (prompt → workflow → global)
   * - `tools`: FlightPath uses its own permission settings (flightpath.cliToolPermissions)
   *
   * These fields are silently dropped and a warning is logged when present.
   */
  static stripFrontmatter(content: string, agentName: string): string {
    if (!content.startsWith("---")) {
      return content;
    }

    // Find the closing --- (must be at index > 3 to skip the opening ---)
    const closingIdx = content.indexOf("---", 3);
    if (closingIdx === -1) {
      // Malformed frontmatter — return content as-is
      return content;
    }

    const frontmatter = content.substring(3, closingIdx);
    const body = content.substring(closingIdx + 3).trimStart();

    if (/^\s*model\s*:/m.test(frontmatter)) {
      Log.warn(
        `⚠️ Agent "${agentName}" specifies a model override — FlightPath ignores agent-level model settings and uses its own harness/model configuration.`
      );
    }
    if (/^\s*tools\s*:/m.test(frontmatter)) {
      Log.warn(
        `⚠️ Agent "${agentName}" specifies tool overrides — FlightPath ignores agent-level tool settings and uses its own permission configuration (flightpath.cliToolPermissions).`
      );
    }

    return body;
  }
}
