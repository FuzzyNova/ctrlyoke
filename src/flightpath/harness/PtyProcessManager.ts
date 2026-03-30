import { execSync } from "child_process";
import type { IPty } from "node-pty";
import { Log } from "../../utils/Log";

type NodePtyModule = typeof import("node-pty");

// ---------------------------------------------------------------------------
// Windows shell resolution
// ---------------------------------------------------------------------------

let _windowsShell: string | undefined;

/**
 * Return the best available PowerShell on Windows.
 * Prefers `pwsh.exe` (PowerShell 7+, full path via where.exe) and falls back
 * to `powershell.exe` (5.1, always in System32 — resolvable by name).
 * Result is cached — the subprocess runs at most once per extension lifetime.
 *
 * We use `where.exe` to get a full path because node-pty calls CreateProcess
 * directly (no shell), so bare names like "pwsh" are not resolved unless they
 * are in a directory that is on the process PATH — and PowerShell 7 often is
 * not. `powershell.exe` is safe as a bare name because System32 is always on PATH.
 */
export function resolveWindowsShell(): string {
  if (_windowsShell !== undefined) {
    return _windowsShell;
  }
  try {
    const result = execSync("where.exe pwsh.exe", { encoding: "utf8", timeout: 3000 });
    const fullPath = result.trim().split(/\r?\n/)[0]?.trim();
    _windowsShell = fullPath || "powershell.exe";
  } catch {
    _windowsShell = "powershell.exe";
  }
  Log.debug(`🐚 Windows shell resolved: ${_windowsShell}`);
  return _windowsShell;
}

/**
 * Extract a human-readable shell name from a full executable path.
 * e.g. "C:\Program Files\PowerShell\7\pwsh.exe" → "pwsh"
 *      "/bin/bash" → "bash"
 */
function shellDisplayName(shellPath: string): string {
  const base = shellPath.split(/[/\\]/).pop() ?? shellPath;
  return base.replace(/\.exe$/i, "");
}

/** Lazy-load node-pty at spawn time; returns null if native binary is unavailable. */
function loadNodePty(): NodePtyModule | null {
  try {
    return require("node-pty") as NodePtyModule;
  } catch {
    return null;
  }
}

export type SessionKind = "ai-cli" | "shell";

const DEFAULT_COLS = 220;
const DEFAULT_ROWS = 50;
const RECONNECT_BUFFER_MAX = 50_000; // bytes

/**
 * A single node-pty session (AI CLI or user shell).
 */
export class PtySession {
  readonly id: string;
  readonly workflowId: string;
  readonly stepName: string;
  readonly kind: SessionKind;
  readonly promptNumber?: number;
  readonly pty: IPty;
  status: "running" | "completed" | "failed";

  // Ring buffer for webview reconnection: recent output replayed when webview JS context is recreated
  readonly reconnectBuffer: string[] = [];
  private reconnectBufferSize = 0;

  constructor(
    id: string,
    workflowId: string,
    stepName: string,
    kind: SessionKind,
    ptyInstance: IPty,
    promptNumber?: number
  ) {
    this.id = id;
    this.workflowId = workflowId;
    this.stepName = stepName;
    this.kind = kind;
    this.promptNumber = promptNumber;
    this.pty = ptyInstance;
    this.status = "running";
  }

  /**
   * Buffer a chunk for webview reconnection.
   * Drops oldest chunks when buffer exceeds RECONNECT_BUFFER_MAX bytes.
   */
  bufferChunk(chunk: string): void {
    this.reconnectBuffer.push(chunk);
    this.reconnectBufferSize += chunk.length;
    while (this.reconnectBufferSize > RECONNECT_BUFFER_MAX) {
      const dropped = this.reconnectBuffer.shift()!;
      this.reconnectBufferSize -= dropped.length;
    }
  }

  /**
   * Clear the reconnect buffer (called after flushing to a freshly-connected webview).
   */
  clearReconnectBuffer(): void {
    this.reconnectBuffer.length = 0;
    this.reconnectBufferSize = 0;
  }
}

export interface SpawnPtyOptions {
  workflowId: string;
  stepName: string;
  kind: SessionKind;
  promptNumber?: number;
  /**
   * Pre-supply a session ID so the caller can post TERMINAL_STARTED to the
   * webview *before* spawning — ensuring the session exists in the store
   * before any TERMINAL_OUTPUT messages arrive.
   */
  sessionId?: string;
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Called for every chunk of PTY output */
  onData: (session: PtySession, chunk: string) => void;
  /** Called when the PTY process exits */
  onExit: (session: PtySession, exitCode: number) => void;
}

/**
 * Manages node-pty sessions for embedded terminal support.
 *
 * Implements vscode.Disposable so it can be registered with context.subscriptions
 * and all PTY processes are killed cleanly on extension deactivation.
 *
 * Handles:
 * - AI CLI sessions (kind: 'ai-cli'): spawned by CliIntegration for interactive mode
 * - User shell sessions (kind: 'shell'): spawned by user clicking "+" in the terminal rail
 */
