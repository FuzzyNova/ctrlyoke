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
  getHarnessSkillDirs,
  getHarnessUserSkillDirs,
  getCtrlYokeSkillDir,
  getCtrlYokeUserSkillDir,
  getAgentsUserSkillDir,
} from "./HarnessDirectoryUtils";
import {
  HARNESS_IDS,
  DISCOVERY_SOURCES,
  type HarnessId,
  type DiscoverySource,
} from "../types/DashboardConstants";
import type { DiscoveredFileLocationInfo } from "../types/WebviewMessageTypes";

/** Candidate locations for bundled skills across source, test, and esbuild layouts. */
export function getBuiltInSkillsDirectoryCandidates(
  moduleDirectory: string
): string[] {
  return [
    path.join(moduleDirectory, "templates", "skills"),
    path.join(moduleDirectory, "..", "templates", "skills"),
  ];
}

/**
 * Represents a discovered skill
 */
export interface SkillInfo extends DiscoveredFileLocationInfo {
  /** Directory name (= skill name per AgentSkills.io spec) */
  name: string;
  /** Formatted display name for UI */
  displayName: string;
  /** Full path to the SKILL.md file */
  path: string;
  /** Description parsed from frontmatter */
  description: string;
  /** Source location of the skill */
  source: Exclude<DiscoverySource, typeof DISCOVERY_SOURCES.WORKSPACE_CTRLYOKE>;
}

/**
 * SkillDiscovery
 *
 * RESPONSIBILITY: Discover skill files from multiple locations
 *
 * Skill discovery locations (in priority order — the first same-named skill
 * wins, see collapseDiscoveredByName):
 *
 * ctrlyoke folders (always win, workspace before user, like settings):
 *   1. .ctrlyoke/skills/<skill-name>/SKILL.md     (ctrlyoke-exclusive workspace skills — not scraped by any harness)
 *   2. ~/.ctrlyoke/skills/<skill-name>/SKILL.md   (ctrlyoke-exclusive user skills)
 *
 * User-level:
 *   3. Every harness user skill dir from HarnessDirectoryUtils
 *      (~/.claude/skills, ~/.copilot/skills, ~/.codex/skills, ...)
 *   4. ~/.agents/skills/<skill-name>/SKILL.md       (Codex $HOME user skills)
 *
 * Workspace-level (relative to current workspace folder):
 *   5. Every harness workspace skill dir from HarnessDirectoryUtils
 *      (.claude/skills, .github/skills, .agents/skills, ...)
 *   6. ../.agents/skills/<skill-name>/SKILL.md      (Codex $CWD/../ parent folder skills)
 *   7. <git-root>/.agents/skills/<skill-name>/SKILL.md  (Codex $REPO_ROOT skills, if different from workspace)
 *   8. Bundled ctrlyoke skills (immutable fallback)
 *
 * Path deduplication prevents scanning the same directory twice (e.g., when
 * the workspace folder IS the git repository root).
 *
 * Follows the AgentSkills.io open standard for skill discovery.
 */
