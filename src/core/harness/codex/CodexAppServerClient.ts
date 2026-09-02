import { spawn } from "child_process";
import * as readline from "readline";
import type { HarnessQuotaSnapshot } from "../../../types/UsageTypes";
import { HARNESS_USAGE_STATUS_CODES } from "../../../types/DashboardConstants";
import { normalizeCodexAppServerQuota } from "./CodexUsageNormalization";

export const CODEX_APP_SERVER_PROBE_TIMEOUT_MS = 5_000;

/** Codex app-server `account.type` value for a ChatGPT-authenticated session. */
const CODEX_ACCOUNT_TYPE_CHATGPT = "chatgpt";

export interface CodexAppServerProcess {
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

export interface CodexAppServerProbeResult {
  quota?: HarnessQuotaSnapshot;
  errorCode?: string;
}

export interface CodexAppServerClientOptions {
  spawnProcess?: (
    command: string,
    args: readonly string[]
  ) => CodexAppServerProcess;
  timeoutMs?: number;
  now?: () => number;
}

interface JsonRpcMessage {
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultSpawnProcess(
  command: string,
  args: readonly string[]
): CodexAppServerProcess {
  return spawn(command, [...args], {
    stdio: ["pipe", "pipe", "ignore"],
  }) as unknown as CodexAppServerProcess;
}

function abortError(): Error {
  return new Error("Codex app-server probe aborted");
}

/**
 * Short-lived, read-only stdio client for Codex's documented account surface.
 * It never starts a thread or turn and never retains the account response.
 */
export class CodexAppServerClient {
  private readonly spawnProcess: (
    command: string,
    args: readonly string[]
  ) => CodexAppServerProcess;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: CodexAppServerClientOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
    this.timeoutMs = options.timeoutMs ?? CODEX_APP_SERVER_PROBE_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  async readRateLimits(
    signal?: AbortSignal
  ): Promise<CodexAppServerProbeResult> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    let process: CodexAppServerProcess | undefined;

    const operation = this.performProbe(() => {
      process = this.spawnProcess("codex", [
        "app-server",
        "--listen",
        "stdio://",
      ]);
      return process;
    });

    const interruption = new Promise<never>((_, reject) => {
      const rejectAborted = () => reject(abortError());
      abortListener = rejectAborted;
      if (signal?.aborted) {
        rejectAborted();
        return;
      }
      signal?.addEventListener("abort", rejectAborted, { once: true });
      timeoutId = setTimeout(
        () => reject(new Error("Codex app-server probe timed out")),
        this.timeoutMs
      );
    });

    try {
      return await Promise.race([operation, interruption]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
      this.teardown(process);
    }
  }

  private async performProbe(
    createProcess: () => CodexAppServerProcess
  ): Promise<CodexAppServerProbeResult> {
    const process = createProcess();
    const input = readline.createInterface({ input: process.stdout });
    try {
      await this.request(process, input, 1, "initialize", {
        clientInfo: {
          name: "ctrlyoke",
          title: "ctrlyoke harness usage",
          version: "0.1.0",
        },
      });
      this.send(process, { method: "initialized", params: {} });

      // Read only the auth mode discriminator. Any account identity returned
      // by this sibling method is deliberately discarded.
      const accountResult = await this.request(
        process,
        input,
        2,
        "account/read",
        {
          refreshToken: false,
        }
      );
      const authErrorCode = this.getAuthErrorCode(accountResult);
      if (authErrorCode) {
        return { errorCode: authErrorCode };
      }

      const rateLimitResult = await this.request(
        process,
        input,
        3,
        "account/rateLimits/read",
        undefined
      );
      const quota = normalizeCodexAppServerQuota(rateLimitResult, this.now());
      return quota ? { quota } : {};
    } finally {
      input.close();
    }
  }

  private getAuthErrorCode(accountResult: unknown): string | undefined {
    if (!isRecord(accountResult)) return undefined;
    const account = isRecord(accountResult.account)
      ? accountResult.account
      : undefined;
    const accountType =
      typeof account?.type === "string" ? account.type : undefined;
    if (accountType && accountType !== CODEX_ACCOUNT_TYPE_CHATGPT) {
      return HARNESS_USAGE_STATUS_CODES.UNSUPPORTED_AUTH_MODE;
    }
    return accountResult.requiresOpenaiAuth === true &&
      accountType !== CODEX_ACCOUNT_TYPE_CHATGPT
      ? HARNESS_USAGE_STATUS_CODES.AUTH_REQUIRED
      : undefined;
  }

  private send(
    process: CodexAppServerProcess,
    message: Record<string, unknown>
  ): void {
    process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request(
    process: CodexAppServerProcess,
    input: readline.Interface,
    id: number,
    method: string,
    params: Record<string, unknown> | undefined
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const onLine = (line: string) => {
        let message: JsonRpcMessage;
        try {
          message = JSON.parse(line) as JsonRpcMessage;
        } catch {
          return;
        }
        if (message.id !== id) return;
        cleanup();
        if (message.error !== undefined) {
          reject(new Error(`Codex app-server rejected ${method}`));
        } else {
          resolve(message.result);
        }
      };
      const onError = () => {
        cleanup();
        reject(new Error("Codex app-server process failed"));
      };
      const onClose = () => {
        cleanup();
        reject(new Error("Codex app-server process closed before replying"));
      };
      const cleanup = () => {
        input.removeListener("line", onLine);
        process.removeListener("error", onError);
        process.removeListener("close", onClose);
      };

      input.on("line", onLine);
      process.once("error", onError);
      process.once("close", onClose);
      try {
        this.send(process, { id, method, ...(params ? { params } : {}) });
      } catch {
        cleanup();
        reject(new Error(`Codex app-server request failed: ${method}`));
      }
    });
  }

  private teardown(process: CodexAppServerProcess | undefined): void {
    if (!process) return;
    try {
      process.stdin.end();
    } catch {
      // The process may already have closed its input.
    }
    try {
      process.kill();
    } catch {
      // Teardown is best effort after a failed capability probe.
    }
  }
}
