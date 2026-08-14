import * as fs from "fs";
import * as path from "path";
import { Log } from "../../utils/Log";
import { PATH_CONSTANTS } from "../../utils/ConfigurationUtils";

const GITIGNORE_HEADER = [
  "# ctrlyoke generated runtime entries are machine-local. Authored files in",
  "# templates/, scripts/, agents/, skills/, mcp/, and settings.json remain trackable.",
  "#",
  "# This file ignores ITSELF (last line) so initializing ctrlyoke leaves your",
  "# worktree clean. If you edit this file — e.g. to start tracking runs or",
  "# attachments — DELETE the `.gitignore` line at the bottom first. Otherwise your",
  "# changes stay on this machine and every other clone regenerates the defaults.",
].join("\n");

/**
 * Runtime entries written below `.ctrlyoke/`. Keep this exported: managed
 * finalization uses the exact same list to reject a repository whose ignore
 * rules failed to protect runtime state.
 *
 * The rule is "ignore what ctrlyoke generates for itself; track what you
 * authored or explicitly exported" — which is why `templates/`, `scripts/`,
 * `agents/`, `skills/`, `mcp/servers.json`, and `settings.json` are absent.
 * Three entries have non-obvious reasons:
 *
 * - `certs/` and `notifications/` hold a TLS private key and the VAPID private
 *   key. Secrets — never track these.
 * - `attachments/` and `prompts/` are generated stores whose contents mostly
 *   belong to ephemeral `.runs/` work. They are safe to ignore **only because
 *   Save As bundles**: exporting a workflow copies the assets it references
 *   into a tracked sibling `<workflow>.assets/` and rewrites the references.
 *   Adding them here before that shipped would have left tracked workflows
 *   pointing at ignored files on another clone. See `PATH_CONSTANTS.ATTACHMENTS_DIR`
 *   and `ui.instructions.md` ("Save As owns bundle portability").
 * - `snapshots/` is deliberately *not* here: only the dev-build `UxSnapshotButton`
 *   creates it, so users never produce the directory. This repo ignores it from
 *   the root `.gitignore` because ctrlyoke develops itself. Do not "fix" that.
 *
 * `ensureGitignore` only ever appends missing entries — it never prunes — so an
 * entry added here is permanent for every existing workspace, and removing one
 * from this list does nothing for users who already have it. Add deliberately.
 */
export const WORKSPACE_INITIALIZER_RUNTIME_ENTRIES = [
  `${PATH_CONSTANTS.RUNS_DIR}/`,
  `${PATH_CONSTANTS.SEARCH_INDEX_DIR}/`,
  `${PATH_CONSTANTS.LOGS_DIR}/`,
  `${PATH_CONSTANTS.TEMP_DIR}/`,
  `${PATH_CONSTANTS.CERTS_DIR}/`,
  `${PATH_CONSTANTS.NOTIFICATIONS_DIR}/`,
  PATH_CONSTANTS.CAPABILITIES_FILE,
  `${PATH_CONSTANTS.ATTACHMENTS_DIR}/`,
  `${PATH_CONSTANTS.PROMPTS_DIR}/`,
  `${PATH_CONSTANTS.USAGE_DIR}/`,
] as const;

const GITIGNORE_ENTRIES = WORKSPACE_INITIALIZER_RUNTIME_ENTRIES;

const GITIGNORE_SELF_ENTRY = ".gitignore";

const GITIGNORE_CONTENT = [
  GITIGNORE_HEADER,
  ...GITIGNORE_ENTRIES,
  GITIGNORE_SELF_ENTRY,
  "",
].join("\n");

/** Return true for a repository-relative path inside a generated runtime entry. */
export function isWorkspaceInitializerRuntimePath(
  repositoryRelativePath: string
): boolean {
  const normalized = repositoryRelativePath.replace(/\\/g, "/");
  const ctrlyokePrefix = `${PATH_CONSTANTS.CTRLYOKE_DIR}/`;
  if (!normalized.startsWith(ctrlyokePrefix)) return false;
  const ctrlyokeRelative = normalized.slice(ctrlyokePrefix.length);
  return WORKSPACE_INITIALIZER_RUNTIME_ENTRIES.some((entry) => {
    if (entry.endsWith("/")) {
      return ctrlyokeRelative.startsWith(entry);
    }
    return ctrlyokeRelative === entry;
  });
}

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
   * Creates `.ctrlyoke/` itself plus its .gitignore — nothing else.
   * Idempotent: safe to call on every activation.
   *
   * No subdirectories are scaffolded. Every consumer creates its own directory
   * on demand (drafts, sample scripts, imported/custom templates, agents and
   * skills), and every reader tolerates an absent directory, so pre-creating
   * empty folders would only add clutter to the user's workspace.
   *
   * @returns true if the workspace was newly initialized, false if it already existed
   */
  static async initializeIfNeeded(workspaceRoot: string): Promise<boolean> {
    const ctrlyokeDir = path.join(workspaceRoot, PATH_CONSTANTS.CTRLYOKE_DIR);
    const isNew = !fs.existsSync(ctrlyokeDir);

    await fs.promises.mkdir(ctrlyokeDir, { recursive: true });

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
   * Re-initialize workspace: ensures `.ctrlyoke/` and its .gitignore exist and
   * that the .gitignore lists every generated entry.
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
    const missingEntries = [...GITIGNORE_ENTRIES, GITIGNORE_SELF_ENTRY].filter(
      (line) => {
        const entry = line.trim();
        return entry.length > 0 && !currentEntries.has(entry);
      }
    );

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
