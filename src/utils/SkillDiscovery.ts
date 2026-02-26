import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as yaml from "js-yaml";
import { Log } from "./Log";
import { formatDisplayName, isAccessibleDirectory } from "./DiscoveryUtils";

/**
 * Represents a discovered skill
 */
export interface SkillInfo {
  /** Directory name (= skill name per AgentSkills.io spec) */
  name: string;
  /** Formatted display name for UI */
  displayName: string;
  /** Full path to the SKILL.md file */
  path: string;
  /** Description parsed from frontmatter */
  description: string;
  /** Source location of the skill */
  source: "user" | "workspace";
}

/**
 * SkillDiscovery
 *
 * RESPONSIBILITY: Discover skill files from multiple locations
 *
 * Skill discovery locations (in priority order):
 *
 * User-level:
 *   1. ~/.claude/skills/<skill-name>/SKILL.md       (Claude Code user skills)
 *   2. ~/.copilot/skills/<skill-name>/SKILL.md      (Copilot user skills)
 *   3. ~/.agents/skills/<skill-name>/SKILL.md       (Codex $HOME user skills)
 *
 * Workspace-level (relative to current workspace folder):
 *   4. .claude/skills/<skill-name>/SKILL.md         (Claude Code workspace skills)
 *   5. .github/skills/<skill-name>/SKILL.md         (Copilot workspace skills)
 *   6. .agents/skills/<skill-name>/SKILL.md         (Codex $CWD workspace skills)
 *   7. ../.agents/skills/<skill-name>/SKILL.md      (Codex $CWD/../ parent folder skills)
 *   8. <git-root>/.agents/skills/<skill-name>/SKILL.md  (Codex $REPO_ROOT skills, if different from workspace)
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
  static async discoverSkills(
    workspaceFolder?: vscode.WorkspaceFolder
  ): Promise<SkillInfo[]> {
    const skills: SkillInfo[] = [];
    const scannedPaths = new Set<string>();

    try {
      // --- User-level locations ---

      // 1. ~/.claude/skills/
      skills.push(
        ...(await this.discoverInPath(
          this.getUserPath(".claude", "skills"),
          "user",
          scannedPaths
        ))
      );

      // 2. ~/.copilot/skills/
      skills.push(
        ...(await this.discoverInPath(
          this.getUserPath(".copilot", "skills"),
          "user",
          scannedPaths
        ))
      );

      // 3. ~/.agents/skills/
      skills.push(
        ...(await this.discoverInPath(
          this.getUserPath(".agents", "skills"),
          "user",
          scannedPaths
        ))
      );

      // --- Workspace-level locations ---

      if (workspaceFolder) {
        const workspaceRoot = workspaceFolder.uri.fsPath;

        // 4. <workspace>/.claude/skills/
        skills.push(
          ...(await this.discoverInPath(
            path.join(workspaceRoot, ".claude", "skills"),
            "workspace",
            scannedPaths
          ))
        );

        // 5. <workspace>/.github/skills/
        skills.push(
          ...(await this.discoverInPath(
            path.join(workspaceRoot, ".github", "skills"),
            "workspace",
            scannedPaths
          ))
        );

        // 6. <workspace>/.agents/skills/  (Codex $CWD)
        skills.push(
          ...(await this.discoverInPath(
            path.join(workspaceRoot, ".agents", "skills"),
            "workspace",
            scannedPaths
          ))
        );

        // 7. <workspace-parent>/.agents/skills/  (Codex $CWD/../)
        const parentDir = path.dirname(workspaceRoot);
        skills.push(
          ...(await this.discoverInPath(
            path.join(parentDir, ".agents", "skills"),
            "workspace",
            scannedPaths
          ))
        );

        // 8. <git-root>/.agents/skills/  (Codex $REPO_ROOT, only if different from workspace)
        const gitRoot = await this.findGitRoot(workspaceRoot);
        if (gitRoot) {
          skills.push(
            ...(await this.discoverInPath(
              path.join(gitRoot, ".agents", "skills"),
              "workspace",
              scannedPaths
            ))
          );
        }
      }

      Log.info(`Discovered ${skills.length} skills`);
    } catch (error) {
      Log.error("Error discovering skills:", error);
    }

    return skills;
  }

  /**
   * Build a path under the user's home directory.
   * Returns null if the home directory cannot be determined.
   */
  private static getUserPath(...parts: string[]): string | null {
    try {
      return path.join(os.homedir(), ...parts);
    } catch (error) {
      Log.error("Error building user directory path:", error);
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
        if (!entry.isDirectory()) {
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
        Log.info(
          `Found ${skills.length} skill(s) in ${directoryPath}:`,
          skills.map((s) => s.name).join(", ")
        );
      }
    } catch (error) {
      Log.error(`Error discovering skills in ${directoryPath}:`, error);
    }

    return skills;
  }

  /**
   * Walk up the directory tree from startDir to find the git repository root
   * (i.e., the nearest ancestor containing a .git entry).
   * Returns null if not inside a git repository.
   */
  private static async findGitRoot(startDir: string): Promise<string | null> {
    let current = startDir;

    while (true) {
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

      if (!content.startsWith("---")) {
        return "";
      }

      const closingIdx = content.indexOf("---", 3);
      if (closingIdx === -1) {
        return "";
      }

      const frontmatterText = content.substring(3, closingIdx);
      const frontmatter = yaml.load(frontmatterText) as Record<string, unknown>;

      return typeof frontmatter?.description === "string"
        ? frontmatter.description
        : "";
    } catch (error) {
      Log.warn(
        `⚠️ Failed to parse frontmatter for skill "${skillName}": ${error}`
      );
      return "";
    }
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
}
