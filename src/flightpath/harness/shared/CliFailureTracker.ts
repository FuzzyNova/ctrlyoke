import {
  FAILURE_KINDS,
  INTERACTIVE_ABORT_KINDS,
  type FailureKind,
  type InteractiveAbortKind,
} from "../../../types/DashboardConstants";

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

  reset(): void {
    this.ptyExitCode = null;
    this.processExitTermination = null;
    this.lastFailureOutput = undefined;
    this.lastFailureKind = undefined;
    this.lastFailureMessage = undefined;
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

  markCompletionDetectionProcessExit(exitCode: number): string {
    return this.markProcessExit(
      exitCode,
      `CLI process exited unexpectedly (exit code ${exitCode})`
    );
  }

  markProcessExit(exitCode: number, reason: string): string {
    this.processExitTermination = exitCode;
    this.lastFailureKind = FAILURE_KINDS.PROCESS_EXIT;
    this.lastFailureMessage = reason;
    return reason;
  }

  markHarnessError(message: string): string {
    this.lastFailureKind = FAILURE_KINDS.HARNESS_ERROR;
    this.lastFailureMessage = message;
    return message;
  }

  markTimeout(message: string): string {
    this.lastFailureKind = FAILURE_KINDS.TIMEOUT;
    this.lastFailureMessage = message;
    return message;
  }

  markUnknownFailure(message: string): string {
    this.lastFailureKind = FAILURE_KINDS.UNKNOWN;
    this.lastFailureMessage = message;
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
