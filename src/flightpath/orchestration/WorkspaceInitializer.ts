import * as fs from "fs";
import * as path from "path";
import { Log } from "../../utils/Log";
import { PATH_CONSTANTS } from "../../utils/ConfigurationUtils";

const GITIGNORE_CONTENT = [
  "# FlightPath runtime directories — generated at runtime, do not commit",
  `${PATH_CONSTANTS.HISTORY_DIR}/`,
  `${PATH_CONSTANTS.QUEUE_DIR}/`,
  `${PATH_CONSTANTS.LOGS_DIR}/`,
  `${PATH_CONSTANTS.TEMP_DIR}/`,
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
    if (!fs.existsSync(gitignorePath)) {
      await fs.promises.writeFile(gitignorePath, GITIGNORE_CONTENT, "utf8");
    }

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
}
