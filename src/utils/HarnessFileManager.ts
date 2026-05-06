import * as path from "path";
import * as fs from "fs";
import { Log } from "./Log";
import { getErrorMessage } from "./ErrorUtils";
import type { HarnessId } from "../types/DashboardConstants";
import {
  getHarnessAgentDirs,
  getHarnessUserAgentDirs,
  getHarnessSkillDirs,
  getHarnessUserSkillDirs,
  getFlightPathAgentDir,
  getFlightPathSkillDir,
  getFlightPathUserAgentDir,
  getFlightPathUserSkillDir,
  getAllHarnessIds,
  HARNESS_AGENT_EXTENSION,
} from "./HarnessDirectoryUtils";
import { isAccessibleDirectory, formatDisplayName } from "./DiscoveryUtils";

// ============================================================================
// Public Types
// ============================================================================

export interface ManagedFileLocation {
  harnessId: HarnessId | "flightpath";
  /** Whether this copy lives in a workspace dir or a user-level dir */
  scope: "workspace" | "user";
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
 * Collect all agent locations across all harness workspace dirs, user dirs, and .flightpath/.
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

  const scanAgentDir = async (
    dir: string,
    harnessId: HarnessId | "flightpath",
    scope: "workspace" | "user"
  ) => {
    if (!(await isAccessibleDirectory(dir))) return;
    const ext =
      harnessId === "flightpath"
        ? ".agent.md"
        : HARNESS_AGENT_EXTENSION[harnessId as HarnessId] ?? ".agent.md";
    const files = await fs.promises.readdir(dir).catch(() => [] as string[]);
    for (const f of files) {
      if (!f.endsWith(ext)) continue;
      const name = f.endsWith(".agent.md")
        ? f.slice(0, -".agent.md".length)
        : f.slice(0, -ext.length);
      addAgent(name, { harnessId, scope, path: path.join(dir, f) });
    }
  };

  // FlightPath workspace dir
  await scanAgentDir(getFlightPathAgentDir(workspaceRoot), "flightpath", "workspace");

  // FlightPath user dir (~/.flightpath/agents)
  await scanAgentDir(getFlightPathUserAgentDir(), "flightpath", "user");

  // Workspace harness dirs (deduplicate by resolved path)
  const scannedWorkspace = new Set<string>();
  for (const harnessId of getAllHarnessIds()) {
    for (const dir of getHarnessAgentDirs(harnessId, workspaceRoot)) {
      const normalized = path.normalize(dir);
      if (scannedWorkspace.has(normalized)) continue;
      scannedWorkspace.add(normalized);
      await scanAgentDir(dir, harnessId, "workspace");
    }
  }

  // User harness dirs (deduplicate by resolved path)
  const scannedUser = new Set<string>();
  for (const harnessId of getAllHarnessIds()) {
    for (const dir of getHarnessUserAgentDirs(harnessId)) {
      const normalized = path.normalize(dir);
      if (scannedUser.has(normalized)) continue;
      scannedUser.add(normalized);
      await scanAgentDir(dir, harnessId, "user");
    }
  }

  return Array.from(byName.values());
}

