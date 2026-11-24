/**
 * SearchPathRefresh — picks up PATH directories added after this process
 * started.
 *
 * A process reads PATH once, at launch. A harness installer that creates a new
 * directory (agy's and Claude Code's `~/.local/bin`, for example) and adds it
 * to the user's shell profile or Windows user `Path` is invisible to an
 * already-running VS Code: every `<cli> --version` probe and every harness
 * spawn inherits the stale PATH and fails with ENOENT, however often detection
 * is retried. Before a retry, this reads PATH the way a new terminal would —
 * the login shell on macOS/Linux, the Machine + User registry values on
 * Windows — and prepends the directories the current process lacks. Entries
 * already present keep their order, so nothing that resolved before resolves
 * differently now.
 *
 * Node-only: no `vscode` import, so the CLI and MCP bundles can use it.
 */

import { spawn } from "child_process";
import { Log } from "./Log";
import { findPathKey } from "./CtrlyokeCliPath";
import { foldPathForCompare } from "./PathCasing";
import { getErrorMessage } from "./ErrorUtils";

/**
 * PATH directories that `scripts/dev-host.mjs --no-harnesses` hid from this
 * host, joined with the platform delimiter. They are never re-added, so the
 * simulated "no CLI installed" machine survives a retry.
 */
export const DEV_HIDDEN_PATH_ENTRIES_ENV = "CTRLYOKE_DEV_HIDDEN_PATH_ENTRIES";

/** A login shell that sources a slow profile still answers well within this. */
const SEARCH_PATH_READ_TIMEOUT_MS = 10_000;

const ENV_START_MARKER = "__CTRLYOKE_ENV_START__";
const ENV_END_MARKER = "__CTRLYOKE_ENV_END__";

/** Reads the PATH a newly opened terminal would get, or undefined. */
export type SearchPathReader = () => Promise<string | undefined>;

function delimiterFor(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

/** Run a command and collect stdout; resolves undefined on any failure. */
function readCommandOutput(
  command: string,
  args: string[],
  options: { detached: boolean }
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        // Detached: an interactive shell without a controlling terminal must
        // not try to take over (or wait on) VS Code's own terminal.
        detached: options.detached,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch (error) {
      Log.debug(
        `[SearchPathRefresh] could not start ${command}: ${getErrorMessage(error)}`
      );
      finish(undefined);
      return;
    }
    const timer = setTimeout(() => {
      Log.debug(
        `[SearchPathRefresh] ${command} did not answer within ${SEARCH_PATH_READ_TIMEOUT_MS}ms`
      );
      child.kill();
      finish(undefined);
    }, SEARCH_PATH_READ_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", (error) => {
      Log.debug(
        `[SearchPathRefresh] ${command} failed: ${getErrorMessage(error)}`
      );
      finish(undefined);
    });
    child.on("close", () => finish(stdout));
  });
}

/**
 * The PATH line of `env` output printed between the markers. Profile scripts
 * may print banners of their own; only the marked block is trusted.
 */
export function parseMarkedEnvPath(output: string): string | undefined {
  const start = output.lastIndexOf(ENV_START_MARKER);
  const end = output.lastIndexOf(ENV_END_MARKER);
  if (start < 0 || end < start) {
    return undefined;
  }
  const block = output.slice(start + ENV_START_MARKER.length, end);
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("PATH=")) {
      return line.slice("PATH=".length);
    }
  }
  return undefined;
}

/** PATH as a new login shell sees it (macOS, Linux). */
async function readLoginShellPath(): Promise<string | undefined> {
  const shell =
    process.env.SHELL ||
    (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  // `env` instead of `echo $PATH`: fish keeps PATH as a list and would print
  // it space-separated; `env` always prints the exported, colon-joined value.
  const script = `echo ${ENV_START_MARKER}; env; echo ${ENV_END_MARKER}`;
  const output = await readCommandOutput(shell, ["-ilc", script], {
    detached: true,
  });
  return output === undefined ? undefined : parseMarkedEnvPath(output);
}

/** Machine + User `Path` from the registry, as a new process would get it. */
async function readWindowsRegistryPath(): Promise<string | undefined> {
  const output = await readCommandOutput(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Environment]::GetEnvironmentVariable('Path','Machine'); [Environment]::GetEnvironmentVariable('Path','User')",
    ],
    { detached: false }
  );
  if (output === undefined) {
    return undefined;
  }
  const value = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(";");
  return value || undefined;
}

export const readFreshSearchPath: SearchPathReader = () =>
  process.platform === "win32"
    ? readWindowsRegistryPath()
    : readLoginShellPath();

/**
 * Entries of `freshPath` that `currentPath` lacks, in `freshPath` order,
 * minus `hiddenEntries`. Comparison folds case on Windows.
 */
export function findNewSearchPathEntries(
  currentPath: string,
  freshPath: string,
  hiddenEntries: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  const delimiter = delimiterFor(platform);
  const fold = (entry: string) => foldPathForCompare(entry, platform);
  const split = (value: string) =>
    value.split(delimiter).filter((entry) => entry.length > 0);
  const known = new Set([
    ...split(currentPath).map(fold),
    ...split(hiddenEntries).map(fold),
  ]);
  const added: string[] = [];
  for (const entry of split(freshPath)) {
    const key = fold(entry);
    if (!known.has(key)) {
      known.add(key);
      added.push(entry);
    }
  }
  return added;
}

/**
 * Prepend PATH directories added since this process started to
 * `process.env`, so every later spawn (version probes, harness PTYs, hooks)
 * finds a CLI installed after launch. Returns the directories it added.
 * Never throws: a shell that fails to answer leaves PATH unchanged.
 */
export async function refreshProcessSearchPath(
  reader: SearchPathReader = readFreshSearchPath,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<string[]> {
  let freshPath: string | undefined;
  try {
    freshPath = await reader();
  } catch (error) {
    Log.debug(
      `[SearchPathRefresh] reading PATH failed: ${getErrorMessage(error)}`
    );
    return [];
  }
  if (!freshPath) {
    return [];
  }
  const pathKey = findPathKey(env);
  const currentPath = env[pathKey] ?? "";
  const added = findNewSearchPathEntries(
    currentPath,
    freshPath,
    env[DEV_HIDDEN_PATH_ENTRIES_ENV] ?? "",
    platform
  );
  if (added.length === 0) {
    return [];
  }
  env[pathKey] = [...added, ...(currentPath ? [currentPath] : [])].join(
    delimiterFor(platform)
  );
  Log.info(
    `[SearchPathRefresh] added PATH entries created since launch: ${added.join(", ")}`
  );
  return added;
}
