import { spawn } from "child_process";
import kill from "tree-kill";
import {
  ErrorCodes,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import type { CliResolvedCommand } from "../shared/CliLauncherResolver";
import { resolveCliCommand } from "../shared/CliLauncherResolver";
import {
  HARNESS_USAGE_STATUS_CODES,
} from "../../../types/DashboardConstants";
import type { HarnessQuotaSnapshot } from "../../../types/UsageTypes";
import { Log } from "../../../utils/Log";
import {
  COPILOT_QUOTA_STATUS_CODES,
  normalizeCopilotAccountQuota,
} from "./CopilotUsageNormalization";

export const COPILOT_QUOTA_PROBE_TIMEOUT_MS = 5_000;

const COPILOT_SERVER_ARGS = [
  "--headless",
  "--no-auto-update",
  "--log-level",
  "error",
  "--stdio",
] as const;

const COPILOT_RPC_METHODS = {
  CONNECT: "connect",
  PING: "ping",
  GET_QUOTA: "account.getQuota",
  SHUTDOWN: "runtime.shutdown",
} as const;

const STDERR_BUFFER_LIMIT = 4 * 1024;
const TEARDOWN_GRACE_PERIOD_MS = 250;

export interface CopilotQuotaProbeResult {
  quota?: HarnessQuotaSnapshot;
  errorCode?: string;
}

export interface CopilotQuotaReader {
  readQuota(signal?: AbortSignal): Promise<CopilotQuotaProbeResult>;
}

export interface CopilotQuotaProcess {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  pid?: number;
  on(
    event: "error" | "close",
    listener: (...args: unknown[]) => void
  ): this;
  once(
    event: "error" | "close",
    listener: (...args: unknown[]) => void
  ): this;
  removeListener(
    event: "error" | "close",
    listener: (...args: unknown[]) => void
  ): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface CopilotQuotaSpawnOptions {
  stdio: ["pipe", "pipe", "pipe"];
  windowsHide: true;
  windowsVerbatimArguments?: boolean;
}

export interface CopilotQuotaClientOptions {
  resolveCliCommand?: (
    commandName: string,
    args: string[]
  ) => Promise<CliResolvedCommand>;
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: CopilotQuotaSpawnOptions
  ) => CopilotQuotaProcess;
  killProcessTree?: (pid: number, signal: NodeJS.Signals) => void;
  timeoutMs?: number;
  now?: () => number;
  teardownGracePeriodMs?: number;
}

interface ProbeResources {
  process?: CopilotQuotaProcess;
  connection?: MessageConnection;
  processClosed: boolean;
  probeFinished: boolean;
  processErrorListener?: (...args: unknown[]) => void;
  processCloseListener?: (...args: unknown[]) => void;
  stderrListener?: (...args: unknown[]) => void;
  stderrBuffer?: string;
  connectionErrorDisposable?: { dispose(): void };
}

class CopilotProbeError extends Error {
  constructor(readonly errorCode: string) {
    super(errorCode);
    this.name = "CopilotProbeError";
  }
}

class CopilotProbeTimeoutError extends CopilotProbeError {
  constructor() {
    super(COPILOT_QUOTA_STATUS_CODES.TIMEOUT);
  }
}

class CopilotProbeAbortError extends CopilotProbeError {
  constructor() {
    super(COPILOT_QUOTA_STATUS_CODES.PROBE_FAILED);
  }
}

function defaultSpawnProcess(
  command: string,
  args: readonly string[],
  options: CopilotQuotaSpawnOptions
): CopilotQuotaProcess {
  return spawn(command, [...args], options) as unknown as CopilotQuotaProcess;
}

function defaultKillProcessTree(pid: number, signal: NodeJS.Signals): void {
  kill(pid, signal, () => undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getRpcErrorCode(error: unknown): number | undefined {
  return isRecord(error) && typeof error.code === "number"
    ? error.code
    : undefined;
}

function isAuthenticationRpcError(error: unknown): boolean {
  const message = isRecord(error) && typeof error.message === "string"
    ? error.message
    : error instanceof Error
      ? error.message
      : "";
  return /auth|log.?in|credential|unauthori[sz]ed|forbidden|\b401\b/i.test(
    message
  );
}

function isMethodNotFound(error: unknown): boolean {
  return getRpcErrorCode(error) === ErrorCodes.MethodNotFound;
}

function mapRpcError(error: unknown): string {
  if (isMethodNotFound(error)) return COPILOT_QUOTA_STATUS_CODES.UNSUPPORTED;
  if (isAuthenticationRpcError(error)) {
    return HARNESS_USAGE_STATUS_CODES.AUTH_REQUIRED;
  }
  return COPILOT_QUOTA_STATUS_CODES.PROBE_FAILED;
}

function toSafeErrorCode(error: unknown): string {
  if (error instanceof CopilotProbeError) return error.errorCode;
  return COPILOT_QUOTA_STATUS_CODES.PROBE_FAILED;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Short-lived, read-only stdio client for Copilot's account quota RPC.
 * It never creates a session or starts a model turn.
 */
export class CopilotQuotaClient implements CopilotQuotaReader {
  private readonly resolveCommand: (
    commandName: string,
    args: string[]
  ) => Promise<CliResolvedCommand>;
  private readonly spawnProcess: (
    command: string,
    args: readonly string[],
    options: CopilotQuotaSpawnOptions
  ) => CopilotQuotaProcess;
  private readonly killProcessTree: (
    pid: number,
    signal: NodeJS.Signals
  ) => void;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly teardownGracePeriodMs: number;

  constructor(options: CopilotQuotaClientOptions = {}) {
    this.resolveCommand = options.resolveCliCommand ?? resolveCliCommand;
    this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
    this.killProcessTree = options.killProcessTree ?? defaultKillProcessTree;
    this.timeoutMs = options.timeoutMs ?? COPILOT_QUOTA_PROBE_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.teardownGracePeriodMs =
      options.teardownGracePeriodMs ?? TEARDOWN_GRACE_PERIOD_MS;
  }

  async readQuota(signal?: AbortSignal): Promise<CopilotQuotaProbeResult> {
    const deadline = this.now() + this.timeoutMs;
    const resources: ProbeResources = {
      processClosed: false,
      probeFinished: false,
    };
    let rejectProcessFailure: ((error: unknown) => void) | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;

    const processFailure = new Promise<never>((_, reject) => {
      rejectProcessFailure = reject;
    });
    const interruption = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new CopilotProbeTimeoutError()),
        Math.max(0, this.timeoutMs)
      );
      const rejectAborted = () => reject(new CopilotProbeAbortError());
      abortListener = rejectAborted;
      if (signal?.aborted) {
        rejectAborted();
      } else {
        signal?.addEventListener("abort", rejectAborted, { once: true });
      }
    });

    try {
      const operation = this.performProbe(
        resources,
        processFailure,
        rejectProcessFailure,
        deadline
      );
      return await Promise.race([operation, interruption, processFailure]);
    } catch (error) {
      const errorCode = toSafeErrorCode(error);
      Log.debug(`[CopilotQuotaClient] quota probe ended: ${errorCode}`);
      return { errorCode };
    } finally {
      resources.probeFinished = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
      try {
        await this.teardown(resources, deadline);
      } catch {
        Log.debug(
          "[CopilotQuotaClient] quota probe teardown did not complete cleanly"
        );
      }
      try {
        this.removeProcessListeners(resources);
      } catch {
        Log.debug(
          "[CopilotQuotaClient] quota probe listener cleanup did not complete cleanly"
        );
      }
    }
  }

  private async performProbe(
    resources: ProbeResources,
    processFailure: Promise<never>,
    rejectProcessFailure: ((error: unknown) => void) | undefined,
    deadline: number
  ): Promise<CopilotQuotaProbeResult> {
    const resolved = await this.withDeadline(
      this.resolveCommand("copilot", [...COPILOT_SERVER_ARGS]),
      deadline
    );
    if (this.remaining(deadline) <= 0) throw new CopilotProbeTimeoutError();

    const process = this.spawnProcess(resolved.command, resolved.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(resolved.requiresShellVerbatimArgs
        ? { windowsVerbatimArguments: true }
        : {}),
    });
    resources.process = process;
    this.attachProcessListeners(resources, rejectProcessFailure);

    const reader = new StreamMessageReader(process.stdout);
    const writer = new StreamMessageWriter(process.stdin);
    const connection = createMessageConnection(reader, writer);
    resources.connection = connection;
    resources.connectionErrorDisposable = connection.onError(() => {
      rejectProcessFailure?.(
        new CopilotProbeError(COPILOT_QUOTA_STATUS_CODES.PROBE_FAILED)
      );
    });
    connection.listen();

    try {
      await this.request(
        connection,
        processFailure,
        COPILOT_RPC_METHODS.CONNECT,
        {},
        deadline
      );
    } catch (error) {
      if (error instanceof CopilotProbeError) throw error;
      if (!isMethodNotFound(error)) throw new CopilotProbeError(mapRpcError(error));
      try {
        await this.request(
          connection,
          processFailure,
          COPILOT_RPC_METHODS.PING,
          {},
          deadline
        );
      } catch (pingError) {
        if (pingError instanceof CopilotProbeError) throw pingError;
        throw new CopilotProbeError(mapRpcError(pingError));
      }
    }

    let quotaResponse: unknown;
    try {
      quotaResponse = await this.request(
        connection,
        processFailure,
        COPILOT_RPC_METHODS.GET_QUOTA,
        {},
        deadline
      );
    } catch (error) {
      if (error instanceof CopilotProbeError) throw error;
      throw new CopilotProbeError(mapRpcError(error));
    }

    const quota = normalizeCopilotAccountQuota(quotaResponse, this.now());
    if (!quota) {
      throw new CopilotProbeError(
        COPILOT_QUOTA_STATUS_CODES.MALFORMED_RESPONSE
      );
    }
    return { quota };
  }

  private attachProcessListeners(
    resources: ProbeResources,
    rejectProcessFailure: ((error: unknown) => void) | undefined
  ): void {
    const process = resources.process;
    if (!process) return;

    resources.processErrorListener = () => {
      if (!resources.processClosed) {
        rejectProcessFailure?.(
          new CopilotProbeError(COPILOT_QUOTA_STATUS_CODES.PROBE_FAILED)
        );
      }
    };
    resources.processCloseListener = () => {
      resources.processClosed = true;
      if (!resources.probeFinished) {
        rejectProcessFailure?.(
          new CopilotProbeError(COPILOT_QUOTA_STATUS_CODES.PROBE_FAILED)
        );
      }
    };
    process.once("error", resources.processErrorListener);
    process.once("close", resources.processCloseListener);
    this.captureStderr(resources);
  }

  private captureStderr(resources: ProbeResources): void {
    const process = resources.process;
    if (!process || resources.stderrListener) return;
    resources.stderrBuffer = "";
    const listener = (...args: unknown[]) => {
      const chunk = args[0];
      const text =
        typeof chunk === "string"
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString("utf8")
            : String(chunk);
      resources.stderrBuffer = `${resources.stderrBuffer}${text}`.slice(
        -STDERR_BUFFER_LIMIT
      );
    };
    process.stderr.on("data", listener);
    resources.stderrListener = listener;
  }

  private async request<R>(
    connection: MessageConnection,
    processFailure: Promise<never>,
    method: string,
    params: Record<string, never>,
    deadline: number
  ): Promise<R> {
    const request = connection.sendRequest<R>(method, params);
    return this.withDeadline(Promise.race([request, processFailure]), deadline);
  }

  private async withDeadline<T>(
    operation: Promise<T>,
    deadline: number
  ): Promise<T> {
    const remaining = this.remaining(deadline);
    if (remaining <= 0) throw new CopilotProbeTimeoutError();
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => reject(new CopilotProbeTimeoutError()), remaining);
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timerId) clearTimeout(timerId);
    }
  }

  private remaining(deadline: number): number {
    return deadline - this.now();
  }

  private async teardown(
    resources: ProbeResources,
    deadline: number
  ): Promise<void> {
    const connection = resources.connection;
    if (connection) {
      const shutdownBudget = Math.min(
        this.teardownGracePeriodMs,
        Math.max(0, this.remaining(deadline))
      );
      try {
        const shutdown = connection.sendRequest(
          COPILOT_RPC_METHODS.SHUTDOWN,
          {}
        );
        await this.withTimeout(shutdown, shutdownBudget);
      } catch {
        // The runtime may already have failed or be waiting on a broken frame.
      }
      try {
        connection.dispose();
      } catch {
        // Disposal is best effort during failure handling.
      }
    }

    const process = resources.process;
    if (!process) return;
    try {
      process.stdin.end();
    } catch {
      // The child may already have closed its input.
    }

    const gracefulBudget = Math.min(
      this.teardownGracePeriodMs,
      Math.max(0, this.remaining(deadline))
    );
    const exitedGracefully = await this.waitForClose(
      resources,
      gracefulBudget
    );
    if (exitedGracefully || resources.processClosed) return;

    this.forceTerminate(process);
    await this.waitForClose(resources, Math.max(0, this.remaining(deadline)));
  }

  private async withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
    if (timeoutMs <= 0) {
      await Promise.race([operation.catch(() => undefined), delay(0)]);
      throw new CopilotProbeTimeoutError();
    }
    return Promise.race([
      operation,
      delay(timeoutMs).then(() => {
        throw new CopilotProbeTimeoutError();
      }),
    ]);
  }

  private async waitForClose(
    resources: ProbeResources,
    timeoutMs: number
  ): Promise<boolean> {
    const process = resources.process;
    if (!process || resources.processClosed) return true;
    if (timeoutMs <= 0) return false;

    let closeListener: (() => void) | undefined;
    const closed = new Promise<boolean>((resolve) => {
      closeListener = () => resolve(true);
      process.once("close", closeListener);
    });
    try {
      return await Promise.race([closed, delay(timeoutMs).then(() => false)]);
    } finally {
      if (closeListener) process.removeListener("close", closeListener);
    }
  }

  private forceTerminate(process: CopilotQuotaProcess): void {
    if (typeof process.pid === "number") {
      try {
        this.killProcessTree(process.pid, "SIGKILL");
        return;
      } catch {
        // Fall through to the direct child kill when tree-kill cannot start.
      }
    }
    try {
      process.kill("SIGKILL");
    } catch {
      // The process may have exited between the graceful and forced paths.
    }
  }

  private removeProcessListeners(resources: ProbeResources): void {
    resources.connectionErrorDisposable?.dispose();
    resources.connectionErrorDisposable = undefined;
    const process = resources.process;
    if (!process) return;
    if (resources.processErrorListener) {
      process.removeListener("error", resources.processErrorListener);
    }
    if (resources.processCloseListener) {
      process.removeListener("close", resources.processCloseListener);
    }
    if (resources.stderrListener) {
      process.stderr.removeListener("data", resources.stderrListener);
      resources.stderrListener = undefined;
    }
  }
}
