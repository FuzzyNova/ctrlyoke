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
      const { stdout } = await execFileAsync(
        "git",
        ["rev-parse", "--show-toplevel"],
        { cwd, encoding: "utf8" }
      );
      await execFileAsync("git", ["add", "-A"], { cwd: stdout.trim() });
    }
    await execFileAsync("git", ["commit", "-m", message], { cwd });
  }
}
