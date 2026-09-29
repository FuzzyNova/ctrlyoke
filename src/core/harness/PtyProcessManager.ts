import { execSync } from "child_process";
import type { IPty } from "node-pty";
import { Log } from "../../utils/Log";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { secretRedactionService } from "../../utils/SecretRedactionService";
import { canonicalizeDriveLetter } from "../../utils/PathCasing";
import { withWorkingDirectoryEnv } from "../../utils/SpawnEnvironment";
import { withCtrlyokeBinOnPath } from "../../utils/CtrlyokeCliPath";
import { logMemoryUsage } from "../../utils/MemoryDiagnostics";
import { resolveShellKind, shellDisplayName } from "../../utils/ShellCatalog";
import {
  MESSAGE_TYPES,
  SESSION_KINDS,
  SHELL_KINDS,
  TERMINAL_END_REASONS,
  TERMINAL_SESSION_STATUS,
  type SessionKind,
  type ShellKind,
  type TerminalEndReason,
  type TerminalSessionStatus,
} from "../../types/DashboardConstants";
import type { TerminalEndedMessage } from "../../types/WebviewMessageTypes";

type NodePtyModule = typeof import("node-pty");
const NODE_PTY_UNAVAILABLE_MESSAGE =
  "Embedded terminal support is unavailable because the node-pty native module could not be loaded. Reinstall ctrlyoke or switch CLI execution mode to headless.";

// ---------------------------------------------------------------------------
// Windows shell resolution
// ---------------------------------------------------------------------------

let _windowsShell: string | undefined;
let _unixShell: string | undefined;

/**
 * Return the best available shell on Unix/macOS.
 * Prefers the $SHELL environment variable, then falls back to /bin/zsh on macOS
 * (the system default since Catalina) or /bin/bash on other Unix systems.
 * Using /bin/zsh on macOS avoids "posix_spawn failed: Permission denied" errors
 * that can occur with /bin/bash under macOS's hardened runtime/SIP restrictions.
 * Result is cached after first resolution.
 */
function resolveUnixShell(): string {
  if (_unixShell !== undefined) {
    return _unixShell;
  }
  _unixShell =
    process.env.SHELL ??
    (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  Log.debug(`[PtyProcessManager] Unix shell resolved: ${_unixShell}`);
  return _unixShell;
}

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
    const result = execSync("where.exe pwsh.exe", {
      encoding: "utf8",
      timeout: 3000,
    });
    const fullPath = result.trim().split(/\r?\n/)[0]?.trim();
    _windowsShell = fullPath || "powershell.exe";
  } catch {
    _windowsShell = "powershell.exe";
  }
  Log.debug(`[PtyProcessManager] Windows shell resolved: ${_windowsShell}`);
  return _windowsShell;
}

/**
 * Makes `powershell -Command` report the script's real exit code.
 *
 * Unlike `sh -c` and `cmd /c`, PowerShell does not propagate a child process's
 * exit status: `-Command` exits 0 or 1 from `$?` alone, so `node -e
 * "process.exit(7)"` reports 1 and any multi-line script reports 1 as soon as
 * its last native command is non-zero. Exit-code end conditions cannot work
 * without this epilogue.
 *
 * The naive `; exit $LASTEXITCODE` is wrong in the other direction: a script
 * whose failure was a *cmdlet* error leaves `$LASTEXITCODE` unset, and exiting
 * on `$null` reports success for a script that visibly failed. So capture both
 * signals and prefer the native exit code when one exists.
 *
 * Note this deliberately lets a non-zero `$LASTEXITCODE` win over a trailing
 * successful cmdlet, rather than copying `sh -c`'s "status of the last command"
 * rule. For a gate, surfacing a failed native command is the safer error —
 * `npm test` followed by a `Write-Output` must not report success.
 */
const POWERSHELL_EXIT_CODE_EPILOGUE = [
  "$__ctrlyokeOk = $?",
  "if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }",
  "if (-not $__ctrlyokeOk) { exit 1 }",
  "exit 0",
].join("\n");

/**
 * Build the argv that runs `script` as a single command line under the given
 * shell kind. Each shell has its own "run this string" flag, so the same
 * script text needs different wrapping depending on which shell resolves.
 *
 * Exported for tests: exit-code propagation is shell-specific and easy to
 * regress, and it is what end conditions compare against.
 */
