import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { Log } from "./Log";
import { formatDisplayName, isAccessibleDirectory } from "./DiscoveryUtils";
import {
  getHarnessAgentDirs,
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
  source: DiscoverySource;
  /** Optional human-readable description from a built-in manifest. */
  description?: string;
}

interface BuiltInAgentManifest {
  agents?: Array<{
    file?: unknown;
    label?: unknown;
    description?: unknown;
  }>;
}

/**
 * AgentDiscovery
 *
 * RESPONSIBILITY: Discover bundled and custom agent files from multiple locations
 *
 * Agent discovery locations, in precedence order:
 * 1. User ~/.ctrlyoke/agents/ overrides
 * 2. VS Code user prompts directory and workspace harness directories
 * 3. Bundled ctrlyoke agents (immutable fallback)
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
  static async discoverAgents(
    workspaceFolder?: vscode.WorkspaceFolder
  ): Promise<AgentInfo[]> {
    const agents: AgentInfo[] = [];

    try {
      // 1. User ctrlyoke agents are explicit portable overrides.
      agents.push(
        ...(await this.discoverAgentsInDirectory(
          getCtrlYokeUserAgentDir(),
          DISCOVERY_SOURCES.USER
        ))
      );

      // 2. Discover from VS Code's user prompts directory.
      const userAgents = await this.discoverUserAgents();
      agents.push(...userAgents);

      // 3. Discover from workspace harness agent dirs (Claude, Copilot, Codex, etc.)
      if (workspaceFolder) {
        const workspaceRoot = workspaceFolder.uri.fsPath;
        const scanned = new Set<string>();

        for (const harnessId of Object.values(HARNESS_IDS)) {
          for (const dir of getHarnessAgentDirs(harnessId, workspaceRoot)) {
            const normalized = path.normalize(dir);
            if (scanned.has(normalized)) continue;
            scanned.add(normalized);
            const harnessAgents = await this.discoverAgentsInDirectory(
              dir,
              DISCOVERY_SOURCES.WORKSPACE
            );
            agents.push(...harnessAgents);
          }
        }

        // Discover from workspace .ctrlyoke/agents/ (ctrlyoke-exclusive agents)
        // Agents placed here are only discovered by ctrlyoke — no harness scrapes this
        // directory, preventing duplicate context injection when using harness-native dirs.
        const fpDir = getCtrlYokeAgentDir(workspaceRoot);
        const fpAgents = await this.discoverAgentsInDirectory(
          fpDir,
          DISCOVERY_SOURCES.WORKSPACE_CTRLYOKE
        );
        agents.push(...fpAgents);
      }

      // Bundled agents are immutable fallbacks. A same-named user or workspace
      // agent deliberately shadows the bundled version, so customization survives
      // extension updates without ever copying files during activation.
      const discoveredNames = new Set(agents.map((agent) => agent.name));
      const builtInAgents = await this.discoverBuiltInAgents();
      agents.push(
        ...builtInAgents.filter((agent) => !discoveredNames.has(agent.name))
      );

      Log.debug(`Discovered ${agents.length} agents`);
    } catch (error) {
      Log.error("Error discovering agents:", error);
    }

    return agents;
  }

  /**
   * Return the curated built-in agents from the bundled manifest. The path is
   * relative to this module so it resolves to src/templates in tests and to
   * out/templates in packaged extension/CLI builds.
   */
  static async discoverBuiltInAgents(): Promise<AgentInfo[]> {
    const builtInDir = path.join(__dirname, "..", "templates", "agents");
    const manifestPath = path.join(builtInDir, "manifest.json");

    try {
      const manifest = JSON.parse(
        await fs.promises.readFile(manifestPath, "utf8")
      ) as BuiltInAgentManifest;
      if (!Array.isArray(manifest.agents)) {
        throw new Error("manifest is missing its agents array");
      }

      const agents: AgentInfo[] = [];
      for (const entry of manifest.agents) {
        if (typeof entry.file !== "string" || !entry.file.endsWith(".agent.md")) {
          Log.warn(`Ignoring invalid built-in agent manifest entry: ${entry.file}`);
          continue;
        }

        const agentPath = path.join(builtInDir, entry.file);
        if (!(await this.isAccessibleFile(agentPath))) {
          Log.warn(`Built-in agent file is missing: ${agentPath}`);
          continue;
        }

        const name = entry.file.slice(0, -".agent.md".length);
        agents.push({
          name,
          displayName:
            typeof entry.label === "string"
              ? entry.label
              : formatDisplayName(name),
          path: agentPath,
          source: DISCOVERY_SOURCES.BUILT_IN,
          ...(typeof entry.description === "string"
            ? { description: entry.description }
            : {}),
        });
      }

      return agents;
    } catch (error) {
      Log.error("Unable to discover built-in agents:", error);
      return [];
    }
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
   * `description:` field).  This handles harnesses like Claude CLI whose
   * native agent files are plain *.md, not *.agent.md.
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

        // Always accept *.agent.md; for plain *.md require an agent header
        if (!file.endsWith(".agent.md")) {
          const hasHeader = await AgentDiscovery.hasAgentHeader(filePath);
          if (!hasHeader) {
            continue;
          }
        }

        // Strip .agent.md preferentially so "foo.agent.md" → "foo", "foo.md" → "foo"
        const name = file.endsWith(".agent.md")
          ? file.slice(0, -".agent.md".length)
          : file.slice(0, -".md".length);

        agents.push({
          name,
          displayName: formatDisplayName(name),
          path: filePath,
          source,
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
   * Check if a .md file has a valid agent header (YAML frontmatter).
   * Reads only the first 512 bytes for performance.
   * A valid header starts with "---" and contains a `name:` or `description:`
   * field before the closing "---" delimiter.
   */
  private static async hasAgentHeader(filePath: string): Promise<boolean> {
    try {
      const fd = await fs.promises.open(filePath, "r");
      const buffer = Buffer.alloc(512);
      const { bytesRead } = await fd.read(buffer, 0, 512, 0);
      await fd.close();

      const content = buffer.slice(0, bytesRead).toString("utf8");

      if (!content.startsWith("---")) {
        return false;
      }

      const closingIdx = content.indexOf("---", 3);
      if (closingIdx === -1) {
        return false;
      }

      const frontmatter = content.slice(3, closingIdx);
      return (
        /^\s*name\s*:/m.test(frontmatter) ||
        /^\s*description\s*:/m.test(frontmatter)
      );
    } catch {
      return false;
    }
  }

  private static async isAccessibleFile(filePath: string): Promise<boolean> {
    try {
      const stat = await fs.promises.stat(filePath);
      return stat.isFile();
    } catch {
      return false;
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
