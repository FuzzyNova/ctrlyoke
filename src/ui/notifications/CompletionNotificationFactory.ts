import * as path from "path";
import {
  COMPLETION_NOTIFICATION_KINDS,
  COMPLETION_NOTIFICATION_SEVERITY,
  EXECUTION_STATES,
  NOTIFICATION_EVENT_MODES,
  NOTIFICATION_KINDS,
  STEP_STATUS,
  type CompletionNotificationSeverity,
  type ExecutionState,
  type HookEvent,
  type NotificationKind,
  type StepStatus,
  HOOK_EVENT_METADATA,
} from "../../types/DashboardConstants";
import type {
  WorkflowSummary,
  WorkflowStep,
} from "../../types/FlightPathTypes";
import type { FlightPathNotificationSettings } from "../../types/FlightPathSettings";

export interface FlightPathNotificationEvent {
  id: string;
  kind: NotificationKind;
  severity: CompletionNotificationSeverity;
  workflowId: string;
  stepIndex?: number;
  title: string;
  body: string;
  tag: string;
  url?: string;
  /** Set for hook-kind events. */
  hookEvent?: HookEvent;
  /** Harness that fired the hook event. */
  harnessId?: string;
  /** Tool name for preToolUse / postToolUse hook events. */
  toolName?: string;
}

/** @deprecated Use FlightPathNotificationEvent */
export type CompletionNotificationEvent = FlightPathNotificationEvent;

/**
 * Raw artifact written by a hook script when FLIGHTPATH_NOTIFY_HOOK_EVENTS is set.
 * File naming: `{runId}-hook-{timestamp}-{pid}.json`
 */
export interface HookArtifact {
  runId: string;
  timestamp: number;
  workflowId: string;
  workflowName: string;
  promptIndex: number;
  promptName: string;
  hookEvent: HookEvent;
  /** Raw CLI-specific event name (e.g. "PreToolUse", "agentStop"). */
  nativeHookEvent: string;
  harnessId: string;
  sessionId?: string;
  toolName?: string;
  rawHookData: Record<string, unknown>;
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

/**
 * Builds a FlightPathNotificationEvent for a hook event artifact, or returns
 * null if the settings have the event disabled.
 */
export function buildHookNotificationEvent(
  artifact: HookArtifact,
  settings: FlightPathNotificationSettings,
  url?: string
): FlightPathNotificationEvent | null {
  if (!settings.events.hookEvents[artifact.hookEvent]) {
    return null;
  }

  const meta = HOOK_EVENT_METADATA.find((m) => m.event === artifact.hookEvent);
  const label = meta?.label ?? artifact.hookEvent;

  const titleParts = ["FlightPath -", label];
  const bodyParts: string[] = [];

  if (settings.includeWorkflowName && artifact.workflowName) {
    bodyParts.push(artifact.workflowName);
  }
  if (settings.includePromptName && artifact.promptName) {
    bodyParts.push(artifact.promptName);
  }
  if (artifact.toolName) {
    bodyParts.push(artifact.toolName);
  }

  const id = `${artifact.workflowId}:hook:${artifact.hookEvent}:${artifact.timestamp}`;

  return {
    id,
    kind: NOTIFICATION_KINDS.HOOK,
    severity: COMPLETION_NOTIFICATION_SEVERITY.INFO,
    workflowId: artifact.workflowId,
    title: titleParts.join(" "),
    body: bodyParts.join(" - ") || label,
    tag: `flightpath-hook-${artifact.workflowId}-${artifact.hookEvent}`,
    url,
    hookEvent: artifact.hookEvent,
    harnessId: artifact.harnessId,
    toolName: artifact.toolName,
  };
}