export class SkillDiscovery {
  /**
   * Discover all available skills from all supported locations.
   * @param workspaceFolder Current workspace folder (optional)
   * @returns Array of discovered skills (deduplicated by path)
   */
  static async discoverSkills(workspaceRoot?: string): Promise<SkillInfo[]> {
    const skills: SkillInfo[] = [];
    const scannedPaths = new Set<string>();

    try {
      // --- ctrlyoke folders: always win a same-name collision ---
      // Moving a skill into one of these is how a user picks which copy
      // runs; workspace beats user, like settings.

      // 1. <workspace>/.ctrlyoke/skills/
      if (workspaceRoot) {
        skills.push(
          ...(await this.discoverInPath(
            getCtrlYokeSkillDir(workspaceRoot),
            DISCOVERY_SOURCES.WORKSPACE,
            scannedPaths
          ))
        );
      }

      // 2. ~/.ctrlyoke/skills/
      skills.push(
        ...(await this.discoverInPath(
          this.getUserPath(getCtrlYokeUserSkillDir),
          DISCOVERY_SOURCES.USER,
          scannedPaths
        ))
      );

      // --- User-level harness locations ---

      // 3. All harness user skill dirs (via HarnessDirectoryUtils)
      // 4. ~/.agents/skills/
      for (const dir of this.getUserSkillDirs()) {
        skills.push(
          ...(await this.discoverInPath(
            dir,
            DISCOVERY_SOURCES.USER,
            scannedPaths
          ))
        );
      }

      // --- Workspace-level harness locations ---

      if (workspaceRoot) {
        // 5. All harness workspace skill dirs (via HarnessDirectoryUtils)
        for (const harnessId of Object.values(HARNESS_IDS)) {
          for (const dir of getHarnessSkillDirs(harnessId, workspaceRoot)) {
            skills.push(
              ...(await this.discoverInPath(
                dir,
                DISCOVERY_SOURCES.WORKSPACE,
                scannedPaths
              ))
            );
          }
        }

        // Parent-dir and git-root Codex fallbacks
        const parentDir = path.dirname(workspaceRoot);
        skills.push(
          ...(await this.discoverInPath(
            path.join(parentDir, ".agents", "skills"),
            DISCOVERY_SOURCES.WORKSPACE,
            scannedPaths
          ))
        );

        const gitRoot = await this.findGitRoot(workspaceRoot);
        if (gitRoot) {
          skills.push(
            ...(await this.discoverInPath(
              path.join(gitRoot, ".agents", "skills"),
              DISCOVERY_SOURCES.WORKSPACE,
              scannedPaths
            ))
          );
        }
      }

      // Bundled skills are immutable fallbacks. A same-named user or
      // workspace skill deliberately shadows the bundled version.
      skills.push(...(await this.discoverBuiltInSkills()));
    } catch (error) {
      Log.warn(
        "[SkillDiscovery] Error discovering skills; returning partial results:",
        error
      );
    }

    // One entry per name: the first in precedence order is the copy that
    // runs; the rest are reported as its shadowed copies.
    const collapsed = await collapseDiscoveredByName(skills, workspaceRoot);
    Log.trace(`[SkillDiscovery] Discovered ${collapsed.length} skills`);
    return collapsed;
  }

  /**
   * Return the bundled skills from their SKILL.md frontmatter. esbuild
   * bundles this module into out/extension.js, while tests retain out/utils/,
   * so support both output layouts as well as the TypeScript source layout.
   */
  static async discoverBuiltInSkills(): Promise<SkillInfo[]> {
    const builtInDir = await this.findBuiltInSkillsDirectory();
    if (!builtInDir) {
      return [];
    }
    return this.discoverSkillsInDirectory(
      builtInDir,
      DISCOVERY_SOURCES.BUILT_IN
    );
  }

  /**
   * Harness-owned user-level skill directories in precedence order — the
   * same set the Agents & Skills manager enumerates. ~/.ctrlyoke/skills is
   * scanned separately, ahead of these.
   */
  private static getUserSkillDirs(): string[] {
    return (
      this.getUserPath(() => [
        ...Object.values(HARNESS_IDS).flatMap((harnessId) =>
          getHarnessUserSkillDirs(harnessId)
        ),
        getAgentsUserSkillDir(),
      ]) ?? []
    );
  }

  /**
   * Build home-directory path(s), returning null when the home directory
   * cannot be determined.
   */
  private static getUserPath<T>(build: () => T): T | null {
    try {
      return build();
    } catch (error) {
      Log.warn("[SkillDiscovery] Error building user directory path:", error);
      return null;
    }
  }

  /**
   * Discover skills in a directory, skipping paths already scanned.
   * @param directoryPath Path to scan (null = skip silently)
   * @param source Source label for discovered skills
   * @param scannedPaths Set of already-scanned normalized paths (mutated)
   */
  private static async discoverInPath(
    directoryPath: string | null,
    source: SkillInfo["source"],
    scannedPaths: Set<string>
  ): Promise<SkillInfo[]> {
    if (!directoryPath) {
      return [];
    }

    const normalizedPath = path.normalize(directoryPath);
    if (scannedPaths.has(normalizedPath)) {
      return [];
    }
    scannedPaths.add(normalizedPath);

    return this.discoverSkillsInDirectory(normalizedPath, source);
  }

