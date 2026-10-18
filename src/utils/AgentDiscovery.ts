import * as path from "path";
import * as fs from "fs";
import { Log } from "./Log";
import {
  collapseDiscoveredByName,
  formatDisplayName,
  isAccessibleDirectory,
} from "./DiscoveryUtils";
import { splitMarkdownFrontmatter } from "./MarkdownFrontmatter";
import { loadYamlDocument } from "../core/WorkflowYamlSchema";
import {
  getHarnessAgentDirs,
  getHarnessUserAgentDirs,
  getAgentsUserAgentDir,
  getCtrlYokeAgentDir,
  getCtrlYokeUserAgentDir,
  getVSCodeUserAgentDirs,
  getVSCodeVariant,
  isWSL,
  getWSLWindowsAppDataDirs,
} from "./HarnessDirectoryUtils";
import {
  HARNESS_IDS,
  DISCOVERY_SOURCES,
  type DiscoverySource,
} from "../types/DashboardConstants";
import type { DiscoveredFileLocationInfo } from "../types/WebviewMessageTypes";

/**
 * Represents a discovered agent file
 */
export interface AgentInfo extends DiscoveredFileLocationInfo {
  /** Agent name (without .agent.md extension) */
  name: string;
  /** Display name for UI (formatted from filename) */
  displayName: string;
  /** Full path to the agent file */
  path: string;
  /** Source location of the agent */
  source: DiscoverySource;
  /** Optional human-readable description from agent frontmatter. */
  description?: string;
  /** Skills the agent declares it needs; attached whenever the agent runs. */
  skills?: string[];
}

interface AgentFrontmatter {
  name?: string;
  description?: string;
  skills?: string[];
}

/**
 * Normalize a frontmatter `skills` value. Accepts a YAML list or a
 * comma-separated string, since harness-native agent files use both forms.
 */
function parseAgentSkills(value: unknown): string[] | undefined {
  const entries = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const skills = [
    ...new Set(
      entries
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
    ),
  ];
  return skills.length > 0 ? skills : undefined;
}

/** Parse the supported display metadata from an agent's YAML frontmatter. */
export function parseAgentFrontmatter(content: string): AgentFrontmatter {
  const split = splitMarkdownFrontmatter(content);
  if (!split) {
    return {};
  }

  try {
    const parsed = loadYamlDocument(split.frontmatter);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const frontmatter = parsed as Record<string, unknown>;
    const skills = parseAgentSkills(frontmatter.skills);
    return {
      ...(typeof frontmatter.name === "string"
        ? { name: frontmatter.name }
        : {}),
      ...(typeof frontmatter.description === "string"
        ? { description: frontmatter.description }
        : {}),
      ...(skills ? { skills } : {}),
    };
  } catch {
    return {};
  }
}

/** Candidate locations for bundled agents across source, test, and esbuild layouts. */
export function getBuiltInAgentsDirectoryCandidates(
  moduleDirectory: string
): string[] {
  return [
    path.join(moduleDirectory, "templates", "agents"),
    path.join(moduleDirectory, "..", "templates", "agents"),
  ];
}

/**
 * AgentDiscovery
 *
 * RESPONSIBILITY: Discover bundled and custom agent files from multiple locations
 *
 * Agent discovery locations, in precedence order:
 * 1. Workspace .ctrlyoke/agents/ (ctrlyoke folders always win, workspace
 * 2. User ~/.ctrlyoke/agents/      before user, like settings)
 * 3. VS Code user prompts directory
 * 4. Harness user agent directories and ~/.agents/
 * 5. Workspace harness directories
 * 6. Bundled ctrlyoke agents (immutable fallback)
 *
 * The result has one entry per name (see collapseDiscoveredByName).
 *
 * AGENT COMPATIBILITY: ✅ ALL PROVIDERS SUPPORTED
 * - Agents now work with ALL harnesses (Copilot CLI, Claude CLI, Codex CLI, Chat)
 * - AgentExpander reads the .agent.md file and prepends <agentInstructions> into each prompt
 * - This resolves the previously broken Claude CLI --agent flag (GitHub issue #9930)
 * - No provider-specific CLI flags are needed; prompt prepending is universal
 *
 * See: https://code.visualstudio.com/docs/copilot/customization/custom-agents
 */