export function buildShellWrapArgs(
  shellKind: ShellKind,
  script: string
): string[] {
  switch (shellKind) {
    case SHELL_KINDS.PWSH:
    case SHELL_KINDS.POWERSHELL:
      // Newline, not `;` — a script ending in a comment would swallow the
      // epilogue on the same line.
      return [
        "-NoProfile",
        "-Command",
        `${script}\n${POWERSHELL_EXIT_CODE_EPILOGUE}`,
      ];
    case SHELL_KINDS.CMD:
      return ["/d", "/c", script];
    case SHELL_KINDS.WSL:
      return ["-e", "bash", "-lc", script];
    default:
      // bash/zsh/sh/fish/nu, and anything unrecognized — universal POSIX -c.
      return ["-c", script];
  }
}

/**
 * Whether the resolved argv must be handed to Windows verbatim.
 *
 * `cmd.exe` does not understand the `\"` escaping Node applies when it builds a
 * command line from an args array, so a quoted inline script reaches it
 * mangled — `cmd /d /c 'node -e "process.exit(7)"'` silently exits 0. Node's
 * own `shell: true` sets this flag for exactly this reason; resolving the shell
 * ourselves means setting it ourselves. Every other shell here accepts Node's
 * standard quoting, and WSL/POSIX argv would be corrupted by verbatim joining.
 */
export function shellNeedsVerbatimArguments(shellKind: ShellKind): boolean {
  return shellKind === SHELL_KINDS.CMD;
}

/**
 * Shape argv for `spawnPty`, the node-pty counterpart of
 * `child_process`'s `windowsVerbatimArguments`.
 *
 * node-pty re-quotes an `args` **array** with the MSVC escaping convention
 * (`"` becomes `\"`), which is right for anything parsing its command line the
 * way `CommandLineToArgvW` does and wrong for `cmd.exe`, which has no such
 * escape. A **string** is appended after the command untouched instead — see
 * `SpawnPtyOptions.args` and node-pty's `argsToCommandLine`. Use this wherever
 * a verbatim payload reaches a PTY, so an inline `cmd /c` script is not
 * corrupted the way the headless path was.
 */
export function toPtySpawnArgs(
  args: readonly string[],
  windowsVerbatimArguments: boolean
): string[] | string {
  return windowsVerbatimArguments ? args.join(" ") : [...args];
}

/**
 * Resolve the shell executable + wrap-args to run an arbitrary script string
 * (an interactive script step, or a headless precondition/end-condition/script
 * step's inline command). Single source for "which shell runs this text" —
 * honors the per-script override, then the user's `terminal.shellExecutable`
 * override exactly like `spawnShell()` does, falling back to the platform
 * auto-detected shell otherwise, so a script step and a manually opened
 * terminal never disagree about which shell interprets the same text.
 */
export function resolveShellInvocation(
  script: string,
  shellOverride?: string,
  platform: NodeJS.Platform = process.platform
): {
  executable: string;
  args: string[];
  shellKind: ShellKind;
  windowsVerbatimArguments: boolean;
} {
  const pinned = shellOverride?.trim();
  const terminalSettings = ConfigurationUtils.getTerminalSettings();
  const settingOverride = terminalSettings.shellExecutable.trim();
  const executable =
    pinned ||
    settingOverride ||
    (platform === "win32" ? resolveWindowsShell() : resolveUnixShell());
  const shellKind = resolveShellKind(executable);
  return {
    executable,
    args: buildShellWrapArgs(shellKind, script),
    shellKind,
    windowsVerbatimArguments: shellNeedsVerbatimArguments(shellKind),
  };
}

/**
 * Whether command text contains characters that can make a shell interpret
 * later tokens as operators, substitutions, or expansions. Keep this beside
 * shell resolution so headless and interactive script paths share the same
 * definition of shell syntax.
 *
 * This is intentionally conservative: quoted metacharacters also select the
 * shell path, which preserves the original command text and its quoting rules.
 */
