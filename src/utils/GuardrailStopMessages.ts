import { GUARDRAIL_STOP_CODES } from "../types/DashboardConstants";
import type { WorkflowStopReason } from "../types/CtrlYokeTypes";
import type { EffectiveMaxStepsSource } from "./QueueLimitUtils";

export function buildQueueSizeLimitStopReason(
  observed: number,
  threshold: number,
  source: EffectiveMaxStepsSource
): WorkflowStopReason {
  return {
    code: GUARDRAIL_STOP_CODES.QUEUE_SIZE_LIMIT,
    threshold,
    observed,
    unit: "steps",
    message: `Step limit reached: this run has ${observed}/${threshold} steps (${source}: ${threshold}).`,
  };
}

/** Agent-directed variant used when rejecting an MCP append request. */
export function buildQueueSizeLimitAgentMessage(
  observed: number,
  threshold: number,
  source: EffectiveMaxStepsSource
): string {
  return `${buildQueueSizeLimitStopReason(observed, threshold, source).message} Do not retry; finish without appending.`;
}

export function buildWorkflowTimeLimitStopReason(
  observedSeconds: number,
  thresholdSeconds: number,
  details?: {
    completedCount: number;
    totalSteps: number;
    remainingCount: number;
  }
): WorkflowStopReason {
  const detailsMessage = details
    ? `\nCompleted ${details.completedCount} of ${details.totalSteps} steps. ${details.remainingCount} steps remaining in queue.`
    : "";
  return {
    code: GUARDRAIL_STOP_CODES.WORKFLOW_TIME_LIMIT,
    threshold: thresholdSeconds,
    observed: observedSeconds,
    unit: "seconds",
    message: `Workflow stopped - Maximum execution time reached (${observedSeconds}s / ${thresholdSeconds}s).${detailsMessage}`,
  };
}

export function buildPromptTimeoutStopReason(
  observedSeconds: number,
  thresholdSeconds: number
): WorkflowStopReason {
  return {
    code: GUARDRAIL_STOP_CODES.PROMPT_TIMEOUT,
    threshold: thresholdSeconds,
    observed: observedSeconds,
    unit: "seconds",
    message: `Prompt timed out (${observedSeconds}s / ${thresholdSeconds}s).`,
  };
}
