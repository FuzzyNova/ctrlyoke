import * as fs from "fs";
import { AgentDiscovery, AgentInfo } from "./AgentDiscovery";
import { Log } from "./Log";
import { resolveWorkspaceFolder } from "./DiscoveryUtils";
import { TtlCache } from "./TtlCache";

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
 * - Uses AgentDiscovery to locate agent files (with TTL-based caching)
 * - Returns raw file content (no wrapping) - caller is responsible for XML tags
 * - Handles missing agents gracefully (returns null)
 * - File reads are NOT cached (prevents stale content during development)
 */

export class AgentExpander {
  private static readonly agentCache = new TtlCache<AgentInfo>(5000);

  /** Get cached agents or refresh the cache from disk */
  private static async getAgents(workspaceRoot?: string): Promise<AgentInfo[]> {
    const workspaceFolder = resolveWorkspaceFolder(workspaceRoot);
    return AgentExpander.agentCache.get(() =>
      AgentDiscovery.discoverAgents(workspaceFolder)
    );
  }

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
    const agents = await AgentExpander.getAgents(workspaceRoot);

    // Find the requested agent by name
    const agent = AgentDiscovery.findAgentByName(agents, agentName);
    if (!agent || !agent.path) {
      Log.warn(`⚠️ Agent "${agentName}" not found among discovered agents`);
      return null;
    }

    // Read agent file content
    try {
      const content = await fs.promises.readFile(agent.path, "utf-8");
      Log.debug(`🤖 Agent "${agentName}" loaded from ${agent.path}`);
      return AgentExpander.stripFrontmatter(content, agentName);
    } catch (error) {
      Log.warn(`⚠️ Failed to read agent file "${agent.path}": ${error}`);
      return null;
    }
  }

  /**
   * Extract the `name:` field from agent frontmatter.
   * Returns undefined if no frontmatter or no name field is present.
   */
  static extractFrontmatterName(content: string): string | undefined {
    if (!content.startsWith("---")) {
      return undefined;
    }
    const closingIdx = content.indexOf("---", 3);
    if (closingIdx === -1) {
      return undefined;
    }
    const frontmatter = content.substring(3, closingIdx);
    const match = frontmatter.match(/^\s*name\s*:\s*(.+)$/m);
    if (!match) {
      return undefined;
    }
    // Strip surrounding quotes if present
    return match[1].trim().replace(/^["']|["']$/g, "");
  }

  /**
   * Get the VS Code command name suffix for an agent.
   *
   * VS Code registers agent commands using the frontmatter `name:` field, not the filename:
   *   `workbench.action.chat.open<frontmatterName>`
   *
   * For example, `senior-developer.agent.md` with `name: Senior Developer` registers as
   * `workbench.action.chat.openSenior Developer`.
   *
   * Falls back to the file-based name if the frontmatter name is unavailable.
   *
   * @param agentName Agent name (without .agent.md extension)
   * @param workspaceRoot Workspace root for resolving workspace agents
   */
  static async getAgentCommandName(
    agentName: string,
    workspaceRoot?: string
  ): Promise<string> {
    const agents = await AgentExpander.getAgents(workspaceRoot);
    const agent = AgentDiscovery.findAgentByName(agents, agentName);

    if (!agent?.path) {
      return agentName;
    }

    try {
      const content = await fs.promises.readFile(agent.path, "utf-8");
      const frontmatterName = AgentExpander.extractFrontmatterName(content);
      if (frontmatterName) {
        Log.debug(
          `🤖 Agent command name: "${frontmatterName}" (file: ${agentName})`
        );
        return frontmatterName;
      }
    } catch (error) {
      Log.warn(`⚠️ Could not read agent file for command name: ${error}`);
    }

    return agentName;
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
