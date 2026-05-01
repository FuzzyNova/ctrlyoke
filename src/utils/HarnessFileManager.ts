import * as path from "path";
import * as fs from "fs";
import { Log } from "./Log";
import { getErrorMessage } from "./ErrorUtils";
import type { HarnessId } from "../types/DashboardConstants";
import {
  getHarnessAgentDirs,
  getHarnessSkillDirs,
  getFlightPathAgentDir,
  getFlightPathSkillDir,
  getAllHarnessIds,
  HARNESS_AGENT_EXTENSION,
} from "./HarnessDirectoryUtils";
import { isAccessibleDirectory, formatDisplayName } from "./DiscoveryUtils";

// ============================================================================
// Public Types
// ============================================================================

export interface ManagedFileLocation {
  harnessId: HarnessId | "flightpath";
  path: string;
}

export interface ManagedFile {
  name: string;
  displayName: string;
  type: "agent" | "skill";
  locations: ManagedFileLocation[];
}

export interface SyncResult {
  harnessId: HarnessId;
  success: boolean;
  error?: string;
}

// ============================================================================
// Internal Helpers
// ============================================================================

async function ensureDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
}

async function copyFile(src: string, dest: string): Promise<void> {
  await fs.promises.copyFile(src, dest);
}

async function copyDir(src: string, dest: string): Promise<void> {
  await ensureDir(dest);
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
    }
  }
}

/**
 * Collect all agent locations across all harness workspace dirs and .flightpath/.
 */
async function collectAgentLocations(
  workspaceRoot: string
): Promise<ManagedFile[]> {
  const byName = new Map<string, ManagedFile>();

  const addAgent = (name: string, loc: ManagedFileLocation) => {
    if (!byName.has(name)) {
      byName.set(name, {
        name,
        displayName: formatDisplayName(name),
        type: "agent",
        locations: [],
      });
    }
    byName.get(name)!.locations.push(loc);
  };

  // FlightPath dir
  const fpDir = getFlightPathAgentDir(workspaceRoot);
  if (await isAccessibleDirectory(fpDir)) {
    const files = await fs.promises.readdir(fpDir).catch(() => [] as string[]);
    for (const f of files) {
      if (f.endsWith(".agent.md")) {
        const name = f.replace(/\.agent\.md$/, "");
        addAgent(name, { harnessId: "flightpath", path: path.join(fpDir, f) });
      }
    }
  }

  // All harness workspace dirs
  for (const harnessId of getAllHarnessIds()) {
    const dirs = getHarnessAgentDirs(harnessId, workspaceRoot);
    const ext = HARNESS_AGENT_EXTENSION[harnessId];

    for (const dir of dirs) {
      if (!(await isAccessibleDirectory(dir))) continue;
      const files = await fs.promises.readdir(dir).catch(() => [] as string[]);
      for (const f of files) {
        if (!f.endsWith(ext)) continue;
        // Strip .agent.md preferentially: a .agent.md file in a .md-extension
        // harness dir (e.g. claude-cli) should yield name "foo", not "foo.agent"
        const name = f.endsWith(".agent.md")
          ? f.slice(0, -".agent.md".length)
          : f.slice(0, -ext.length);
        addAgent(name, { harnessId, path: path.join(dir, f) });
      }
    }
  }

  return Array.from(byName.values());
}

/**
 * Collect all skill locations across all harness workspace dirs and .flightpath/.
 */
async function collectSkillLocations(
  workspaceRoot: string
): Promise<ManagedFile[]> {
  const byName = new Map<string, ManagedFile>();

  const addSkill = (name: string, loc: ManagedFileLocation) => {
    if (!byName.has(name)) {
      byName.set(name, {
        name,
        displayName: formatDisplayName(name),
        type: "skill",
        locations: [],
      });
    }
    byName.get(name)!.locations.push(loc);
  };

  const isSkillDir = async (dir: string, name: string): Promise<boolean> => {
    return fs.existsSync(path.join(dir, name, "SKILL.md"));
  };

  // FlightPath dir
  const fpDir = getFlightPathSkillDir(workspaceRoot);
  if (await isAccessibleDirectory(fpDir)) {
    const entries = await fs.promises
      .readdir(fpDir, { withFileTypes: true })
      .catch(() => [] as fs.Dirent[]);
    for (const e of entries) {
      if (e.isDirectory() && (await isSkillDir(fpDir, e.name))) {
        addSkill(e.name, {
          harnessId: "flightpath",
          path: path.join(fpDir, e.name),
        });
      }
    }
  }

  // All harness workspace dirs (deduplicate by resolved path)
  const scanned = new Set<string>();
  for (const harnessId of getAllHarnessIds()) {
    const dirs = getHarnessSkillDirs(harnessId, workspaceRoot);
    for (const dir of dirs) {
      const normalized = path.normalize(dir);
      if (scanned.has(normalized)) continue;
      scanned.add(normalized);

      if (!(await isAccessibleDirectory(dir))) continue;
      const entries = await fs.promises
        .readdir(dir, { withFileTypes: true })
        .catch(() => [] as fs.Dirent[]);
      for (const e of entries) {
        if (e.isDirectory() && (await isSkillDir(dir, e.name))) {
          addSkill(e.name, {
            harnessId,
            path: path.join(dir, e.name),
          });
        }
      }
    }
  }

  return Array.from(byName.values());
}

