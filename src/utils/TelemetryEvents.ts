import { getTelemetry } from "./TelemetryReporter";
import type {
  HarnessId,
  ExecutionMode,
  PromptTerminalStatus,
  FailureKind,
  WorkflowTelemetryOutcome,
} from "../types/DashboardConstants";

/**
 * Single source of truth for telemetry event names — see dev/implemented/TELEMETRY_PLAN.md
 * for the schema each one carries and exactly where it's fired from.
 */
export const TELEMETRY_EVENTS = {
  WORKFLOW_STARTED: "workflow/started",
  WORKFLOW_COMPLETED: "workflow/completed",
  PROMPT_COMPLETED: "prompt/completed",
  END_CONDITION_EVALUATED: "endcondition/evaluated",
  CLI_NOT_FOUND: "cli/not_found",
  EXTENSION_ACTIVATION_FAILED: "extension/activationFailed",
} as const;

export type EndConditionResult = "pass" | "fail" | "error";

/** All telemetry property values must be strings; centralize that conversion here. */
function toProps(
  props: Record<string, string | number | boolean | undefined>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) {
      result[key] = String(value);
    }
  }
  return result;
}

/** Never let a telemetry send throw into the caller's control flow. */
function safeSend(send: () => void): void {
  try {
    send();
  } catch {
    // Telemetry must never affect workflow execution.
  }
}

export function reportWorkflowStarted(props: {
  harness: HarnessId;
  executionMode: ExecutionMode;
  stepCount: number;
  hasFinalStep: boolean;
  hasEndCondition: boolean;
  resumeSession: boolean;
  dynamicQueueEnabled: boolean;
  mcpEnabled: boolean;
}): void {
  const reporter = getTelemetry();
  if (!reporter) {
    return;
  }
  safeSend(() =>
    reporter.sendTelemetryEvent(
      TELEMETRY_EVENTS.WORKFLOW_STARTED,
      toProps(props)
    )
  );
}

export function reportWorkflowCompleted(props: {
  harness: HarnessId;
  executionMode: ExecutionMode;
  outcome: WorkflowTelemetryOutcome;
  stepCount: number;
  totalDurationMs: number;
}): void {
  const reporter = getTelemetry();
  if (!reporter) {
    return;
  }
  safeSend(() =>
    reporter.sendTelemetryEvent(
      TELEMETRY_EVENTS.WORKFLOW_COMPLETED,
      toProps(props)
    )
  );
}

export function reportPromptCompleted(props: {
  harness: HarnessId;
  executionMode: ExecutionMode;
  promptIndex: number;
  durationMs: number;
  outcome: PromptTerminalStatus;
  failureKind?: FailureKind;
  endConditionUsed: boolean;
  resumeSession: boolean;
  reuseRunningTerminal: boolean;
}): void {
  const reporter = getTelemetry();
  if (!reporter) {
    return;
  }
  safeSend(() =>
    reporter.sendTelemetryEvent(
      TELEMETRY_EVENTS.PROMPT_COMPLETED,
      toProps(props)
    )
  );
}

export function reportEndConditionEvaluated(props: {
  harness: HarnessId;
  result: EndConditionResult;
  attempt: number;
  maxRetries: number;
  durationMs: number;
}): void {
  const reporter = getTelemetry();
  if (!reporter) {
    return;
  }
  safeSend(() =>
    reporter.sendTelemetryEvent(
      TELEMETRY_EVENTS.END_CONDITION_EVALUATED,
      toProps(props)
    )
  );
}

export function reportCliNotFound(harness: HarnessId): void {
  const reporter = getTelemetry();
  if (!reporter) {
    return;
  }
  safeSend(() =>
    reporter.sendTelemetryEvent(
      TELEMETRY_EVENTS.CLI_NOT_FOUND,
      toProps({ harness })
    )
  );
}

/** Type/class name only — never the message, which may contain user data. */
export function getErrorTypeName(error: unknown): string {
  if (error instanceof Error) {
    return error.constructor.name;
  }
  return typeof error;
}

/** `errorType` must be a type/class name only — never an error message (may contain user data). */
export function reportExtensionActivationFailed(errorType: string): void {
  const reporter = getTelemetry();
  if (!reporter) {
    return;
  }
  safeSend(() =>
    reporter.sendTelemetryErrorEvent(
      TELEMETRY_EVENTS.EXTENSION_ACTIVATION_FAILED,
      toProps({ errorType })
    )
  );
}
