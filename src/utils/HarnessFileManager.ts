import * as path from "path";
import * as fs from "fs";
import { Log } from "./Log";
import { getErrorMessage } from "./ErrorUtils";
import type {
  HarnessId,
  AnyTargetId,
  SettingWriteScope,
} from "../types/DashboardConstants";
import { SETTING_SCOPES } from "../types/DashboardConstants";
import {
  getHarnessAgentDirs,
  getHarnessUserAgentDirs,
  getHarnessSkillDirs,
  getHarnessUserSkillDirs,
  getCtrlYokeAgentDir,
  getCtrlYokeSkillDir,
  getCtrlYokeUserAgentDir,
  getCtrlYokeUserSkillDir,
  getAgentsWorkspaceAgentDir,
  getAgentsUserAgentDir,
  getAgentsWorkspaceSkillDir,
  getAgentsUserSkillDir,
  getVSCodeUserAgentDirs,
  getAllHarnessIds,
  HARNESS_AGENT_EXTENSION,
} from "./HarnessDirectoryUtils";
import { isAccessibleDirectory, formatDisplayName } from "./DiscoveryUtils";

// ============================================================================
// Public Types
// ============================================================================

export interface ManagedFileLocation {
  harnessId: AnyTargetId;
  /** Whether this copy lives in a workspace dir or a user-level dir */
  scope: SettingWriteScope;
  path: string;
}

export interface ManagedFile {
  name: string;
  displayName: string;
  type: "agent" | "skill";
  locations: ManagedFileLocation[];
}

export interface ManagedTargetDirectory {
  harnessId: AnyTargetId;
  scope: SettingWriteScope;
  path: string;
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
 * Collect all agent locations across all harness workspace dirs, user dirs, and .ctrlyoke/.
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
    targetId: AnyTargetId,
    scope: SettingWriteScope,
    scannedSet?: Set<string>
  ) => {
    const normalized = path.normalize(dir);
    if (scannedSet) {
      if (scannedSet.has(normalized)) return;
      scannedSet.add(normalized);
    }
    if (!(await isAccessibleDirectory(dir))) return;
    const ext =
      targetId === "ctrlyoke" || targetId === "agents" || targetId === "vscode"
        ? ".agent.md"
        : (HARNESS_AGENT_EXTENSION[targetId as HarnessId] ?? ".agent.md");
    const files = await fs.promises.readdir(dir).catch(() => [] as string[]);
    for (const f of files) {
      // Accept both .agent.md and plain .md for vscode/agents (multi-harness dirs)
      const isAgentMd = f.endsWith(".agent.md");
      const isPlainMd = f.endsWith(".md") && !isAgentMd;
      if (
        !f.endsWith(ext) &&
        !(isPlainMd && (targetId === "agents" || targetId === "vscode"))
      )
        continue;
      const name = isAgentMd
        ? f.slice(0, -".agent.md".length)
        : f.slice(0, -".md".length);
      addAgent(name, { harnessId: targetId, scope, path: path.join(dir, f) });
    }
  };

  // Track scanned dirs to deduplicate across all passes
  const scannedWorkspace = new Set<string>();
  const scannedUser = new Set<string>();

  // ctrlyoke workspace dir (first so it takes priority)
  await scanAgentDir(
    getCtrlYokeAgentDir(workspaceRoot),
    "ctrlyoke",
    SETTING_SCOPES.WORKSPACE,
    scannedWorkspace
  );

  // ctrlyoke user dir (~/.ctrlyoke/agents)
  await scanAgentDir(
    getCtrlYokeUserAgentDir(),
    "ctrlyoke",
    SETTING_SCOPES.USER,
    scannedUser
  );

  // Generic "Agents" dirs (.agents / ~/.agents) — scanned before harness dirs so dedup
  // labels them "agents" rather than any specific harness that also points here (e.g. Codex)
  await scanAgentDir(
    getAgentsWorkspaceAgentDir(workspaceRoot),
    "agents",
    SETTING_SCOPES.WORKSPACE,
    scannedWorkspace
  );
  await scanAgentDir(
    getAgentsUserAgentDir(),
    "agents",
    SETTING_SCOPES.USER,
    scannedUser
  );

  // VS Code user prompts dirs (user-only)
  for (const dir of getVSCodeUserAgentDirs()) {
    await scanAgentDir(dir, "vscode", SETTING_SCOPES.USER, scannedUser);
  }

  // Harness workspace dirs (dedup — skips any dir already claimed above)
  for (const harnessId of getAllHarnessIds()) {
    for (const dir of getHarnessAgentDirs(harnessId, workspaceRoot)) {
      await scanAgentDir(
        dir,
        harnessId,
        SETTING_SCOPES.WORKSPACE,
        scannedWorkspace
      );
    }
  }

  // Harness user dirs (dedup — skips any dir already claimed above)
  for (const harnessId of getAllHarnessIds()) {
    for (const dir of getHarnessUserAgentDirs(harnessId)) {
      await scanAgentDir(dir, harnessId, SETTING_SCOPES.USER, scannedUser);
    }
  }

  return Array.from(byName.values());
}

