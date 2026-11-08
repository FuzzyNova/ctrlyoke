import { spawn } from "child_process";
import * as readline from "readline";
import { resolveCliCommand } from "./CliLauncherResolver";

/**
 * The slice of a child process a short-lived stdio probe uses. Tests pass a
 * fake that implements it instead of spawning the real CLI.
 */
export interface StdioProbeProcess {
  stdin: {
    write(data: string): boolean;
    end(): void;
  };
  stdout: NodeJS.ReadableStream;
  once(event: "error" | "close", listener: (...args: unknown[]) => void): this;
  removeListener(
    event: "error" | "close",
    listener: (...args: unknown[]) => void
  ): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** The probe ran out of time; retrying the same CLI will not be faster. */
export class StdioProbeTimeoutError extends Error {
  constructor(label: string) {
    super(`${label} probe timed out`);
    this.name = "StdioProbeTimeoutError";
  }
}

export type StdioProbeSpawn = (
  command: string,
  args: readonly string[],
  windowsVerbatimArguments?: boolean
) => StdioProbeProcess;

export function defaultStdioProbeSpawn(
  command: string,
  args: readonly string[],
  windowsVerbatimArguments?: boolean
): StdioProbeProcess {
  return spawn(command, [...args], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
    windowsVerbatimArguments,
  }) as unknown as StdioProbeProcess;
}

export interface StdioProbeOptions {
  /** Names the probe in error messages, e.g. "Codex app-server". */
  label: string;
  commandName: string;
  args: string[];
  timeoutMs: number;
  spawnProcess: StdioProbeSpawn;
  resolveCommand: typeof resolveCliCommand;
  signal?: AbortSignal;
}

/** A stdio session the probe body talks to: newline-delimited JSON both ways. */
export interface StdioProbeSession {
  send(message: Record<string, unknown>): void;
  /**
   * Resolve with the first stdout JSON line `select` returns a value for.
   * `select` returns `undefined` to skip a line and throws to reject.
   */
  awaitMessage<T>(select: (message: unknown) => T | undefined): Promise<T>;
}

/**
 * Spawn a harness CLI for a request/response exchange over stdio, run `body`,
 * and always tear the process down. The whole exchange is bounded by
 * `timeoutMs` and the caller's abort signal. The CLI is resolved through
 * `resolveCliCommand` so `.cmd` shims and their quoting work on Windows.
 */
export async function runStdioProbe<T>(
  options: StdioProbeOptions,
  body: (session: StdioProbeSession) => Promise<T>
): Promise<T> {
  const { label, signal } = options;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  let child: StdioProbeProcess | undefined;
  let probeSettled = false;
  const abortError = () => new Error(`${label} probe aborted`);

  const operation = (async () => {
    const resolved = await options.resolveCommand(
      options.commandName,
      options.args
    );
    if (probeSettled || signal?.aborted) throw abortError();
    child = options.spawnProcess(
      resolved.command,
      resolved.args,
      resolved.requiresShellVerbatimArgs
    );
    const input = readline.createInterface({ input: child.stdout });
    try {
      return await body(createSession(child, input, label));
    } finally {
      input.close();
    }
  })();

  const interruption = new Promise<never>((_, reject) => {
    const rejectAborted = () => reject(abortError());
    abortListener = rejectAborted;
    if (signal?.aborted) {
      rejectAborted();
      return;
    }
    signal?.addEventListener("abort", rejectAborted, { once: true });
    timeoutId = setTimeout(
      () => reject(new StdioProbeTimeoutError(label)),
      options.timeoutMs
    );
  });

  try {
    return await Promise.race([operation, interruption]);
  } finally {
    probeSettled = true;
    if (timeoutId) clearTimeout(timeoutId);
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
    teardown(child);
    // The losing branch of the race still settles later; keep that rejection
    // from surfacing as an unhandled one.
    operation.catch(() => undefined);
  }
}

function createSession(
  child: StdioProbeProcess,
  input: readline.Interface,
  label: string
): StdioProbeSession {
  const send = (message: Record<string, unknown>) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  return {
    send,
    awaitMessage<T>(select: (message: unknown) => T | undefined): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const onLine = (line: string) => {
          let message: unknown;
          try {
            message = JSON.parse(line);
          } catch {
            return;
          }
          let selected: T | undefined;
          try {
            selected = select(message);
          } catch (error) {
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          if (selected === undefined) return;
          cleanup();
          resolve(selected);
        };
        const onError = () => {
          cleanup();
          reject(new Error(`${label} process failed`));
        };
        const onClose = () => {
          cleanup();
          reject(new Error(`${label} process closed before replying`));
        };
        const cleanup = () => {
          input.removeListener("line", onLine);
          child.removeListener("error", onError);
          child.removeListener("close", onClose);
        };
        input.on("line", onLine);
        child.once("error", onError);
        child.once("close", onClose);
      });
    },
  };
}

function teardown(child: StdioProbeProcess | undefined): void {
  if (!child) return;
  try {
    child.stdin.end();
  } catch {
    // The process may already have closed its input.
  }
  try {
    child.kill();
  } catch {
    // Teardown is best effort after a failed probe.
  }
}
