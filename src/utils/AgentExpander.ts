import * as fs from "fs";
import { AgentDiscovery, AgentInfo } from "./AgentDiscovery";
import { Log } from "./Log";
import { TtlCache } from "./TtlCache";
import { splitMarkdownFrontmatter } from "./DiscoveryUtils";

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
  private static readonly agentCaches = new Map<string, TtlCache<AgentInfo>>();

  /** Get cached agents or refresh the cache from disk */
  private static async getAgents(workspaceRoot?: string): Promise<AgentInfo[]> {
    const cacheKey = workspaceRoot ?? "";
    let cache = AgentExpander.agentCaches.get(cacheKey);
    if (!cache) {
      cache = new TtlCache<AgentInfo>(5000);
      AgentExpander.agentCaches.set(cacheKey, cache);
    }
    return cache.get(() => AgentDiscovery.discoverAgents(workspaceRoot));
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
      Log.warn(
        `[AgentExpander] Agent "${agentName}" not found among discovered agents`
      );
      return null;
    }

    // Read agent file content
    try {
      const content = await fs.promises.readFile(agent.path, "utf-8");
      Log.debug(
        `[AgentExpander] Agent "${agentName}" loaded from ${agent.path}`
      );
      return AgentExpander.stripFrontmatter(content, agentName);
    } catch (error) {
      Log.warn(
        `[AgentExpander] Failed to read agent file "${agent.path}": ${error}`
      );
      return null;
    }
  }

  /**
   * The skills a step actually runs with: its own `skills`, those its agent
   * declares in frontmatter (`skills:`), and any additional prompt references,
   * deduplicated. An unknown agent contributes none. An agent's declared
   * skills are part of the
   * agent, like its body text, so they attach whenever the agent runs, even
   * where the step disables its inherited `skills` with null. Shared by prompt
   * assembly and the dry-run preview so the preview lists what a run attaches.
   */
  static async resolveEffectiveSkills(
    stepSkills: readonly string[] | null | undefined,
    agentName: string | undefined,
    workspaceRoot?: string,
    additionalSkillNames: readonly string[] = []
  ): Promise<string[]> {
    const agentSkills = agentName
      ? (AgentDiscovery.findAgentByName(
          await AgentExpander.getAgents(workspaceRoot),
          agentName
        )?.skills ?? [])
      : [];
    return [
      ...new Set([
        ...(stepSkills ?? []),
        ...agentSkills,
        ...additionalSkillNames,
      ]),
    ];
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
    const split = splitMarkdownFrontmatter(content);
    if (!split) {
      // Malformed frontmatter — return content as-is
      return content;
    }

    const { frontmatter, body } = split;

    if (/^\s*model\s*:/m.test(frontmatter)) {
      Log.warn(
        `[AgentExpander] Agent "${agentName}" specifies a model override — ctrlyoke ignores agent-level model settings and uses its own harness/model configuration.`
      );
    }
    if (/^\s*tools\s*:/m.test(frontmatter)) {
      Log.warn(
        `[AgentExpander] Agent "${agentName}" specifies tool overrides — ctrlyoke ignores agent-level tool settings and uses its own permission configuration (ctrlyoke.cliToolPermissions).`
      );
    }

    return body.trimStart();
  }
}