/**
 * Collect all skill locations across all harness workspace dirs, user dirs, and .flightpath/.
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

  const scanSkillDir = async (
    dir: string,
    harnessId: HarnessId | "flightpath",
    scope: "workspace" | "user"
  ) => {
    if (!(await isAccessibleDirectory(dir))) return;
    const entries = await fs.promises
      .readdir(dir, { withFileTypes: true })
      .catch(() => [] as fs.Dirent[]);
    for (const e of entries) {
      if (e.isDirectory() && (await isSkillDir(dir, e.name))) {
        addSkill(e.name, { harnessId, scope, path: path.join(dir, e.name) });
      }
    }
  };

  // FlightPath workspace dir
  await scanSkillDir(getFlightPathSkillDir(workspaceRoot), "flightpath", "workspace");

  // FlightPath user dir (~/.flightpath/skills)
  await scanSkillDir(getFlightPathUserSkillDir(), "flightpath", "user");

  // Workspace harness dirs (deduplicate by resolved path)
  const scannedWorkspace = new Set<string>();
  for (const harnessId of getAllHarnessIds()) {
    for (const dir of getHarnessSkillDirs(harnessId, workspaceRoot)) {
      const normalized = path.normalize(dir);
      if (scannedWorkspace.has(normalized)) continue;
      scannedWorkspace.add(normalized);
      await scanSkillDir(dir, harnessId, "workspace");
    }
  }

  // User harness dirs (deduplicate by resolved path)
  const scannedUser = new Set<string>();
  for (const harnessId of getAllHarnessIds()) {
    for (const dir of getHarnessUserSkillDirs(harnessId)) {
      const normalized = path.normalize(dir);
      if (scannedUser.has(normalized)) continue;
      scannedUser.add(normalized);
      await scanSkillDir(dir, harnessId, "user");
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
   * @param scope Whether to target the workspace dir or the user-level dir (default: "workspace").
   */
  static async exportToHarness(
    sourcePath: string,
    targetHarnessId: HarnessId | "flightpath",
    workspaceRoot: string,
    type: "agent" | "skill",
    overwrite = false,
    scope: "workspace" | "user" = "workspace"
  ): Promise<void> {
    const targetDir = HarnessFileManager.getTargetDir(
      targetHarnessId,
      workspaceRoot,
      type,
      scope
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
   * @param scope "workspace" (default) copies to workspace .flightpath/; "user" copies to ~/.flightpath/.
   */
  static async importToFlightPath(
    sourcePath: string,
    workspaceRoot: string,
    type: "agent" | "skill",
    overwrite = false,
    scope: "workspace" | "user" = "workspace"
  ): Promise<void> {
    return HarnessFileManager.exportToHarness(
      sourcePath,
      "flightpath",
      workspaceRoot,
      type,
      overwrite,
      scope
    );
  }

  /**
   * Delete a file/directory from a specific harness directory.
   * @param scope Whether to delete from the workspace dir or the user-level dir (default: "workspace").
   */
  static async deleteFromHarness(
    name: string,
    harnessId: HarnessId | "flightpath",
    workspaceRoot: string,
    type: "agent" | "skill",
    scope: "workspace" | "user" = "workspace"
  ): Promise<void> {
    const targetDir = HarnessFileManager.getTargetDir(
      harnessId,
      workspaceRoot,
      type,
      scope
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
   * Delete every discovered agent/skill that exists in a specific harness directory.
   * @param scope Whether to delete from the workspace dir or the user-level dir (default: "workspace").
   */
  static async deleteAllFromHarness(
    harnessId: HarnessId | "flightpath",
    workspaceRoot: string,
    type: "agent" | "skill",
    scope: "workspace" | "user" = "workspace"
  ): Promise<void> {
    const files =
      type === "agent"
        ? await collectAgentLocations(workspaceRoot)
        : await collectSkillLocations(workspaceRoot);

    for (const file of files) {
      if (file.locations.some((l) => l.harnessId === harnessId && l.scope === scope)) {
        await HarnessFileManager.deleteFromHarness(
          file.name,
          harnessId,
          workspaceRoot,
          type,
          scope
        );
      }
    }
  }

  /**
   * Returns the primary target directory for a harness + type + scope combination.
   */
  static getTargetDir(
    harnessId: HarnessId | "flightpath",
    workspaceRoot: string,
    type: "agent" | "skill",
    scope: "workspace" | "user" = "workspace"
  ): string {
    if (harnessId === "flightpath") {
      if (scope === "user") {
        return type === "agent"
          ? getFlightPathUserAgentDir()
          : getFlightPathUserSkillDir();
      }
      return type === "agent"
        ? getFlightPathAgentDir(workspaceRoot)
        : getFlightPathSkillDir(workspaceRoot);
    }

    const dirs =
      scope === "user"
        ? type === "agent"
          ? getHarnessUserAgentDirs(harnessId as HarnessId)
          : getHarnessUserSkillDirs(harnessId as HarnessId)
        : type === "agent"
          ? getHarnessAgentDirs(harnessId as HarnessId, workspaceRoot)
          : getHarnessSkillDirs(harnessId as HarnessId, workspaceRoot);

    if (dirs.length === 0) {
      throw new Error(`No ${type} directory configured for harness ${harnessId} (${scope})`);
    }
    return dirs[0];
  }
}