export class AgentDiscovery {
  /**
   * Discover all available agents from all supported locations
   * @param workspaceFolder Current workspace folder (optional)
   * @returns Array of discovered agents
   */
  static async discoverAgents(workspaceRoot?: string): Promise<AgentInfo[]> {
    const agents: AgentInfo[] = [];

    const scanned = new Set<string>();
    const discoverOnce = async (dir: string, source: DiscoverySource) => {
      const normalized = path.normalize(dir);
      if (scanned.has(normalized)) return;
      scanned.add(normalized);
      agents.push(...(await this.discoverAgentsInDirectory(dir, source)));
    };

    try {
      // 1-2. ctrlyoke folders always win a same-name collision. Moving an
      // agent into one of these is how a user picks which copy runs;
      // workspace beats user, like settings. No harness scrapes these
      // folders, which prevents duplicate context injection.
      if (workspaceRoot) {
        await discoverOnce(
          getCtrlYokeAgentDir(workspaceRoot),
          DISCOVERY_SOURCES.WORKSPACE_CTRLYOKE
        );
      }
      await discoverOnce(getCtrlYokeUserAgentDir(), DISCOVERY_SOURCES.USER);

      // 3. Discover from VS Code's user prompts directory.
      const userAgents = await this.discoverUserAgents();
      agents.push(...userAgents);

      // 4. Harness user agent dirs (~/.claude/agents, ~/.copilot/agents, ...)
      //    and the shared ~/.agents dir — the same set the Agents & Skills
      //    manager enumerates.
      for (const harnessId of Object.values(HARNESS_IDS)) {
        for (const dir of getHarnessUserAgentDirs(harnessId)) {
          await discoverOnce(dir, DISCOVERY_SOURCES.USER);
        }
      }
      await discoverOnce(getAgentsUserAgentDir(), DISCOVERY_SOURCES.USER);

      // 5. Discover from workspace harness agent dirs (Claude, Copilot, Codex, etc.)
      if (workspaceRoot) {
        for (const harnessId of Object.values(HARNESS_IDS)) {
          for (const dir of getHarnessAgentDirs(harnessId, workspaceRoot)) {
            await discoverOnce(dir, DISCOVERY_SOURCES.WORKSPACE);
          }
        }
      }

      // Bundled agents are immutable fallbacks. A same-named user or workspace
      // agent deliberately shadows the bundled version, so customization survives
      // extension updates without ever copying files during activation.
      agents.push(...(await this.discoverBuiltInAgents()));
    } catch (error) {
      Log.warn(
        "[AgentDiscovery] Error discovering agents; returning partial results:",
        error
      );
    }

    // One entry per name: the first in precedence order is the copy that
    // runs; the rest are reported as its shadowed copies.
    const collapsed = await collapseDiscoveredByName(agents, workspaceRoot);
    Log.trace(`[AgentDiscovery] Discovered ${collapsed.length} agents`);
    return collapsed;
  }

  /**
   * Return the bundled agents from their .agent.md frontmatter. esbuild
   * bundles this module into out/extension.js, while tests retain out/utils/,
   * so support both output layouts as well as the TypeScript source layout.
   */
  static async discoverBuiltInAgents(): Promise<AgentInfo[]> {
    const builtInDir = await this.findBuiltInAgentsDirectory();
    if (!builtInDir) {
      return [];
    }
    return this.discoverAgentsInDirectory(
      builtInDir,
      DISCOVERY_SOURCES.BUILT_IN
    );
  }

  /**
   * Discover agents from user prompts directory
   * Location: %APPDATA%\Code\User\prompts\ (Windows), ~/Library/Application Support/Code/User/prompts/ (macOS), or $XDG_CONFIG_HOME/Code/User/prompts/ (Linux)
   * On WSL: also checks the Windows host AppData path at /mnt/c/Users/<winuser>/AppData/Roaming/Code/User/prompts
   */
  private static async discoverUserAgents(): Promise<AgentInfo[]> {
    const dirs: string[] = [...getVSCodeUserAgentDirs()];

    // On WSL, VS Code agents stored on the Windows host are not visible via the
    // Linux ~/.config path. Scan the Windows AppData prompts directory as well.
    if (isWSL()) {
      dirs.push(
        ...getWSLWindowsAppDataDirs(getVSCodeVariant(), ["User", "prompts"])
      );
    }

    const results: AgentInfo[] = [];
    for (const dir of dirs) {
      const agents = await this.discoverAgentsInDirectory(
        dir,
        DISCOVERY_SOURCES.USER
      );
      results.push(...agents);
    }
    return results;
  }

  /**
   * Discover agent files in a directory.
   * Includes all *.agent.md files unconditionally and any plain *.md files
   * that contain a valid agent header (YAML frontmatter with a `name:` or
   * `description:` field). It also reads that metadata for every discovered
   * file so the UI can use the author-provided display name and description.
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

      const files = await fs.promises.readdir(directoryPath);
      const mdFiles = files.filter((file) => file.endsWith(".md"));

      for (const file of mdFiles) {
        const filePath = path.join(directoryPath, file);
        const frontmatter = await AgentDiscovery.readAgentFrontmatter(filePath);

        // Always accept *.agent.md; for plain *.md require an agent header
        if (!file.endsWith(".agent.md")) {
          if (!frontmatter.name && !frontmatter.description) {
            continue;
          }
        }

        // Strip .agent.md preferentially so "foo.agent.md" → "foo", "foo.md" → "foo"
        const name = file.endsWith(".agent.md")
          ? file.slice(0, -".agent.md".length)
          : file.slice(0, -".md".length);

        agents.push({
          name,
          displayName: formatDisplayName(frontmatter.name ?? name),
          path: filePath,
          source,
          ...(frontmatter.description
            ? { description: frontmatter.description }
            : {}),
          ...(frontmatter.skills ? { skills: frontmatter.skills } : {}),
        });
      }

      if (agents.length > 0) {
        Log.trace(
          `[AgentDiscovery] Found ${agents.length} agent(s) in ${directoryPath}:`,
          agents.map((a) => a.name).join(", ")
        );
      }
    } catch (error) {
      Log.warn(
        `[AgentDiscovery] Error discovering agents in ${directoryPath}; skipping:`,
        error
      );
    }

    return agents;
  }

  /**
   * Read supported metadata from an agent's YAML frontmatter. A malformed or
   * absent header produces an empty object so *.agent.md files remain valid.
   */
  private static async readAgentFrontmatter(
    filePath: string
  ): Promise<AgentFrontmatter> {
    try {
      return parseAgentFrontmatter(
        await fs.promises.readFile(filePath, "utf8")
      );
    } catch {
      return {};
    }
  }

  private static async findBuiltInAgentsDirectory(): Promise<string | null> {
    const candidateDirectories = getBuiltInAgentsDirectoryCandidates(__dirname);

    for (const directory of candidateDirectories) {
      if (await isAccessibleDirectory(directory)) {
        return directory;
      }
    }

    Log.error(
      `[AgentDiscovery] Unable to locate built-in agents directory. Checked: ${candidateDirectories.join(", ")}`
    );
    return null;
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
