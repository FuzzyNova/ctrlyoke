import { spawn } from "child_process";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const STDERR_TAIL_MAX_BYTES = 8 * 1024;

interface GitMutationProcess {
  stderr: {
    on(event: "data", listener: (chunk: Buffer | string) => void): void;
  };
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (code: number | null) => void): this;
}

export interface GitCommitterOptions {
  spawnProcess?: (
    command: string,
    args: string[],
    options: { cwd: string; stdio: ["ignore", "ignore", "pipe"] }
  ) => GitMutationProcess;
}

function defaultSpawnProcess(
  command: string,
  args: string[],
  options: { cwd: string; stdio: ["ignore", "ignore", "pipe"] }
): GitMutationProcess {
  return spawn(command, args, options) as GitMutationProcess;
}

function runGitMutation(
  spawnProcess: NonNullable<GitCommitterOptions["spawnProcess"]>,
  args: string[],
  cwd: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess("git", args, {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderrTail = Buffer.alloc(0);
    child.stderr.on("data", (chunk) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrTail = Buffer.concat([stderrTail, data]).subarray(
        -STDERR_TAIL_MAX_BYTES
      );
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderrTail.toString("utf8").trim();
      reject(
        new Error(
          `git ${args[0]} failed with exit code ${code ?? "unknown"}${detail ? `: ${detail}` : ""}`
        )
      );
    });
  });
}

export interface CommitOptions {
  addAll?: boolean;
}

export class GitCommitter {
  private readonly spawnProcess: NonNullable<
    GitCommitterOptions["spawnProcess"]
  >;

  constructor(options: GitCommitterOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
  }

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
      await runGitMutation(this.spawnProcess, ["add", "-A"], stdout.trim());
    }
    await runGitMutation(this.spawnProcess, ["commit", "-m", message], cwd);
  }
}
