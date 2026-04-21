import * as path from "path";
import {
  COMPLETION_NOTIFICATION_KINDS,
  COMPLETION_NOTIFICATION_SEVERITY,
  EXECUTION_STATES,
  NOTIFICATION_EVENT_MODES,
  STEP_STATUS,
  type CompletionNotificationKind,
  type CompletionNotificationSeverity,
  type ExecutionState,
  type StepStatus,
} from "../../types/DashboardConstants";
import type {
  WorkflowSummary,
  WorkflowStep,
} from "../../types/FlightPathTypes";
import type { FlightPathNotificationSettings } from "../../types/FlightPathSettings";

export interface CompletionNotificationEvent {
  id: string;
  kind: CompletionNotificationKind;
  severity: CompletionNotificationSeverity;
  workflowId: string;
  stepIndex?: number;
  title: string;
  body: string;
  tag: string;
  url?: string;
}

interface WorkflowNotificationInput {
  summary: WorkflowSummary;
  settings: FlightPathNotificationSettings;
  url?: string;
}

interface PromptNotificationInput {
  summary: WorkflowSummary;
  steps?: WorkflowStep[];
  stepIndex: number;
  stepStatus: {
    state: StepStatus;
    duration?: number;
    message?: string;
  };
  settings: FlightPathNotificationSettings;
  url?: string;
}

export function buildTestNotificationEvent(
  url?: string
): CompletionNotificationEvent {
  const eventId = `test:${Date.now()}`;

  return {
    id: eventId,
    kind: COMPLETION_NOTIFICATION_KINDS.WORKFLOW,
    severity: COMPLETION_NOTIFICATION_SEVERITY.INFO,
    workflowId: "test",
    title: "FlightPath - Test Notification",
    body: "Developer test notification",
    tag: `flightpath-${eventId}`,
    url,
  };
}

export function isWorkflowCompletionTransition(
  previousSummary: WorkflowSummary | undefined,
  nextSummary: WorkflowSummary
): boolean {
  const nextState = nextSummary.executionState;

  if (
    nextState !== EXECUTION_STATES.COMPLETED &&
    nextState !== EXECUTION_STATES.ERROR
  ) {
    return false;
  }

  return previousSummary?.executionState === EXECUTION_STATES.RUNNING;
}

export function buildWorkflowCompletionNotification(
  input: WorkflowNotificationInput
): CompletionNotificationEvent | undefined {
  const { summary, settings, url } = input;
  const state = summary.executionState;

  if (
    state !== EXECUTION_STATES.COMPLETED &&
    state !== EXECUTION_STATES.ERROR
  ) {
    return undefined;
  }

  const isFailure = state === EXECUTION_STATES.ERROR;
  const mode = settings.events.workflowComplete;
  if (mode === NOTIFICATION_EVENT_MODES.NEVER) {
    return undefined;
  }
  if (mode === NOTIFICATION_EVENT_MODES.FAILURES_ONLY && !isFailure) {
    return undefined;
  }

  const title = isFailure
    ? "FlightPath - Workflow Failed"
    : "FlightPath - Workflow Complete";
  const body = buildWorkflowBody(summary, settings, state);

  return {
    id: `${summary.id}:workflow:${state}`,
    kind: COMPLETION_NOTIFICATION_KINDS.WORKFLOW,
    severity: isFailure
      ? COMPLETION_NOTIFICATION_SEVERITY.ERROR
      : COMPLETION_NOTIFICATION_SEVERITY.INFO,
    workflowId: summary.id,
    title,
    body,
    tag: `flightpath-workflow-${summary.id}`,
    url,
  };
}

