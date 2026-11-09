import {
  FAILURE_KINDS,
  FAILURE_SOURCES,
  INTERACTIVE_ABORT_KINDS,
  type FailureKind,
  type FailureSource,
  type InteractiveAbortKind,
} from "../../../types/DashboardConstants";
import type { FailureRecord } from "../../../types/CtrlYokeTypes";

export type InteractiveAbortState =
  | { kind: typeof INTERACTIVE_ABORT_KINDS.USER_CANCELLED }
  | { kind: typeof INTERACTIVE_ABORT_KINDS.PROCESS_EXITED; exitCode: number };

export type { InteractiveAbortKind };

/**
 * Tracks abnormal CLI process exits for a single prompt send attempt.
 *
 * Separates three related but distinct concerns:
 * - raw PTY exit observation (the process died)
 * - failure classification (the exit should fail the attempt)
 * - last visible PTY tail for user-facing diagnostics
 */
export class CliFailureTracker {
  private ptyExitCode: number | null = null;
  private processExitTermination: number | null = null;
  private lastFailureOutput?: string;
  private lastFailureKind?: FailureKind;
  private lastFailureMessage?: string;
  private lastFailureSource?: FailureSource;
  private lastFailureDetail?: FailureRecord["detail"];

  reset(): void {
    this.ptyExitCode = null;
    this.processExitTermination = null;
    this.lastFailureOutput = undefined;
    this.lastFailureKind = undefined;
    this.lastFailureMessage = undefined;
    this.lastFailureSource = undefined;
    this.lastFailureDetail = undefined;
  }

  capturePtyExit(exitCode: number, reconnectBuffer: string[]): void {
    this.ptyExitCode = exitCode;
    this.lastFailureOutput = this.extractInteractiveOutputTail(reconnectBuffer);
  }

  getPtyTermination(): { exitCode: number } | null {
    if (this.ptyExitCode === null) {
      return null;
    }

    return { exitCode: this.ptyExitCode };
  }

  getInteractiveAbortState(
    isCancelling: boolean
  ): InteractiveAbortState | null {
    if (isCancelling) {
      return { kind: INTERACTIVE_ABORT_KINDS.USER_CANCELLED };
    }

    if (this.ptyExitCode !== null) {
      return {
        kind: INTERACTIVE_ABORT_KINDS.PROCESS_EXITED,
        exitCode: this.ptyExitCode,
      };
    }

    return null;
  }

  markProcessExitDuringStage(stage: string, exitCode: number): string {
    return this.markProcessExit(
      exitCode,
      `CLI process exited unexpectedly while ${stage} (exit code ${exitCode})`
    );
  }

  markProcessExit(exitCode: number, reason: string): string {
    this.processExitTermination = exitCode;
    this.lastFailureKind = FAILURE_KINDS.PROCESS_EXIT;
    this.lastFailureMessage = reason;
    this.lastFailureSource = FAILURE_SOURCES.PROCESS_EXIT;
    this.lastFailureDetail = { exitCode };
    return reason;
  }

  markHarnessError(
    message: string,
    detail?: FailureRecord["detail"],
    source: FailureSource = FAILURE_SOURCES.HOOK
  ): string {
    this.lastFailureKind = FAILURE_KINDS.HARNESS_ERROR;
    this.lastFailureMessage = message;
    this.lastFailureSource = source;
    this.lastFailureDetail = detail;
    return message;
  }

  markHarnessNotInstalled(message: string): string {
    this.lastFailureKind = FAILURE_KINDS.HARNESS_NOT_INSTALLED;
    this.lastFailureMessage = message;
    this.lastFailureSource = FAILURE_SOURCES.SPAWN;
    return message;
  }

  markTimeout(message: string, detail?: FailureRecord["detail"]): string {
    this.lastFailureKind = FAILURE_KINDS.TIMEOUT;
    this.lastFailureMessage = message;
    this.lastFailureSource = FAILURE_SOURCES.TIMEOUT;
    this.lastFailureDetail = detail;
    return message;
  }

  /**
   * Record a failure that was a termination rather than a harness fault (the
   * process was killed). Deliberately does not set `processExitTermination`:
   * the exit code of a killed process is synthetic, so treating it as a process
   * exit would make a teardown look like something worth retrying.
   */
  markUserCancelled(message: string): string {
    this.lastFailureKind = FAILURE_KINDS.USER_CANCELLED;
    this.lastFailureMessage = message;
    this.lastFailureSource = FAILURE_SOURCES.SIGNAL;
    return message;
  }

  markUnknownFailure(
    message: string,
    source: FailureSource = FAILURE_SOURCES.HEADLESS_PARSE
  ): string {
    this.lastFailureKind = FAILURE_KINDS.UNKNOWN;
    this.lastFailureMessage = message;
    this.lastFailureSource = source;
    return message;
  }

  getLastFailureOutput(): string | undefined {
    return this.lastFailureOutput;
  }

  wasLastFailureProcessExit(): boolean {
    return this.processExitTermination !== null;
  }

  wasLastFailureHarnessError(): boolean {
    return this.lastFailureKind === FAILURE_KINDS.HARNESS_ERROR;
  }

  wasLastFailureTimeout(): boolean {
    return this.lastFailureKind === FAILURE_KINDS.TIMEOUT;
  }

  getLastFailureKind(): FailureKind | undefined {
    return this.lastFailureKind;
  }

  getLastFailureMessage(): string | undefined {
    return this.lastFailureMessage;
  }

  getLastFailureRecord(): FailureRecord | undefined {
    if (
      !this.lastFailureKind ||
      !this.lastFailureMessage ||
      !this.lastFailureSource
    ) {
      return undefined;
    }
    return {
      kind: this.lastFailureKind,
      message: this.lastFailureMessage,
      source: this.lastFailureSource,
      detail: this.lastFailureDetail,
    };
  }

  private extractInteractiveOutputTail(chunks: string[]): string | undefined {
    if (chunks.length === 0) {
      return undefined;
    }

    const cleaned = chunks
      .join("")
      .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, "")
      .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\x1B[@-_]/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

    const lines = cleaned
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);

    if (lines.length === 0) {
      return undefined;
    }

    const tail = lines.slice(-10).join("\n").trim();
    return tail || undefined;
  }
}