export function containsShellSyntax(command: string): boolean {
  return /[&|;<>$`*?()[\]{}~%!^]/.test(command);
}

let _nodePtyModule: NodePtyModule | null | undefined;
let _nodePtyLoadError: unknown;

/** Lazy-load node-pty at spawn time; returns null if native binary is unavailable. */
function loadNodePty(): NodePtyModule | null {
  if (_nodePtyModule !== undefined) {
    return _nodePtyModule;
  }

  try {
    _nodePtyModule = require("node-pty") as NodePtyModule;
  } catch (error) {
    _nodePtyLoadError = error;
    _nodePtyModule = null;
    Log.warn(NODE_PTY_UNAVAILABLE_MESSAGE, error);
  }

  return _nodePtyModule;
}

function createNodePtyUnavailableError(): Error {
  const details =
    _nodePtyLoadError instanceof Error ? ` ${_nodePtyLoadError.message}` : "";
  return new Error(`${NODE_PTY_UNAVAILABLE_MESSAGE}${details}`);
}

function tryLoadNodePty(): NodePtyModule {
  const nodePty = loadNodePty();
  if (!nodePty) {
    throw createNodePtyUnavailableError();
  }
  return nodePty;
}

export type { SessionKind, ShellKind };

/**
 * Persistence backend for the remembered terminal spawn size. Implemented by the
 * extension over `context.globalState` so the last controller viewport size
 * survives restarts; the CLI binary path leaves it unset.
 */
export interface PtyDimensionsPersistence {
  loadDimensions(): { cols: number; rows: number } | undefined;
  saveDimensions(dims: { cols: number; rows: number }): void;
}

const DEFAULT_COLS = 220;
const DEFAULT_ROWS = 50;

/**
 * Status of an exited PTY. A recorded end reason means ctrlyoke ended the
 * process itself, so the exit code — nonzero for a killed or Ctrl+C'd CLI — is
 * not evidence of failure; only a timeout still counts as one.
 */
export function resolveEndedTerminalStatus(
  exitCode: number,
  endReason: TerminalEndReason | undefined
): TerminalSessionStatus {
  if (endReason === TERMINAL_END_REASONS.TIMED_OUT) {
    return TERMINAL_SESSION_STATUS.FAILED;
  }
  if (endReason) {
    return TERMINAL_SESSION_STATUS.STOPPED;
  }
  return exitCode === 0
    ? TERMINAL_SESSION_STATUS.COMPLETED
    : TERMINAL_SESSION_STATUS.FAILED;
}

/** Single builder for every TERMINAL_ENDED payload, including spawn failures. */
export function buildTerminalEndedMessage(
  session: Pick<PtySession, "workflowId" | "id" | "kind" | "status"> &
    Partial<Pick<PtySession, "endReason">>,
  exitCode: number
): TerminalEndedMessage {
  return {
    type: MESSAGE_TYPES.TERMINAL_ENDED,
    workflowId: session.workflowId,
    sessionId: session.id,
    kind: session.kind,
    exitCode,
    status: session.status,
    ...(session.endReason ? { endReason: session.endReason } : {}),
  };
}

/**
 * A single node-pty session (AI CLI or user shell).
 */
export class PtySession {
  readonly id: string;
  readonly workflowId: string;
  stepName: string;
  stepIndex: number;
  readonly kind: SessionKind;
  promptNumber?: number;
  /** HarnessId for AI CLI sessions (e.g. "claude-cli"). Undefined for shell sessions. */
  readonly harnessId?: string;
  /** Parallel group identity used to keep sibling terminal tabs separate. */
  parallelGroupId?: string;
  /** Shell variant for SHELL sessions. Undefined for ai-cli sessions. */
  readonly shellKind?: ShellKind;
  readonly pty: IPty;
  status: TerminalSessionStatus;
  /**
   * Why ctrlyoke is ending this session, recorded before the kill is issued.
   * Undefined means the process is exiting on its own. See `markEnding`.
   */
  endReason?: TerminalEndReason;
  /** The clientId that owns interactive control of this session (input + resize). */
  controllerClientId: string | undefined;
  /**
   * Wall-clock time the PTY was spawned. Used only for diagnostics: the first
   * corrective resize from the webview arrives some ms after spawn, and any
   * harness output emitted in that gap was rendered at the DEFAULT_COLS width,
   * not the real xterm width. Logging elapsed-since-spawn on each resize makes
   * that first-render line-wrap race visible.
   */
  readonly spawnedAt = Date.now();
  /** Most recent dimensions we told the PTY (SIGWINCH), for resize diff logging. */
  lastReportedCols = DEFAULT_COLS;
  lastReportedRows = DEFAULT_ROWS;

  // Ring buffer for webview reconnection: recent output replayed when webview JS context is recreated
  readonly reconnectBuffer: string[] = [];
  private reconnectBufferSize = 0;
  private readonly reconnectBufferMaxBytes: number;

  constructor(
    id: string,
    workflowId: string,
    stepName: string,
    stepIndex: number,
    kind: SessionKind,
    ptyInstance: IPty,
    promptNumber?: number,
    harnessId?: string,
    parallelGroupId?: string,
    shellKind?: ShellKind,
    reconnectBufferMaxBytes = 50_000
  ) {
    this.id = id;
    this.workflowId = workflowId;
    this.stepName = stepName;
    this.stepIndex = stepIndex;
    this.kind = kind;
    this.promptNumber = promptNumber;
    this.harnessId = harnessId;
    this.parallelGroupId = parallelGroupId;
    this.shellKind = shellKind;
    this.pty = ptyInstance;
    this.status = TERMINAL_SESSION_STATUS.RUNNING;
    this.reconnectBufferMaxBytes = reconnectBufferMaxBytes;
  }

  /**
   * Record that ctrlyoke is deliberately ending this session. The first reason
   * wins: once a Stop has been issued, a later end-of-run teardown reaching the
   * same process must not relabel it. Must run before any Ctrl+C is written —
   * the CLI often exits on the Ctrl+C itself, before the follow-up hard kill.
   */
  markEnding(reason: TerminalEndReason): void {
    this.endReason ??= reason;
  }

  /**
   * Buffer a chunk for webview reconnection.
   * Drops oldest chunks when buffer exceeds the configured replay size.
   */
  bufferChunk(chunk: string): void {
    this.reconnectBuffer.push(chunk);
    this.reconnectBufferSize += chunk.length;
    while (this.reconnectBufferSize > this.reconnectBufferMaxBytes) {
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
  /** Zero-based queue step index, or -1 for standalone shell sessions. */
  stepIndex: number;
  kind: SessionKind;
  promptNumber?: number;
  /** HarnessId for AI CLI sessions (e.g. "claude-cli"). Omit for shell sessions. */
  harnessId?: string;
  /** Parallel group identity for grouped queue steps. */
  parallelGroupId?: string;
  /** Shell variant for SHELL sessions. Omit for ai-cli sessions. */
  shellKind?: ShellKind;
  /**
   * Pre-supply a session ID so the caller can post TERMINAL_STARTED to the
   * webview *before* spawning — ensuring the session exists in the store
   * before any TERMINAL_OUTPUT messages arrive.
   */
  sessionId?: string;
  command: string;
  /**
   * Argv entries, or — when the launcher required a cmd.exe-escaped verbatim
   * payload (`CliResolvedCommand.requiresShellVerbatimArgs`) — a single
   * pre-escaped command-line string. node-pty's `spawn()` treats a string
   * `args` as an already-formed command line and appends it after `command`
   * without further quoting (see node-pty's `argsToCommandLine`), which is
   * exactly what a verbatim payload needs; passing it as an array would
   * re-quote (and thus corrupt) the already-escaped text.
   */
  args: string[] | string;
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
   * workflowId → clientId that should become the controller for the next PTY session
   * spawned for that workflow. Set by the WebviewMessageRouter when a client triggers
   * a run, consumed (and cleared) at spawn time.
   */
  private pendingControllers = new Map<string, string>();
  /**
   * workflowId → clientId that is the controller for the current run.
   * Persists across steps within a single run so that step 2, 3, etc. inherit
   * the same controller as step 1 without another race. Overwritten when a
   * fresh setPendingController call arrives (new run) or when a client claims
   * control via TERMINAL_CLAIM_CONTROL. Parallel sibling sessions intentionally
   * share this workflow-scoped controller in v1; arbitration remains keyed by
   * workflowId rather than introducing per-session controllers.
   */
  private workflowRunControllers = new Map<string, string>();

  /**
   * Per-client terminal viewport size, used as the *spawn* size for new PTYs.
   *
   * PTYs used to always start at DEFAULT_COLS×DEFAULT_ROWS (220×50). The webview
   * only reports the real size via TERMINAL_RESIZE once its TerminalInstance has
   * mounted — which happens *after* spawn (the first resize lands ~60ms later).
   * In that gap a harness TUI paints its startup frame at 220 cols; TUIs that do
   * not reflow already-emitted scrollback (e.g. Claude's welcome box) then show
   * badly-wrapped lines until a later SIGWINCH forces a full repaint. There is no
   * true fit/transport mismatch — the diagnostic logging confirmed xterm renders
   * and reports the same size the PTY receives — so the fix is simply to start the
   * PTY near the real width. We can't measure it at spawn time (no terminal is
   * mounted yet), so we remember each client's last controller viewport (via
   * TERMINAL_VIEWPORT_HINT) and spawn at the *controlling* client's size.
   *
   * Keyed by clientId — NOT a single global — so that with multiple connected
   * tabs (a thin phone controlling workflow A, a wide desktop controlling B) each
   * workflow spawns at its own controller's width. spawnPty resolves the
   * controller clientId first and reads only that client's entry, so a viewer's
   * or another controller's size can never leak into an unrelated spawn.
   */
  private clientSpawnDimensions = new Map<
    string,
    { cols: number; rows: number }
  >();
  /**
   * Cross-session cold-start fallback: the most recent viewport size any client
   * reported, persisted to globalState. Used when the controller clientId is
   * unknown or has no recorded viewport yet (e.g. the first run after a restart,
   * before any hint arrives). Client IDs are ephemeral per-connection, so only
   * this single size — not the per-client map — is worth persisting.
   */
  private fallbackCols = DEFAULT_COLS;
  private fallbackRows = DEFAULT_ROWS;
  private dimensionsPersistence: PtyDimensionsPersistence | undefined;

  /**
   * Wire a persistence backend (extension globalState) so the cold-start fallback
   * size survives restarts. Loads any saved size immediately. Optional — the CLI
   * binary path never calls this and simply falls back to DEFAULT_COLS×ROWS.
   */
  setDimensionsPersistence(persistence: PtyDimensionsPersistence): void {
    this.dimensionsPersistence = persistence;
    const saved = persistence.loadDimensions();
    if (saved && saved.cols > 0 && saved.rows > 0) {
      this.fallbackCols = saved.cols;
      this.fallbackRows = saved.rows;
      Log.debug(
        `[PtyProcessManager] Restored terminal spawn size ${saved.cols}x${saved.rows} from persisted state`
      );
    }
  }

  /**
   * Resolve the size a new PTY should spawn at for a given controller client:
   * that client's last reported viewport, else the persisted cold-start fallback.
   * Pass no clientId (or an unknown one) to get the fallback. For diagnostics/tests.
   */
  getSpawnDimensions(clientId?: string): { cols: number; rows: number } {
    if (clientId) {
      const dims = this.clientSpawnDimensions.get(clientId);
      if (dims) return { ...dims };
    }
    return { cols: this.fallbackCols, rows: this.fallbackRows };
  }

  /**
   * Record a client's current terminal viewport as the spawn size for future PTYs
   * it controls. Driven by TERMINAL_VIEWPORT_HINT, which the controlling webview
   * sends on every fit — including while its terminal is frozen/ended, so a drag
   * *between* runs is captured. Also refreshes the persisted cold-start fallback.
   * Both updates are change-gated so drags don't spam globalState.
   */
  setSpawnDimensions(clientId: string, cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return;
    const existing = this.clientSpawnDimensions.get(clientId);
    if (existing && existing.cols === cols && existing.rows === rows) return;
    this.clientSpawnDimensions.set(clientId, { cols, rows });
    if (cols !== this.fallbackCols || rows !== this.fallbackRows) {
      this.fallbackCols = cols;
      this.fallbackRows = rows;
      this.dimensionsPersistence?.saveDimensions({ cols, rows });
    }
  }

  /**
   * Register the client that should own the next PTY session spawned for a workflow.
   * Called before an addressed execution action starts a new terminal session,
   * and from WorkflowOrchestrator when an ephemeral prompt triggers an auto-start.
   */
  setPendingController(workflowId: string, clientId: string): void {
    this.pendingControllers.set(workflowId, clientId);
  }

  private consumePendingController(workflowId: string): string | undefined {
    const clientId = this.pendingControllers.get(workflowId);
    this.pendingControllers.delete(workflowId);
    return clientId;
  }

  /**
   * Return the clientId that will be assigned as controller for the next PTY spawn,
   * without consuming the pending override. Checks the one-shot pending override first,
   * then falls back to the persistent run controller so that step 2+ of a multi-step
   * workflow inherits the same controller as step 1.
   *
   * Called by CliTransportCoordinator before it sends TERMINAL_STARTED so that the
   * message carries the correct controllerClientId from the outset, preventing all
   * observers from racing to claim control.
   */
  getExpectedController(workflowId: string): string | undefined {
    return (
      this.pendingControllers.get(workflowId) ??
      this.workflowRunControllers.get(workflowId)
    );
  }

  /**
   * Assign a client as the controller of a session.
   * Also updates the persistent run controller so that subsequent steps in the
   * same workflow run inherit the new owner (e.g. after TERMINAL_CLAIM_CONTROL).
   * Returns the session if successfully assigned.
   */
  assignController(
    sessionId: string,
    clientId: string
  ): PtySession | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.controllerClientId = clientId;
      this.workflowRunControllers.set(session.workflowId, clientId);
    }
    return session;
  }

  /**
   * Clear the controller for all sessions owned by the given client (e.g. on disconnect).
   * Returns the affected sessions so callers can broadcast the change.
   */
  releaseControllerForClient(clientId: string): PtySession[] {
    const affected: PtySession[] = [];
    for (const session of this.sessions.values()) {
      if (session.controllerClientId === clientId) {
        session.controllerClientId = undefined;
        affected.push(session);
      }
    }
    // Drop the disconnected client's remembered viewport so the map doesn't grow
    // unbounded across reconnects. The persisted cold-start fallback is separate
    // and survives, so a reconnecting client still spawns near its last size.
    this.clientSpawnDimensions.delete(clientId);
    return affected;
  }

  /** node-pty source; a test subclass substitutes a fake. */
  protected loadNodePty(): Pick<NodePtyModule, "spawn"> {
    return tryLoadNodePty();
  }

  /**
   * Spawn a new PTY session.
   * PTYs start at the controlling client's last-known viewport size (resolved via
   * getSpawnDimensions(controllerClientId), falling back to the persisted
   * cold-start size and DEFAULT_COLS×DEFAULT_ROWS) so the harness paints its first
   * frame near the real xterm width; the webview ResizeObserver still sends an
   * authoritative resize on mount.
   */
  spawnPty(options: SpawnPtyOptions): PtySession {
    const nodePty = this.loadNodePty();
    const sessionId =
      options.sessionId ??
      `${options.kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Resolve controller FIRST so we can spawn at that client's viewport: consume
    // any one-shot pending override (set by an addressed run action or an ephemeral-prompt
    // auto-start), then fall back to the persistent run controller so that steps
    // 2+ in a multi-step workflow inherit the same owner as step 1.
    const pendingClientId = this.consumePendingController(options.workflowId);
    const controllerClientId =
      pendingClientId ?? this.workflowRunControllers.get(options.workflowId);

    const hasClientViewport =
      controllerClientId !== undefined &&
      this.clientSpawnDimensions.has(controllerClientId);
    const { cols: spawnCols, rows: spawnRows } =
      this.getSpawnDimensions(controllerClientId);
    const ptyInstance = nodePty.spawn(options.command, options.args, {
      name: "xterm-256color",
      cols: spawnCols,
      rows: spawnRows,
      // Canonical drive letter — see `PathCasing.canonicalizeDriveLetter`.
      // Interactive script steps and shell sessions inherit the same VS Code
      // sourced root (`c:\...`) that broke Vitest on the headless path.
      cwd: canonicalizeDriveLetter(options.cwd),
      env: withWorkingDirectoryEnv(
        options.env,
        canonicalizeDriveLetter(options.cwd)
      ) as Record<string, string>,
    });

    const terminalSettings = ConfigurationUtils.getTerminalSettings();
    const reconnectBufferMaxBytes = Math.max(
      0,
      terminalSettings.replayBufferKb * 1024
    );

    const session = new PtySession(
      sessionId,
      options.workflowId,
      options.stepName,
      options.stepIndex,
      options.kind,
      ptyInstance,
      options.promptNumber,
      options.harnessId,
      options.parallelGroupId,
      options.shellKind,
      reconnectBufferMaxBytes
    );
    // PtySession's lastReportedCols/Rows default to DEFAULT_COLS×ROWS; correct
    // them to the size we actually spawned at so the first resizeSession log
    // shows a truthful before→after diff.
    session.lastReportedCols = spawnCols;
    session.lastReportedRows = spawnRows;
    session.controllerClientId = controllerClientId;
    if (controllerClientId) {
      this.workflowRunControllers.set(options.workflowId, controllerClientId);
    }

    this.sessions.set(sessionId, session);
    logMemoryUsage("PTY session spawned", {
      sessionId,
      kind: options.kind,
      activeSessions: this.sessions.size,
    });

    ptyInstance.onData((chunk: string) => {
      session.bufferChunk(chunk);
      options.onData(session, chunk);
    });

    ptyInstance.onExit(({ exitCode }: { exitCode: number }) => {
      session.status = resolveEndedTerminalStatus(exitCode, session.endReason);
      this.sessions.delete(sessionId);
      logMemoryUsage("PTY session exited", {
        sessionId,
        kind: options.kind,
        activeSessions: this.sessions.size,
      });
      options.onExit(session, exitCode ?? 1);
      Log.debug(
        `[PtyProcessManager] PTY session ${sessionId} (${options.kind}) exited with code ${exitCode} ` +
          `status=${session.status} endReason=${session.endReason ?? "none"}`
      );
    });

    const sizeSource = hasClientViewport
      ? `controller ${controllerClientId?.slice(0, 12)} viewport`
      : spawnCols === DEFAULT_COLS && spawnRows === DEFAULT_ROWS
        ? "default — no viewport seen yet"
        : "cold-start fallback";
    const argsForLog = Array.isArray(options.args)
      ? options.args.map((a) => JSON.stringify(a)).join(" ")
      : options.args;
    Log.debug(
      `[PtyProcessManager] Spawned PTY session ${sessionId} (${options.kind}): ${options.command} ` +
        `${argsForLog} ` +
        `— initial size ${spawnCols}x${spawnRows} ` +
        `(${sizeSource}; harness first-render width until webview resize arrives)`
    );
    return session;
  }

  /**
   * Spawn a user shell session.
   * Uses the configured shell override when set, otherwise auto-detects.
   */
  spawnShell(opts: {
    workflowId: string;
    cwd: string;
    onData: (session: PtySession, chunk: string) => void;
    onExit: (session: PtySession, exitCode: number) => void;
  }): PtySession {
    const terminalSettings = ConfigurationUtils.getTerminalSettings();
    const shellOverride = terminalSettings.shellExecutable.trim();
    const shell =
      shellOverride ||
      (process.platform === "win32"
        ? resolveWindowsShell()
        : resolveUnixShell());

    return this.spawnPty({
      workflowId: opts.workflowId,
      stepName: shellDisplayName(shell),
      stepIndex: -1,
      kind: SESSION_KINDS.SHELL,
      shellKind: resolveShellKind(shell),
      command: shell,
      args: [],
      cwd: opts.cwd,
      env: withCtrlyokeBinOnPath(process.env),
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
      const changed =
        cols !== session.lastReportedCols || rows !== session.lastReportedRows;
      const elapsedMs = Date.now() - session.spawnedAt;
      // Log the first corrective resize (and every subsequent real change) with
      // elapsed-since-spawn so the first-render line-wrap race is diagnosable:
      // any harness output emitted before this point was wrapped at the previous
      // width, not `cols`. A large jump from DEFAULT_COLS on the first resize is
      // the tell that the harness painted its startup frame too wide.
      Log.trace(
        `[PtyProcessManager] resizeSession ${sessionId.slice(0, 8)} (${session.kind}) ` +
          `${session.lastReportedCols}x${session.lastReportedRows} ${cols}x${rows} ` +
          `${changed ? "(changed)" : "(no-op)"} +${elapsedMs}ms since spawn`
      );
      session.pty.resize(cols, rows);
      session.lastReportedCols = cols;
      session.lastReportedRows = rows;
      // Note: the *spawn* size for future PTYs is driven by TERMINAL_VIEWPORT_HINT
      // (see setSpawnDimensions), not by this live-resize path — the hint also
      // fires while a terminal is frozen, so it captures drags between runs that
      // resizeSession never sees.
    }
  }

  /**
   * Kill a PTY session immediately. `reason` is recorded so the exit reads as
   * an intentional end rather than a failure.
   */
  killSession(sessionId: string, reason: TerminalEndReason): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      Log.debug(
        `[PtyProcessManager] killSession ${sessionId.slice(0, 8)} (${session.kind}) wf=${session.workflowId.slice(0, 8)} reason=${reason}`
      );
      session.markEnding(reason);
      session.pty.kill();
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Gracefully shut down an AI CLI PTY session.
   * Sends Ctrl+C twice to let the TUI clean up, waits 500ms, then hard-kills.
   * Without the signal, AI CLIs warn about improper shutdown or block on next launch.
   */
  async gracefulKillAiCliSession(
    sessionId: string,
    reason: TerminalEndReason
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      Log.debug(
        `[PtyProcessManager] gracefulKillAiCliSession ${sessionId.slice(0, 8)} (${session.kind}) wf=${session.workflowId.slice(0, 8)} reason=${reason}`
      );
      session.markEnding(reason);
      session.pty.write("\x03");
      session.pty.write("\x03");
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
    this.killSession(sessionId, reason);
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
    if (!session || session.kind !== SESSION_KINDS.SHELL) {
      return undefined;
    }

    const cwd = session.pty.process; // best-effort: use same workflowId/cwd
    const workflowId = session.workflowId;
    session.markEnding(TERMINAL_END_REASONS.SUPERSEDED);
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
   * Distinct workflowIds that currently have at least one running PTY session.
   * Source of truth for the global "active terminal" broadcast — lets every
   * client render the dropdown terminal icon for any workflow regardless of
   * which workflow it is viewing. Exited sessions are deleted from the map on
   * exit, but we still filter by RUNNING to ignore any transient terminal state.
   */
  getWorkflowIdsWithRunningSessions(): string[] {
    const ids = new Set<string>();
    for (const session of this.sessions.values()) {
      if (session.status === TERMINAL_SESSION_STATUS.RUNNING) {
        ids.add(session.workflowId);
      }
    }
    return Array.from(ids);
  }

  /**
   * Get all active sessions across all workflows.
   */
  getAllSessions(): PtySession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Gracefully signal all active AI CLI PTY sessions to shut down.
   * Sends Ctrl+C twice to each session so the CLI TUI can clean up, then
   * waits 500ms. Called from extension deactivate() before hard-kill so that
   * AI CLIs do not warn about improper shutdown on the next launch.
   *
   * Hard-killing is left to dispose() (called via context.subscriptions).
   */
  async gracefulShutdownAllAiCliSessions(): Promise<void> {
    const aiSessions = Array.from(this.sessions.values()).filter(
      (s) => s.kind === SESSION_KINDS.AI_CLI
    );
    if (aiSessions.length === 0) {
      return;
    }
    Log.debug(
      `[PtyProcessManager] gracefulShutdownAllAiCliSessions — sending Ctrl+C to ${aiSessions.length} session(s)`
    );
    for (const session of aiSessions) {
      session.markEnding(TERMINAL_END_REASONS.CLOSED);
      try {
        session.pty.write("\x03");
        session.pty.write("\x03");
      } catch {
        // Session may already be dead
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }

  /**
   * Implements vscode.Disposable. Kills all PTY processes on extension deactivation.
   */
  dispose(): void {
    for (const session of this.sessions.values()) {
      session.markEnding(TERMINAL_END_REASONS.CLOSED);
      try {
        session.pty.kill();
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.sessions.clear();
    this.workflowRunControllers.clear();
    Log.debug("[PtyProcessManager] disposed — all PTY sessions killed");
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
 * @param dimensionsPersistence Optional backend (extension globalState) for
 *   persisting the last controller viewport size across sessions so the harness
 *   spawns near the real width even on the first run after a restart.
 */
export function initPtyProcessManager(
  postMessage: (msg: unknown) => void,
  dimensionsPersistence?: PtyDimensionsPersistence
): PtyProcessManager {
  _postMessage = postMessage;
  _instance = new PtyProcessManager();
  if (dimensionsPersistence) {
    _instance.setDimensionsPersistence(dimensionsPersistence);
  }
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
  _postMessage?.(secretRedactionService.redactValue(msg));
}

/**
 * Update the PTY postMessage callback without recreating the singleton.
 * Called from extension.ts after the DashboardBroadcastHub is available so
 * terminal messages are broadcast to all connected clients (panel + browser tabs)
 * instead of only the VS Code panel webview.
 */
export function setPtyPostMessage(postMessage: (msg: unknown) => void): void {
  _postMessage = postMessage;
}
