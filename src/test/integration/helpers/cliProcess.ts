import { execFile } from "child_process";
import * as path from "path";

export interface CliRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs the compiled `out/cli.js` as a real child process and resolves with its
 * exit code and captured output (never rejects).
 *
 * `FORCE_COLOR: "0"` is pinned because the child inherits the environment, and
 * `npm` (and `scripts/run-test-suites.mjs`) export `FORCE_COLOR=1` whenever the
 * developer's terminal is a TTY — so without it the CLI colours its output
 * exactly when `npm test` is run interactively, and text assertions like
 * `/Harness: opencode-cli \(…\)/` fail on the embedded ANSI codes. A caller
 * that genuinely needs colour can override it through `env`.
 */
export function runCli(
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv
): Promise<CliRunResult> {
  const cliPath = path.join(__dirname, "..", "..", "..", "cli.js");
  return new Promise((resolve) => {
    execFile(
      "node",
      [cliPath, ...args],
      {
        cwd,
        env: { ...process.env, FORCE_COLOR: "0", ...env },
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          stdout,
          stderr,
        });
      }
    );
  });
}
