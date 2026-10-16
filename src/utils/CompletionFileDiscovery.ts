import { getGitTrackedFiles } from "./GitUtils";
import { Log } from "./Log";
import {
  DEFAULT_SKIP_DIRECTORIES,
  walkSearchFiles,
} from "./WorkspaceSearchFileWalker";

/** Return Git-visible source paths for symbol indexes, with a safe walk fallback. */
export async function getSourceFiles(rootPath: string): Promise<string[]> {
  try {
    return await getGitTrackedFiles(rootPath);
  } catch (error) {
    Log.warn(
      `[Completions] git ls-files failed for ${rootPath}, falling back to workspace walk:`,
      error
    );
    return walkAndLog(rootPath, DEFAULT_SKIP_DIRECTORIES);
  }
}

async function walkAndLog(
  rootPath: string,
  skipDirectories: ReadonlySet<string>
): Promise<string[]> {
  const { files, truncated } = await walkSearchFiles(
    rootPath,
    Date.now(),
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    skipDirectories,
    true
  );
  if (truncated) {
    Log.debug(
      `[Completions] Workspace source file walk was truncated for ${rootPath}`
    );
  }
  // Git reports forward slashes; match it so both sources dedupe and every
  // host receives one path form.
  return files.map((file) => file.replace(/\\/g, "/"));
}
