import * as fs from "fs";
import * as path from "path";
import { Log } from "../../utils/Log";
import { PATH_CONSTANTS } from "../../utils/ConfigurationUtils";

const GITIGNORE_CONTENT = [
  "# ctrlyoke runtime directories — generated at runtime, do not commit...unless you really want to",
  `${PATH_CONSTANTS.RUNS_DIR}/`,
  `${PATH_CONSTANTS.SEARCH_INDEX_DIR}/`,
  `${PATH_CONSTANTS.LOGS_DIR}/`,
  `${PATH_CONSTANTS.TEMP_DIR}/`,
  `${PATH_CONSTANTS.CERTS_DIR}/`,
  `${PATH_CONSTANTS.NOTIFICATIONS_DIR}/`,
  PATH_CONSTANTS.CAPABILITIES_FILE,
  ".gitignore",
  "",
].join("\n");

/** User-facing directories created on first init */
const USER_DIRECTORIES = [
  PATH_CONSTANTS.PROMPTS_DIR,
  PATH_CONSTANTS.SCRIPTS_DIR,
  PATH_CONSTANTS.AGENTS_DIR,
  PATH_CONSTANTS.SKILLS_DIR,
  PATH_CONSTANTS.TEMPLATES_DIR,
] as const;

export class WorkspaceInitializer {
  /**
   * Returns true if ctrlyoke has already been initialized in this workspace.
   * A workspace is considered initialized when:
   *   - A `.ctrlyoke/` directory already exists (previously initialized), OR
   *   - A `.ctrlyoke.yaml`, `.ctrlyoke.yml`, or `.ctrlyoke.json` file exists
   *     at the workspace root (committed ctrlyoke workflow files — implicit opt-in).
   *
   * This check is synchronous and cheap (fs.existsSync only).
   */
  static isInitialized(workspaceRoot: string): boolean {
    if (fs.existsSync(path.join(workspaceRoot, PATH_CONSTANTS.CTRLYOKE_DIR))) {
      return true;
    }
    return (
      fs.existsSync(path.join(workspaceRoot, ".ctrlyoke.yaml")) ||
      fs.existsSync(path.join(workspaceRoot, ".ctrlyoke.yml")) ||
      fs.existsSync(path.join(workspaceRoot, ".ctrlyoke.json"))
    );
  }

  /**
   * Initialize the .ctrlyoke workspace directory if it doesn't exist.
   * Creates the directory scaffold and .gitignore on first run.
   * Idempotent: safe to call on every activation.
   * @returns true if the workspace was newly initialized, false if it already existed
   */
  static async initializeIfNeeded(workspaceRoot: string): Promise<boolean> {
    const ctrlyokeDir = path.join(workspaceRoot, PATH_CONSTANTS.CTRLYOKE_DIR);
    const isNew = !fs.existsSync(ctrlyokeDir);

    for (const dir of USER_DIRECTORIES) {
      await fs.promises.mkdir(path.join(ctrlyokeDir, dir), {
        recursive: true,
      });
    }

    const gitignorePath = path.join(ctrlyokeDir, ".gitignore");
    await WorkspaceInitializer.ensureGitignore(gitignorePath);

    if (isNew) {
      Log.info(
        `ctrlyoke: Initialized .ctrlyoke workspace directory at ${ctrlyokeDir}`
      );
    }

    return isNew;
  }

  /**
   * Re-initialize workspace: ensures all directories and .gitignore exist.
   * Does not overwrite existing files. Safe to call at any time.
   */
  static async reinitialize(workspaceRoot: string): Promise<void> {
    await WorkspaceInitializer.initializeIfNeeded(workspaceRoot);
    Log.info("ctrlyoke: Workspace re-initialized");
  }

  private static async ensureGitignore(gitignorePath: string): Promise<void> {
    if (!fs.existsSync(gitignorePath)) {
      await fs.promises.writeFile(gitignorePath, GITIGNORE_CONTENT, "utf8");
      return;
    }

    const currentContent = await fs.promises.readFile(gitignorePath, "utf8");
    const currentEntries = new Set(
      currentContent
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    );
    const missingEntries = GITIGNORE_CONTENT.split("\n").filter((line) => {
      const entry = line.trim();
      return entry.length > 0 && !currentEntries.has(entry);
    });

    if (missingEntries.length === 0) {
      return;
    }

    const separator = currentContent.endsWith("\n") ? "" : "\n";
    await fs.promises.appendFile(
      gitignorePath,
      `${separator}${missingEntries.join("\n")}\n`,
      "utf8"
    );
  }
}
