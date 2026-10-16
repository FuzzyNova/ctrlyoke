import * as fs from "fs";
import * as path from "path";
import { Log } from "../../utils/Log";
import { PATH_CONSTANTS } from "../../utils/ConfigurationUtils";

const GITIGNORE_HEADER = [
  "# ctrlyoke generated runtime entries are machine-local. Authored files in",
  "# templates/, scripts/, agents/, skills/, mcp/, and settings.json remain trackable.",
  "#",
  "# This file ignores ITSELF (last line) so initialization leaves your worktree",
  "# clean. Before editing it, DELETE that `.gitignore` line. Its absence marks",
  "# this file as user-owned, and ctrlyoke will stop restoring removed defaults.",
  "#",
  "# Managed worktrees reject non-ignored untracked runtime files. They never land",
  "# certs/, notifications/, temp/, or logs/, even when explicitly tracked.",
].join("\n");

interface WorkspaceRuntimeEntryRule {
  entry: string;
  blockWhenTracked: boolean;
}

/**
 * Runtime entries written below `.ctrlyoke/`. Managed finalization rejects any
 * non-ignored untracked path in this list. Entries marked `blockWhenTracked`
 * are secrets or ephemeral transport artifacts and are rejected even when a
 * user explicitly added them to Git.
 *
 * The rule is "ignore what ctrlyoke generates for itself; track what you
 * authored or explicitly exported" — which is why `templates/`, `scripts/`,
 * `agents/`, `skills/`, `mcp/servers.json`, and `settings.json` are absent.
 * Three entries have non-obvious reasons:
 *
 * - `certs/` and `notifications/` hold a TLS private key and the VAPID private
 *   key. Secrets — never track these.
 * - `attachments/` and `prompts/` are generated stores whose contents mostly
 *   belong to ephemeral run work. They are safe to ignore **only because
 *   Save As bundles**: exporting a workflow copies the assets it references
 *   into a tracked sibling `<workflow>.assets/` and rewrites the references.
 *   Adding them here before that shipped would have left tracked workflows
 *   pointing at ignored files on another clone. See `PATH_CONSTANTS.ATTACHMENTS_DIR`
 *   and `ui.instructions.md` ("Save As owns bundle portability").
 * - `snapshots/` is deliberately *not* here: only the dev-build `UxSnapshotButton`
 *   creates it, so users never produce the directory. This repo ignores it from
 *   the root `.gitignore` because ctrlyoke develops itself. Do not "fix" that.
 *
 * While the generated self-ignore marker remains, `ensureGitignore` appends
 * missing entries but never prunes. Removing that marker transfers ownership
 * to the user, after which initialization leaves the file byte-for-byte alone.
 * Add defaults deliberately because generated files retain old entries.
 */
const WORKSPACE_RUNTIME_ENTRY_RULES: readonly WorkspaceRuntimeEntryRule[] = [
  { entry: `${PATH_CONSTANTS.RUNS_DIR}/`, blockWhenTracked: false },
  { entry: `${PATH_CONSTANTS.SEARCH_INDEX_DIR}/`, blockWhenTracked: false },
  { entry: `${PATH_CONSTANTS.LOGS_DIR}/`, blockWhenTracked: true },
  { entry: `${PATH_CONSTANTS.TEMP_DIR}/`, blockWhenTracked: true },
  { entry: `${PATH_CONSTANTS.CERTS_DIR}/`, blockWhenTracked: true },
  { entry: `${PATH_CONSTANTS.NOTIFICATIONS_DIR}/`, blockWhenTracked: true },
  { entry: PATH_CONSTANTS.CAPABILITIES_FILE, blockWhenTracked: false },
  { entry: `${PATH_CONSTANTS.ATTACHMENTS_DIR}/`, blockWhenTracked: false },
  { entry: `${PATH_CONSTANTS.PROMPTS_DIR}/`, blockWhenTracked: false },
  { entry: `${PATH_CONSTANTS.USAGE_DIR}/`, blockWhenTracked: false },
];