export function buildPromptCompletionNotification(
  input: PromptNotificationInput
): CompletionNotificationEvent | undefined {
  const { summary, steps, stepIndex, stepStatus, settings, url } = input;

  if (
    stepStatus.state !== STEP_STATUS.COMPLETED &&
    stepStatus.state !== STEP_STATUS.FAILED
  ) {
    return undefined;
  }

  const isFailure = stepStatus.state === STEP_STATUS.FAILED;
  const mode = settings.events.promptComplete;
  if (mode === NOTIFICATION_EVENT_MODES.NEVER) {
    return undefined;
  }
  if (mode === NOTIFICATION_EVENT_MODES.FAILURES_ONLY && !isFailure) {
    return undefined;
  }

  const step = steps?.[stepIndex];
  const title = isFailure
    ? "FlightPath - Prompt Failed"
    : "FlightPath - Prompt Complete";
  const body = buildPromptBody(
    summary,
    step,
    stepIndex,
    stepStatus,
    settings,
    isFailure
  );

  return {
    id: `${summary.id}:prompt:${stepIndex}:${stepStatus.state}`,
    kind: COMPLETION_NOTIFICATION_KINDS.PROMPT,
    severity: isFailure
      ? COMPLETION_NOTIFICATION_SEVERITY.ERROR
      : COMPLETION_NOTIFICATION_SEVERITY.INFO,
    workflowId: summary.id,
    stepIndex,
    title,
    body,
    tag: `flightpath-prompt-${summary.id}-${stepIndex}`,
    url,
  };
}

function buildWorkflowBody(
  summary: WorkflowSummary,
  settings: FlightPathNotificationSettings,
  state: ExecutionState
): string {
  const parts: string[] = [];
  const workflowName = getWorkflowDisplayName(summary, settings);
  if (workflowName) {
    parts.push(workflowName);
  }

  if (summary.totalSteps > 0) {
    const completedCount =
      state === EXECUTION_STATES.COMPLETED
        ? summary.totalSteps
        : Math.max(0, Math.min(summary.currentStep, summary.totalSteps));
    parts.push(`${completedCount} of ${summary.totalSteps} prompts`);
  }

  const duration = formatDurationFromEpochs(
    summary.startedAt,
    summary.completedAt
  );
  if (duration) {
    parts.push(`in ${duration}`);
  }

  return parts.join(" - ") || "Workflow finished.";
}

function buildPromptBody(
  summary: WorkflowSummary,
  step: WorkflowStep | undefined,
  stepIndex: number,
  stepStatus: { duration?: number; message?: string },
  settings: FlightPathNotificationSettings,
  isFailure: boolean
): string {
  const parts: string[] = [];
  const workflowName = getWorkflowDisplayName(summary, settings);
  if (workflowName) {
    parts.push(workflowName);
  }

  const stepLabel = getPromptDisplayName(step, stepIndex, settings);
  parts.push(stepLabel);

  if (isFailure) {
    if (stepStatus.message) {
      parts.push(stepStatus.message);
    } else {
      parts.push("failed");
    }
  } else if (typeof stepStatus.duration === "number") {
    parts.push(`completed in ${formatDurationSeconds(stepStatus.duration)}`);
  } else {
    parts.push("completed");
  }

  return parts.join(" - ");
}

function getWorkflowDisplayName(
  summary: WorkflowSummary,
  settings: FlightPathNotificationSettings
): string | undefined {
  if (!settings.includeWorkflowName) {
    return undefined;
  }

  if (summary.workflowName?.trim()) {
    return summary.workflowName;
  }

  if (summary.filePath?.trim()) {
    return path.basename(summary.filePath);
  }

  if (summary.workingFilePath?.trim()) {
    return path.basename(summary.workingFilePath);
  }

  return undefined;
}

function getPromptDisplayName(
  step: WorkflowStep | undefined,
  stepIndex: number,
  settings: FlightPathNotificationSettings
): string {
  if (settings.includePromptName && step?.name?.trim()) {
    return `step ${stepIndex + 1} "${step.name}"`;
  }

  return `step ${stepIndex + 1}`;
}

function formatDurationFromEpochs(
  startedAt?: number,
  completedAt?: number
): string | undefined {
  if (typeof startedAt !== "number") {
    return undefined;
  }

  const endMs = typeof completedAt === "number" ? completedAt : Date.now();
  return formatDurationSeconds((endMs - startedAt) / 1000);
}

function formatDurationSeconds(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }

  return `${remainingSeconds}s`;
}
