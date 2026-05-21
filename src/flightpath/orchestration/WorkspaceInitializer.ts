import * as fs from "fs";
import * as path from "path";
import { Log } from "../../utils/Log";
import { PATH_CONSTANTS } from "../../utils/ConfigurationUtils";

const GITIGNORE_CONTENT = [
  "# FlightPath runtime directories — generated at runtime, do not commit...unless you really want to",
  `${PATH_CONSTANTS.HISTORY_DIR}/`,
  `${PATH_CONSTANTS.QUEUE_DIR}/`,
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
  PATH_CONSTANTS.WORKFLOWS_DIR,
  PATH_CONSTANTS.PROMPTS_DIR,
  PATH_CONSTANTS.SCRIPTS_DIR,
  PATH_CONSTANTS.AGENTS_DIR,
  PATH_CONSTANTS.SKILLS_DIR,
  PATH_CONSTANTS.TEMPLATES_DIR,
] as const;

export class WorkspaceInitializer {
  /**
   * Returns true if FlightPath has already been initialized in this workspace.
   * A workspace is considered initialized when:
   *   - A `.flightpath/` directory already exists (previously initialized), OR
   *   - A `.flightpath.yaml`, `.flightpath.yml`, or `.flightpath.json` file exists
   *     at the workspace root (committed FlightPath workflow files — implicit opt-in).
   *
   * This check is synchronous and cheap (fs.existsSync only).
   */
  static isInitialized(workspaceRoot: string): boolean {
    if (
      fs.existsSync(path.join(workspaceRoot, PATH_CONSTANTS.FLIGHTPATH_DIR))
    ) {
      return true;
    }
    return (
      fs.existsSync(path.join(workspaceRoot, ".flightpath.yaml")) ||
      fs.existsSync(path.join(workspaceRoot, ".flightpath.yml")) ||
      fs.existsSync(path.join(workspaceRoot, ".flightpath.json"))
    );
  }

  /**
   * Initialize the .flightpath workspace directory if it doesn't exist.
   * Creates the directory scaffold and .gitignore on first run.
   * Idempotent: safe to call on every activation.
   * @returns true if the workspace was newly initialized, false if it already existed
   */
  static async initializeIfNeeded(workspaceRoot: string): Promise<boolean> {
    const flightpathDir = path.join(
      workspaceRoot,
      PATH_CONSTANTS.FLIGHTPATH_DIR
    );
    const isNew = !fs.existsSync(flightpathDir);

    for (const dir of USER_DIRECTORIES) {
      await fs.promises.mkdir(path.join(flightpathDir, dir), {
        recursive: true,
      });
    }

    const gitignorePath = path.join(flightpathDir, ".gitignore");
    await WorkspaceInitializer.ensureGitignore(gitignorePath);

    if (isNew) {
      Log.info(
        `FlightPath: Initialized .flightpath workspace directory at ${flightpathDir}`
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
    Log.info("FlightPath: Workspace re-initialized");
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
