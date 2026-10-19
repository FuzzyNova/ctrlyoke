import { spawnSync } from "node:child_process";

const IS_WINDOWS = process.platform === "win32";

/**
 * Runs a command to completion with inherited stdio; throws on a non-zero
 * exit. `env` adds to this process's environment.
 */
export function run(
  command: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>
): void {
  // npm and npx are .cmd shims on Windows, which spawn only runs through a shell.
  const shell = IS_WINDOWS && (command === "npm" || command === "npx");
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell,
    env: env ? { ...process.env, ...env } : undefined,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with code ${result.status}`
    );
  }
}

/** Runs git and returns its trimmed stdout; throws on a non-zero exit. */
export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}
