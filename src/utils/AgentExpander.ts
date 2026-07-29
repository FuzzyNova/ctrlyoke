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
   * Strip YAML frontmatter from agent file content, returning only the markdown body.
   *
   * ctrlyoke does NOT honor agent-level model or tool overrides:
   * - `model`: ctrlyoke uses its own harness/model settings (prompt → workflow → global)
   * - `tools`: ctrlyoke uses its own permission settings (ctrlyoke.cliToolPermissions)
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
        `⚠️ Agent "${agentName}" specifies a model override — ctrlyoke ignores agent-level model settings and uses its own harness/model configuration.`
      );
    }
    if (/^\s*tools\s*:/m.test(frontmatter)) {
      Log.warn(
        `⚠️ Agent "${agentName}" specifies tool overrides — ctrlyoke ignores agent-level tool settings and uses its own permission configuration (ctrlyoke.cliToolPermissions).`
      );
    }

    return body;
  }
}
