import {
  EXECUTION_STATES,
  FAILURE_KINDS,
  FINAL_STEP_PHASES,
} from "../types/DashboardConstants";
import type { FinalStepRuntimeState, QueueState } from "../types/CtrlYokeTypes";
import { selectTerminalFailure } from "../utils/TerminalFailure";
export { selectTerminalFailure } from "../utils/TerminalFailure";
import { getErrorMessage } from "../utils/ErrorUtils";
import { secretRedactionService } from "../utils/SecretRedactionService";
import { exitQuietlyOnClosedPipe } from "./CliClosedPipe";

/** Exit code for CLI usage, parsing, and unexpected errors. */
export const CLI_USAGE_EXIT_CODE = 2;

/** A run interrupted by SIGINT or SIGTERM. */
export const CLI_INTERRUPTED_EXIT_CODE = 5;

/** Guardrail stops have a dedicated non-zero code for automation callers. */
export const CLI_GUARDRAIL_STOP_EXIT_CODE = 6;

/** Report an unexpected CLI error and exit with the documented usage code. */
export class CliUsageError extends Error {
  constructor(
    message: string,
    readonly exitCode = CLI_USAGE_EXIT_CODE
  ) {
    super(message);
    this.name = "CliUsageError";
  }
}

export interface CliErrorReportOptions {
  json?: boolean;
  command?: string;
  exitCode?: number;
  envelope?: (message: string, code: number) => unknown;
  writeOut?: (message: string) => void;
  writeErr?: (message: string) => void;
  exit?: (code: number) => void;
}

/** Redact and consistently report an error on the command's selected surface. */
export function reportCliError(
  error: unknown,
  options: CliErrorReportOptions = {}
): void {
  const code =
    options.exitCode ??
    (error instanceof CliUsageError ? error.exitCode : CLI_USAGE_EXIT_CODE);
  const rawMessage = getErrorMessage(error);
  const message = secretRedactionService.redactText(rawMessage);
  exitQuietlyOnClosedPipe();
  if (options.json) {
    const payload = options.envelope
      ? options.envelope(message, code)
      : { schemaVersion: 1, success: false, error: { message } };
    (options.writeOut ?? ((value) => process.stdout.write(value)))(
      `${secretRedactionService.redactText(JSON.stringify(payload))}\n`
    );
  } else {
    (options.writeErr ?? ((value) => console.error(value)))(
      secretRedactionService.redactText(
        message.startsWith("Error: ") ? message : `Error: ${message}`
      )
    );
  }
  (options.exit ?? ((value) => process.exit(value)))(code);
}

/** Determine the CLI process exit code from the final workflow state. */
export function getExitCode(
  state: Pick<QueueState, "status" | "results" | "stopReason">,
  finalStepRuntime?: FinalStepRuntimeState
): number {
  if (state.status === EXECUTION_STATES.COMPLETED) {
    return 0;
  }

  if (state.stopReason) {
    return CLI_GUARDRAIL_STOP_EXIT_CODE;
  }

  if (state.status === EXECUTION_STATES.ERROR) {
    const failure = selectTerminalFailure(state, finalStepRuntime);
    const failureKind =
      failure?.kind === FINAL_STEP_PHASES.FINAL_STEP
        ? failure.runtime.failureKind
        : failure?.result.failureKind;

    if (failureKind === FAILURE_KINDS.TIMEOUT) {
      return 4;
    }

    if (failureKind === FAILURE_KINDS.HARNESS_NOT_INSTALLED) {
      return 3;
    }
  }

  return 1;
}