export class PtyProcessManager {
  private sessions = new Map<string, PtySession>();

  /**
   * Spawn a new PTY session.
   * PTYs start at DEFAULT_COLS×DEFAULT_ROWS; the webview ResizeObserver
   * corrects dimensions immediately on mount.
   */
  spawnPty(options: SpawnPtyOptions): PtySession {
    const nodePty = loadNodePty();
    if (!nodePty) {
      throw new Error("node-pty native module is not available on this platform");
    }
    const sessionId = options.sessionId ?? `${options.kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const ptyInstance = nodePty.spawn(options.command, options.args, {
      name: "xterm-256color",
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd: options.cwd,
      env: (options.env ?? process.env) as Record<string, string>,
    });

    const session = new PtySession(
      sessionId,
      options.workflowId,
      options.stepName,
      options.kind,
      ptyInstance,
      options.promptNumber
    );

    this.sessions.set(sessionId, session);

    ptyInstance.onData((chunk: string) => {
      session.bufferChunk(chunk);
      options.onData(session, chunk);
    });

    ptyInstance.onExit(({ exitCode }: { exitCode: number }) => {
      session.status = exitCode === 0 ? "completed" : "failed";
      this.sessions.delete(sessionId);
      options.onExit(session, exitCode ?? 1);
      Log.debug(`🖥️ PTY session ${sessionId} (${options.kind}) exited with code ${exitCode}`);
    });

    Log.debug(`🖥️ Spawned PTY session ${sessionId} (${options.kind}): ${options.command}`);
    return session;
  }

  /**
   * Spawn a user shell session.
   * Uses $SHELL on Unix, cmd.exe on Windows.
   */
  spawnShell(opts: {
    workflowId: string;
    cwd: string;
    onData: (session: PtySession, chunk: string) => void;
    onExit: (session: PtySession, exitCode: number) => void;
  }): PtySession {
    const shell =
      process.env.SHELL ??
      (process.platform === "win32" ? resolveWindowsShell() : "/bin/bash");

    return this.spawnPty({
      workflowId: opts.workflowId,
      stepName: shellDisplayName(shell),
      kind: "shell",
      command: shell,
      args: [],
      cwd: opts.cwd,
      env: process.env,
      onData: opts.onData,
      onExit: opts.onExit,
    });
  }

  /**
   * Write input bytes to a PTY session (forwards keystrokes from xterm.js).
   */
  writeToSession(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.pty.write(data);
    }
  }

  /**
   * Resize a PTY session to match the xterm.js canvas dimensions.
   */
  resizeSession(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.pty.resize(cols, rows);
    }
  }

  /**
   * Kill a PTY session immediately.
   */
  killSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.pty.kill();
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Restart a shell session: kill the existing PTY and spawn a new one at the same cwd.
   * Returns the new PtySession.
   */
  restartShellSession(
    sessionId: string,
    opts: {
      onData: (session: PtySession, chunk: string) => void;
      onExit: (session: PtySession, exitCode: number) => void;
    }
  ): PtySession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.kind !== "shell") {
      return undefined;
    }

    const cwd = session.pty.process; // best-effort: use same workflowId/cwd
    const workflowId = session.workflowId;
    session.pty.kill();
    this.sessions.delete(sessionId);

    return this.spawnShell({
      workflowId,
      cwd: cwd || process.cwd(),
      onData: opts.onData,
      onExit: opts.onExit,
    });
  }

  /**
   * Get a session by ID (includes sessions that have exited but not been removed).
   */
  getSession(sessionId: string): PtySession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all sessions for a workflow.
   */
  getSessionsForWorkflow(workflowId: string): PtySession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.workflowId === workflowId
    );
  }

  /**
   * Get all active sessions across all workflows.
   */
  getAllSessions(): PtySession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Implements vscode.Disposable. Kills all PTY processes on extension deactivation.
   */
  dispose(): void {
    for (const session of this.sessions.values()) {
      try {
        session.pty.kill();
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.sessions.clear();
    Log.debug("🖥️ PtyProcessManager disposed — all PTY sessions killed");
  }
}

// ============================================================================
// Module-level singleton (initialized by extension.ts)
// ============================================================================

let _instance: PtyProcessManager | null = null;
let _postMessage: ((msg: unknown) => void) | null = null;

/**
 * Initialize the singleton PtyProcessManager. Called once from extension.ts.
 * @param postMessage Function to post messages to the webview
 */
export function initPtyProcessManager(
  postMessage: (msg: unknown) => void
): PtyProcessManager {
  _postMessage = postMessage;
  _instance = new PtyProcessManager();
  return _instance;
}

/**
 * Get the singleton PtyProcessManager. Returns null if not yet initialized.
 */
export function getPtyProcessManager(): PtyProcessManager | null {
  return _instance;
}

/**
 * Post a message to the webview from the PTY layer.
 */
export function ptyPostMessage(msg: unknown): void {
  _postMessage?.(msg);
}
