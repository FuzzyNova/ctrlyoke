import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface CommitOptions {
  addAll?: boolean;
}

export class GitCommitter {
  async commit(
    message: string,
    cwd: string,
    options?: CommitOptions
  ): Promise<void> {
    if (options?.addAll) {
      await execFileAsync("git", ["add", "."], { cwd });
    }
    await execFileAsync("git", ["commit", "-m", message], { cwd });
  }
}
