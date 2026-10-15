import { getGitTrackedFiles } from "./GitUtils";
import { Log } from "./Log";
import {
  COMPLETION_ALL_FILES_SKIP_DIRECTORIES,
  DEFAULT_SKIP_DIRECTORIES,
  walkSearchFiles,
} from "./WorkspaceSearchFileWalker";

const MAX_COMPLETION_FILES = 100_000;
const MAX_COMPLETION_WALK_MS = 10_000;

/** List workspace files for prompt completions using the shared host policy. */
export async function listCompletionFiles(
  rootPath: string,
  options: { respectGitignore: boolean }
): Promise<string[]> {
  if (!options.respectGitignore) {
    return walkAndLog(
      rootPath,
      COMPLETION_ALL_FILES_SKIP_DIRECTORIES,
      false
    );
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
  return files;
}