  /**
   * Discover all skill directories in a given directory.
   * Each subdirectory that contains a SKILL.md is treated as a skill.
   */
  private static async discoverSkillsInDirectory(
    directoryPath: string,
    source: SkillInfo["source"]
  ): Promise<SkillInfo[]> {
    const skills: SkillInfo[] = [];

    try {
      if (!(await isAccessibleDirectory(directoryPath))) {
        return [];
      }

      const entries = await fs.promises.readdir(directoryPath, {
        withFileTypes: true,
      });

      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) {
          continue;
        }

        const skillName = entry.name;
        const skillFilePath = path.join(directoryPath, skillName, "SKILL.md");

        if (!fs.existsSync(skillFilePath)) {
          continue;
        }

        // Parse frontmatter to get description
        const description = await this.extractDescriptionFromFrontmatter(
          skillFilePath,
          skillName
        );

        skills.push({
          name: skillName,
          displayName: formatDisplayName(skillName),
          path: skillFilePath,
          description,
          source,
        });
      }

      if (skills.length > 0) {
        Log.trace(
          `[SkillDiscovery] Found ${skills.length} skill(s) in ${directoryPath}:`,
          skills.map((s) => s.name).join(", ")
        );
      }
    } catch (error) {
      Log.warn(
        `[SkillDiscovery] Error discovering skills in ${directoryPath}; skipping:`,
        error
      );
    }

    return skills;
  }

  /**
   * Walk up the directory tree from startDir to find the git repository root
   * (i.e., the nearest ancestor containing a .git entry).
   * Returns null if not inside a git repository.
   */
  static async findGitRoot(startDir: string): Promise<string | null> {
    let current = startDir;

    while (true) {
      // Linked worktrees store `.git` as a gitdir pointer file, while normal
      // checkouts store it as a directory. Existence is the relevant signal.
      if (fs.existsSync(path.join(current, ".git"))) {
        return current;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        // Reached filesystem root without finding .git
        return null;
      }
      current = parent;
    }
  }

  /**
   * Extract the description field from a SKILL.md frontmatter.
   * Returns empty string if not found or on parse error.
   */
  private static async extractDescriptionFromFrontmatter(
    skillFilePath: string,
    skillName: string
  ): Promise<string> {
    try {
      const content = await fs.promises.readFile(skillFilePath, "utf-8");

      const split = splitMarkdownFrontmatter(content);
      if (!split) {
        return "";
      }

      const frontmatter = loadYamlDocument(split.frontmatter) as Record<
        string,
        unknown
      >;

      return typeof frontmatter?.description === "string"
        ? frontmatter.description
        : "";
    } catch (error) {
      Log.warn(
        `[SkillDiscovery] Failed to parse frontmatter for skill "${skillName}": ${error}`
      );
      return "";
    }
  }

  private static async findBuiltInSkillsDirectory(): Promise<string | null> {
    const candidateDirectories = getBuiltInSkillsDirectoryCandidates(__dirname);

    for (const directory of candidateDirectories) {
      if (await isAccessibleDirectory(directory)) {
        return directory;
      }
    }

    Log.error(
      `[SkillDiscovery] Unable to locate built-in skills directory. Checked: ${candidateDirectories.join(", ")}`
    );
    return null;
  }

  /**
   * Find a skill by name from a list of discovered skills.
   */
  static findSkillByName(
    skills: SkillInfo[],
    name: string
  ): SkillInfo | undefined {
    return skills.find((skill) => skill.name === name);
  }

  /**
   * Resolve an explicit /skill:<name> reference to its discovered SKILL.md.
   * The first matching entry wins, matching discoverSkills()'s precedence.
   * Resolution remains harness-independent.
   */
  static resolveCtrlYokeSkillInvocation(
    skills: SkillInfo[],
    name: string,
    _harnessId?: HarnessId,
    _workspaceRoot?: string
  ): SkillInfo | undefined {
    return this.findSkillByName(skills, name);
  }
}
