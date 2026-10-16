import { getGitTrackedFiles } from "./GitUtils";
import { Log } from "./Log";
import {
  COMPLETION_ALL_FILES_SKIP_DIRECTORIES,
  DEFAULT_SKIP_DIRECTORIES,
  walkSearchFiles,
} from "./WorkspaceSearchFileWalker";

const MAX_COMPLETION_FILES = 100_000;
const MAX_COMPLETION_WALK_MS = 10_000;

/**
 * List workspace files for prompt completions using the shared host policy.
 *
 * The order is a ranking preference: `CompletionCore` breaks fuzzy-score ties
 * by it, so Git-visible files come first and ignored files after them.
 */
export async function listCompletionFiles(
  rootPath: string,
  options: { respectGitignore: boolean }
): Promise<string[]> {
  if (!options.respectGitignore) {
    return listAllFiles(rootPath);
  }

  try {
    return await getGitTrackedFiles(rootPath);
  } catch (error) {
    Log.warn(
      `[Completions] git ls-files failed for ${rootPath}, falling back to workspace walk:`,
      error
    );
    return walkAndLog(rootPath, DEFAULT_SKIP_DIRECTORIES, true);
  }
}

/**
 * Git-visible files plus ignored ones. Only the walk is capped, so a workspace
 * whose ignored trees (`node_modules/`, downloaded VS Code builds) exceed the
 * cap still lists every tracked and untracked non-ignored file.
 */
async function listAllFiles(rootPath: string): Promise<string[]> {
  const visible = await getGitTrackedFiles(rootPath).catch(() => []);
  const walked = await walkAndLog(
    rootPath,
    COMPLETION_ALL_FILES_SKIP_DIRECTORIES,
    false
  );
  const seen = new Set(visible);
  return [...visible, ...walked.filter((file) => !seen.has(file))];
}

async function walkAndLog(
  rootPath: string,
  skipDirectories: ReadonlySet<string>,
  excludeCtrlYokeLogs: boolean
): Promise<string[]> {
  // The walker is asynchronous, but its loop yields on each directory read.
  // Keep the same start-time, file-count and duration bounds for both modes.
  const { files, truncated } = await walkSearchFiles(
    rootPath,
    Date.now(),
    MAX_COMPLETION_FILES,
    MAX_COMPLETION_WALK_MS,
    skipDirectories,
    excludeCtrlYokeLogs
  );
  if (truncated) {
    Log.debug(
      `[Completions] Workspace file walk truncated for ${rootPath} at ${files.length} files or ${MAX_COMPLETION_WALK_MS} ms`
    );
  }
  // Git reports forward slashes; match it so both sources dedupe and every
  // host receives one path form.
  return files.map((file) => file.replace(/\\/g, "/"));
}