/**
 * Collect all skill locations across all harness workspace dirs, user dirs, and .ctrlyoke/.
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
    targetId: AnyTargetId,
    scope: SettingWriteScope,
    scannedSet?: Set<string>
  ) => {
    const normalized = path.normalize(dir);
    if (scannedSet) {
      if (scannedSet.has(normalized)) return;
      scannedSet.add(normalized);
    }
    if (!(await isAccessibleDirectory(dir))) return;
    const entries = await fs.promises
      .readdir(dir, { withFileTypes: true })
      .catch(() => [] as fs.Dirent[]);
    for (const e of entries) {
      if (e.isDirectory() && (await isSkillDir(dir, e.name))) {
        addSkill(e.name, {
          harnessId: targetId,
          scope,
          path: path.join(dir, e.name),
        });
      }
    }
  };

  const scannedWorkspace = new Set<string>();
  const scannedUser = new Set<string>();

  // ctrlyoke workspace dir (first for priority)
  await scanSkillDir(
    getCtrlYokeSkillDir(workspaceRoot),
    "ctrlyoke",
    SETTING_SCOPES.WORKSPACE,
    scannedWorkspace
  );

  // ctrlyoke user dir (~/.ctrlyoke/skills)
  await scanSkillDir(
    getCtrlYokeUserSkillDir(),
    "ctrlyoke",
    SETTING_SCOPES.USER,
    scannedUser
  );

  // Generic "Agents" skill dirs — before harness dirs so dedup assigns correct label
  await scanSkillDir(
    getAgentsWorkspaceSkillDir(workspaceRoot),
    "agents",
    SETTING_SCOPES.WORKSPACE,
    scannedWorkspace
  );
  await scanSkillDir(
    getAgentsUserSkillDir(),
    "agents",
    SETTING_SCOPES.USER,
    scannedUser
  );

  // Harness workspace skill dirs (dedup — skips any dir already claimed above)
  for (const harnessId of getAllHarnessIds()) {
    for (const dir of getHarnessSkillDirs(harnessId, workspaceRoot)) {
      await scanSkillDir(
        dir,
        harnessId,
        SETTING_SCOPES.WORKSPACE,
        scannedWorkspace
      );
    }
  }

  // Harness user skill dirs (dedup — skips any dir already claimed above)
  for (const harnessId of getAllHarnessIds()) {
    for (const dir of getHarnessUserSkillDirs(harnessId)) {
      await scanSkillDir(dir, harnessId, SETTING_SCOPES.USER, scannedUser);
    }
  }

  return Array.from(byName.values());
}

// ============================================================================
// HarnessFileManager
// ============================================================================

export class HarnessFileManager {
  static resolveTargetDirectories(
    workspaceRoot: string,
    type: "agent" | "skill"
  ): ManagedTargetDirectory[] {
    const targets: AnyTargetId[] = [
      "ctrlyoke",
      "agents",
      "vscode",
      ...getAllHarnessIds(),
    ];
    const directories: ManagedTargetDirectory[] = [];

    for (const scope of [
      SETTING_SCOPES.WORKSPACE,
      SETTING_SCOPES.USER,
    ] as const) {
      for (const harnessId of targets) {
        try {
          directories.push({
            harnessId,
            scope,
            path: HarnessFileManager.getTargetDir(
              harnessId,
              workspaceRoot,
              type,
              scope
            ),
          });
        } catch {
          // Some targets only exist for one scope/type combination.
        }
      }
    }

    return directories;
  }

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
    targetHarnessId: AnyTargetId,
    workspaceRoot: string,
    type: "agent" | "skill",
    overwrite = false,
    scope: SettingWriteScope = SETTING_SCOPES.WORKSPACE
  ): Promise<void> {
    const targetDir = HarnessFileManager.getTargetDir(
      targetHarnessId,
      workspaceRoot,
      type,
      scope
    );
    await ensureDir(targetDir);

    if (type === "agent") {
      const isHarnessId = targetHarnessId in HARNESS_AGENT_EXTENSION;
      const destExt = isHarnessId
        ? HARNESS_AGENT_EXTENSION[targetHarnessId as HarnessId]
        : ".agent.md";

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
   * Copy an agent/skill into .ctrlyoke/agents or .ctrlyoke/skills.
   * @param scope "workspace" (default) copies to workspace .ctrlyoke/; "user" copies to ~/.ctrlyoke/.
   */
  static async importToCtrlYoke(
    sourcePath: string,
    workspaceRoot: string,
    type: "agent" | "skill",
    overwrite = false,
    scope: SettingWriteScope = SETTING_SCOPES.WORKSPACE
  ): Promise<void> {
    return HarnessFileManager.exportToHarness(
      sourcePath,
      "ctrlyoke",
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
    harnessId: AnyTargetId,
    workspaceRoot: string,
    type: "agent" | "skill",
    scope: SettingWriteScope = SETTING_SCOPES.WORKSPACE
  ): Promise<void> {
    const targetDir = HarnessFileManager.getTargetDir(
      harnessId,
      workspaceRoot,
      type,
      scope
    );

    if (type === "agent") {
      const isHarnessId = harnessId in HARNESS_AGENT_EXTENSION;
      const ext = isHarnessId
        ? HARNESS_AGENT_EXTENSION[harnessId as HarnessId]
        : ".agent.md";
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
    harnessId: AnyTargetId,
    workspaceRoot: string,
    type: "agent" | "skill",
    scope: SettingWriteScope = SETTING_SCOPES.WORKSPACE
  ): Promise<void> {
    const files =
      type === "agent"
        ? await collectAgentLocations(workspaceRoot)
        : await collectSkillLocations(workspaceRoot);

    for (const file of files) {
      if (
        file.locations.some(
          (l) => l.harnessId === harnessId && l.scope === scope
        )
      ) {
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
    harnessId: AnyTargetId,
    workspaceRoot: string,
    type: "agent" | "skill",
    scope: SettingWriteScope = SETTING_SCOPES.WORKSPACE
  ): string {
    if (harnessId === "ctrlyoke") {
      if (scope === SETTING_SCOPES.USER) {
        return type === "agent"
          ? getCtrlYokeUserAgentDir()
          : getCtrlYokeUserSkillDir();
      }
      return type === "agent"
        ? getCtrlYokeAgentDir(workspaceRoot)
        : getCtrlYokeSkillDir(workspaceRoot);
    }

    if (harnessId === "agents") {
      if (scope === SETTING_SCOPES.USER) {
        return type === "agent"
          ? getAgentsUserAgentDir()
          : getAgentsUserSkillDir();
      }
      return type === "agent"
        ? getAgentsWorkspaceAgentDir(workspaceRoot)
        : getAgentsWorkspaceSkillDir(workspaceRoot);
    }

    if (harnessId === "vscode") {
      // VS Code prompts dir is user-only; no workspace equivalent
      const dirs = getVSCodeUserAgentDirs();
      if (dirs.length === 0) {
        throw new Error("No VS Code user prompts directory found");
      }
      return dirs[0];
    }

    const dirs =
      scope === SETTING_SCOPES.USER
        ? type === "agent"
          ? getHarnessUserAgentDirs(harnessId as HarnessId)
          : getHarnessUserSkillDirs(harnessId as HarnessId)
        : type === "agent"
          ? getHarnessAgentDirs(harnessId as HarnessId, workspaceRoot)
          : getHarnessSkillDirs(harnessId as HarnessId, workspaceRoot);

    if (dirs.length === 0) {
      throw new Error(
        `No ${type} directory configured for harness ${harnessId} (${scope})`
      );
    }
    return dirs[0];
  }
}