// ============================================================================
// HarnessFileManager
// ============================================================================

export class HarnessFileManager {
  /**
   * Enumerate all locations where a given agent/skill is present.
   */
  static async resolveAllLocations(
    workspaceRoot: string,
    type: "agent" | "skill"
  ): Promise<ManagedFile[]> {
    try {
      return type === "agent"
        ? collectAgentLocations(workspaceRoot)
        : collectSkillLocations(workspaceRoot);
    } catch (error) {
      Log.error("HarnessFileManager.resolveAllLocations:", error);
      return [];
    }
  }

  /**
   * Copy an agent/skill to a target harness directory, creating the dir if needed.
   * @param overwrite If false (default), throws if the destination already exists.
   */
  static async exportToHarness(
    sourcePath: string,
    targetHarnessId: HarnessId | "flightpath",
    workspaceRoot: string,
    type: "agent" | "skill",
    overwrite = false
  ): Promise<void> {
    const targetDir = HarnessFileManager.getTargetDir(
      targetHarnessId,
      workspaceRoot,
      type
    );
    await ensureDir(targetDir);

    if (type === "agent") {
      const destExt =
        targetHarnessId === "flightpath"
          ? ".agent.md"
          : HARNESS_AGENT_EXTENSION[targetHarnessId as HarnessId] ?? ".agent.md";

      // Determine internal name from source (strip whatever extension it has)
      const srcBase = path.basename(sourcePath);
      const internalName = srcBase.replace(/\.(agent\.md|md)$/, "");
      const destFile = path.join(targetDir, `${internalName}${destExt}`);

      if (!overwrite && fs.existsSync(destFile)) {
        throw new Error(`File already exists: ${destFile}`);
      }
      await copyFile(sourcePath, destFile);
      Log.info(`Exported agent "${internalName}" to ${destFile}`);
    } else {
      const skillName = path.basename(sourcePath);
      const destDir = path.join(targetDir, skillName);

      if (!overwrite && fs.existsSync(destDir)) {
        throw new Error(`Skill directory already exists: ${destDir}`);
      }
      await copyDir(sourcePath, destDir);
      Log.info(`Exported skill "${skillName}" to ${destDir}`);
    }
  }

  /**
   * Copy an agent/skill into .flightpath/agents or .flightpath/skills.
   */
  static async importToFlightPath(
    sourcePath: string,
    workspaceRoot: string,
    type: "agent" | "skill",
    overwrite = false
  ): Promise<void> {
    return HarnessFileManager.exportToHarness(
      sourcePath,
      "flightpath",
      workspaceRoot,
      type,
      overwrite
    );
  }

  /**
   * Delete a file/directory from a specific harness directory.
   */
  static async deleteFromHarness(
    name: string,
    harnessId: HarnessId | "flightpath",
    workspaceRoot: string,
    type: "agent" | "skill"
  ): Promise<void> {
    const targetDir = HarnessFileManager.getTargetDir(
      harnessId,
      workspaceRoot,
      type
    );

    if (type === "agent") {
      const ext =
        harnessId === "flightpath"
          ? ".agent.md"
          : HARNESS_AGENT_EXTENSION[harnessId as HarnessId] ?? ".agent.md";
      const filePath = path.join(targetDir, `${name}${ext}`);
      await fs.promises.rm(filePath, { force: true });
      Log.info(`Deleted agent "${name}" from ${filePath}`);
    } else {
      const dirPath = path.join(targetDir, name);
      await fs.promises.rm(dirPath, { recursive: true, force: true });
      Log.info(`Deleted skill "${name}" from ${dirPath}`);
    }
  }

  /**
   * Export to all listed harness directories at once.
   */
  static async syncToHarnesses(
    sourcePath: string,
    targetHarnessIds: HarnessId[],
    workspaceRoot: string,
    type: "agent" | "skill"
  ): Promise<SyncResult[]> {
    const results: SyncResult[] = [];

    for (const harnessId of targetHarnessIds) {
      try {
        await HarnessFileManager.exportToHarness(
          sourcePath,
          harnessId,
          workspaceRoot,
          type,
          true
        );
        results.push({ harnessId, success: true });
      } catch (error) {
        results.push({
          harnessId,
          success: false,
          error: getErrorMessage(error),
        });
      }
    }

    return results;
  }

  /**
   * Returns the primary target directory for a harness + type combination.
   * Uses the first directory in the workspace dirs list.
   */
  static getTargetDir(
    harnessId: HarnessId | "flightpath",
    workspaceRoot: string,
    type: "agent" | "skill"
  ): string {
    if (harnessId === "flightpath") {
      return type === "agent"
        ? getFlightPathAgentDir(workspaceRoot)
        : getFlightPathSkillDir(workspaceRoot);
    }

    const dirs =
      type === "agent"
        ? getHarnessAgentDirs(harnessId as HarnessId, workspaceRoot)
        : getHarnessSkillDirs(harnessId as HarnessId, workspaceRoot);

    if (dirs.length === 0) {
      throw new Error(`No ${type} directory configured for harness ${harnessId}`);
    }
    return dirs[0];
  }
}