export const WORKSPACE_INITIALIZER_RUNTIME_ENTRIES =
  WORKSPACE_RUNTIME_ENTRY_RULES.map(({ entry }) => entry);

const WORKSPACE_INITIALIZER_UNSAFE_ENTRIES =
  WORKSPACE_RUNTIME_ENTRY_RULES.filter(
    ({ blockWhenTracked }) => blockWhenTracked
  ).map(({ entry }) => entry);

const GITIGNORE_ENTRIES = WORKSPACE_INITIALIZER_RUNTIME_ENTRIES;

const GITIGNORE_SELF_ENTRY = ".gitignore";

const GITIGNORE_CONTENT = [
  GITIGNORE_HEADER,
  ...GITIGNORE_ENTRIES,
  GITIGNORE_SELF_ENTRY,
  "",
].join("\n");

/**
 * Return true for a repository-relative path inside a generated runtime entry
 * rooted at the repository-relative execution workspace.
 */
export function isWorkspaceInitializerRuntimePath(
  repositoryRelativePath: string,
  workspaceRelativeRoot = ""
): boolean {
  return isWorkspaceInitializerEntryPath(
    repositoryRelativePath,
    workspaceRelativeRoot,
    WORKSPACE_INITIALIZER_RUNTIME_ENTRIES
  );
}

/** Return true for a path that managed landing must reject even when tracked. */
export function isWorkspaceInitializerUnsafePath(
  repositoryRelativePath: string,
  workspaceRelativeRoot = ""
): boolean {
  return isWorkspaceInitializerEntryPath(
    repositoryRelativePath,
    workspaceRelativeRoot,
    WORKSPACE_INITIALIZER_UNSAFE_ENTRIES
  );
}

function isWorkspaceInitializerEntryPath(
  repositoryRelativePath: string,
  workspaceRelativeRoot: string,
  entries: readonly string[]
): boolean {
  const normalized = repositoryRelativePath.replace(/\\/g, "/");
  const normalizedWorkspaceRoot = workspaceRelativeRoot
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
  const ctrlyokePrefix = normalizedWorkspaceRoot
    ? `${normalizedWorkspaceRoot}/${PATH_CONSTANTS.CTRLYOKE_DIR}/`
    : `${PATH_CONSTANTS.CTRLYOKE_DIR}/`;
  if (!normalized.startsWith(ctrlyokePrefix)) return false;
  const ctrlyokeRelative = normalized.slice(ctrlyokePrefix.length);
  return entries.some((entry) => {
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
        `[WorkspaceInitializer] ctrlyoke: Initialized .ctrlyoke workspace directory at ${ctrlyokeDir}`
      );
    }

    return isNew;
  }

  /**
   * For hosts where launching ctrlyoke is itself the opt-in (`ctrlyoke run`
   * and `ctrlyoke server`): initialize without asking, then log into the
   * workspace. CLI logging is switched on first so the initializer's own log
   * line never reaches stdout (which `--json` owns), and again once a new
   * `.ctrlyoke/` exists so the log file opens inside it.
   */
  static async initializeForCli(
    workspaceRoot: string,
    verbose: boolean
  ): Promise<void> {
    Log.initializeCli(workspaceRoot, verbose);
    if (await WorkspaceInitializer.initializeIfNeeded(workspaceRoot)) {
      Log.initializeCli(workspaceRoot, verbose);
    }
  }

  /**
   * Re-initialize workspace: ensures `.ctrlyoke/` and its .gitignore exist and
   * that a generated .gitignore lists every generated entry. A .gitignore
   * without the generated self-ignore entry is user-owned and left untouched.
   */
  static async reinitialize(workspaceRoot: string): Promise<void> {
    await WorkspaceInitializer.initializeIfNeeded(workspaceRoot);
    Log.info("[WorkspaceInitializer] ctrlyoke: Workspace re-initialized");
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
    if (!currentEntries.has(GITIGNORE_SELF_ENTRY)) {
      return;
    }

    const missingEntries = GITIGNORE_ENTRIES.filter(
      (entry) => !currentEntries.has(entry)
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
