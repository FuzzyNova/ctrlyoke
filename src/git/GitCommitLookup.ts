import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Check whether a commit object is available in the given repository. */
export async function repositoryHasCommit(
  repositoryRoot: string,
  commitHash: string
): Promise<boolean> {
  try {
    await execFileAsync(
      "git",
      [
        "-C",
        repositoryRoot,
        "cat-file",
        "-e",
        "--end-of-options",
        `${commitHash}^{commit}`,
      ],
      { windowsHide: true }
    );
    return true;
  } catch {
    return false;
  }
}
