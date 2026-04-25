/**
 * Status icon and display utilities
 * Adapted for React (returns component-friendly data instead of HTML strings)
 */

import {
  STEP_STATUS,
  EXECUTION_STATES,
  type StepStatus,
  type ExecutionState,
} from "../types/messages";

/**
 * Codicon class names for status icons
 * These map to VS Code's codicon icon font
 */
export const STATUS_ICONS: Record<StepStatus, string> = {
  [STEP_STATUS.PENDING]: "codicon-circle-outline",
  [STEP_STATUS.SENT]: "codicon-arrow-right",
  [STEP_STATUS.RUNNING]: "codicon-play",
  [STEP_STATUS.COMPLETED]: "codicon-pass",
  [STEP_STATUS.FAILED]: "codicon-error",
  [STEP_STATUS.CANCELLED]: "codicon-circle-slash",
  [STEP_STATUS.SKIPPED]: "codicon-debug-step-over",
};

/**
 * Get codicon class for a step status
 *
 * @param status - Step status
 * @returns Codicon class name (e.g., "codicon-pass")
 *
 * @example
 * // In React component:
 * <i className={`codicon ${getStatusIconClass("completed")}`} />
 */
export function getStatusIconClass(status: StepStatus): string {
  return STATUS_ICONS[status] || STATUS_ICONS[STEP_STATUS.PENDING];
}

/**
 * Get full codicon className string for a status
 * Convenience function that includes the base "codicon" class
 *
 * @param status - Step status
 * @returns Full className string (e.g., "codicon codicon-pass")
 */
export function getStatusIconClassName(status: StepStatus): string {
  return `codicon ${getStatusIconClass(status)}`;
}

/**
 * Status color classes for styling
 * Maps to CSS classes or Tailwind utilities
 */
export const STATUS_COLORS: Record<StepStatus, string> = {
  [STEP_STATUS.PENDING]: "text-description-fg",
  [STEP_STATUS.SENT]: "text-charts-blue",
  [STEP_STATUS.RUNNING]: "text-charts-blue",
  [STEP_STATUS.COMPLETED]: "text-indicator-success",
  [STEP_STATUS.FAILED]: "text-indicator-error",
  [STEP_STATUS.CANCELLED]: "text-description-fg",
  [STEP_STATUS.SKIPPED]: "text-description-fg",
};

/**
 * Get color class for a step status
 *
 * @param status - Step status
 * @returns Tailwind color class
 */
export function getStatusColorClass(status: StepStatus): string {
  return STATUS_COLORS[status] || STATUS_COLORS[STEP_STATUS.PENDING];
}

/**
 * Human-readable labels for step statuses
 */
export const STATUS_LABELS: Record<StepStatus, string> = {
  [STEP_STATUS.PENDING]: "Pending",
  [STEP_STATUS.SENT]: "Sent",
  [STEP_STATUS.RUNNING]: "Running",
  [STEP_STATUS.COMPLETED]: "Completed",
  [STEP_STATUS.FAILED]: "Failed",
  [STEP_STATUS.CANCELLED]: "Cancelled",
  [STEP_STATUS.SKIPPED]: "Skipped",
};

/**
 * Get human-readable label for a step status
 */
export function getStatusLabel(status: StepStatus): string {
  return STATUS_LABELS[status] || "Unknown";
}

/**
 * Execution state icons (for workflow-level status)
 */
export const EXECUTION_STATE_ICONS: Record<ExecutionState, string> = {
  [EXECUTION_STATES.IDLE]: "codicon-circle-outline",
  [EXECUTION_STATES.RUNNING]: "codicon-play",
  [EXECUTION_STATES.PAUSED]: "codicon-debug-pause",
  [EXECUTION_STATES.STOPPED]: "codicon-stop",
  [EXECUTION_STATES.CANCELLING]: "codicon-loading",
  [EXECUTION_STATES.COMPLETED]: "codicon-pass-filled",
  [EXECUTION_STATES.ERROR]: "codicon-error",
};

/**
 * Get codicon class for execution state
 */
export function getExecutionStateIconClass(state: ExecutionState): string {
  return (
    EXECUTION_STATE_ICONS[state] || EXECUTION_STATE_ICONS[EXECUTION_STATES.IDLE]
  );
}

/**
 * Execution state colors
 */
export const EXECUTION_STATE_COLORS: Record<ExecutionState, string> = {
  [EXECUTION_STATES.IDLE]: "text-description-fg",
  [EXECUTION_STATES.RUNNING]: "text-charts-blue",
  [EXECUTION_STATES.PAUSED]: "text-indicator-running",
  [EXECUTION_STATES.STOPPED]: "text-warning-fg",
  [EXECUTION_STATES.CANCELLING]: "text-warning-fg",
  [EXECUTION_STATES.COMPLETED]: "text-indicator-success",
  [EXECUTION_STATES.ERROR]: "text-indicator-error",
};

/**
 * Get color class for execution state
 */
export function getExecutionStateColorClass(state: ExecutionState): string {
  return (
    EXECUTION_STATE_COLORS[state] ||
    EXECUTION_STATE_COLORS[EXECUTION_STATES.IDLE]
  );
}

/**
 * Human-readable labels for execution states
 */
export const EXECUTION_STATE_LABELS: Record<ExecutionState, string> = {
  [EXECUTION_STATES.IDLE]: "Ready",
  [EXECUTION_STATES.RUNNING]: "Running",
  [EXECUTION_STATES.PAUSED]: "Paused",
  [EXECUTION_STATES.STOPPED]: "Stopped",
  [EXECUTION_STATES.CANCELLING]: "Cancelling...",
  [EXECUTION_STATES.COMPLETED]: "Completed",
  [EXECUTION_STATES.ERROR]: "Error",
};

/**
 * Get human-readable label for execution state
 */
export function getExecutionStateLabel(state: ExecutionState): string {
  return EXECUTION_STATE_LABELS[state] || "Unknown";
}

/**
 * Check if execution is in a "busy" state (running or cancelling)
 */
export function isExecutionBusy(state: ExecutionState): boolean {
  return (
    state === EXECUTION_STATES.RUNNING || state === EXECUTION_STATES.CANCELLING
  );
}

/**
 * Check if execution can be started
 */
export function canStartExecution(state: ExecutionState): boolean {
  return (
    state === EXECUTION_STATES.IDLE ||
    state === EXECUTION_STATES.COMPLETED ||
    state === EXECUTION_STATES.ERROR ||
    state === EXECUTION_STATES.STOPPED
  );
}

/**
 * Check if execution can be paused
 */
export function canPauseExecution(state: ExecutionState): boolean {
  return state === EXECUTION_STATES.RUNNING;
}

/**
 * Check if execution can be resumed
 */
export function canResumeExecution(state: ExecutionState): boolean {
  return state === EXECUTION_STATES.PAUSED;
}

/**
 * Check if execution can be stopped
 */
export function canStopExecution(state: ExecutionState): boolean {
  return (
    state === EXECUTION_STATES.RUNNING || state === EXECUTION_STATES.PAUSED
  );
}

/**
 * Execution state badge classes (background + text color)
 * Used for status badges in workflow status and recent workflows
 */
export const EXECUTION_STATE_BADGE_CLASSES: Record<ExecutionState, string> = {
  [EXECUTION_STATES.IDLE]: "bg-status-idle text-white",
  [EXECUTION_STATES.RUNNING]: "bg-status-running text-white",
  [EXECUTION_STATES.PAUSED]: "bg-status-paused text-white",
  [EXECUTION_STATES.STOPPED]: "bg-status-stopped text-white",
  [EXECUTION_STATES.CANCELLING]: "bg-status-cancelling text-white",
  [EXECUTION_STATES.COMPLETED]: "bg-status-completed text-white",
  [EXECUTION_STATES.ERROR]: "bg-status-error text-white",
};

/**
 * Get badge classes for execution state
 * Returns background and text color classes for status badges
 *
 * @param state - Execution state (case-insensitive)
 * @returns Tailwind classes for badge styling
 *
 * @example
 * <span className={`px-1.5 py-0.5 rounded ${getExecutionStateBadgeClass("running")}`}>
 *   Running
 * </span>
 */
export function getExecutionStateBadgeClass(state: string): string {
  const normalizedState = state.toLowerCase() as ExecutionState;
  return (
    EXECUTION_STATE_BADGE_CLASSES[normalizedState] ||
    EXECUTION_STATE_BADGE_CLASSES[EXECUTION_STATES.IDLE]
  );
}

/**
 * Codicon classes for execution state badges (icon-only mode for narrow layouts)
 */
export const EXECUTION_STATE_BADGE_ICONS: Record<ExecutionState, string> = {
  [EXECUTION_STATES.IDLE]: "codicon-circle-large",
  [EXECUTION_STATES.RUNNING]: "codicon-play",
  [EXECUTION_STATES.PAUSED]: "codicon-debug-pause",
  [EXECUTION_STATES.STOPPED]: "codicon-debug-stop",
  [EXECUTION_STATES.CANCELLING]: "codicon-circle-slash",
  [EXECUTION_STATES.COMPLETED]: "codicon-pass",
  [EXECUTION_STATES.ERROR]: "codicon-error",
};

/**
 * Get codicon class for execution state badge (icon-only narrow mode)
 */
export function getExecutionStateBadgeIcon(state: string): string {
  const normalizedState = state.toLowerCase() as ExecutionState;
  return (
    EXECUTION_STATE_BADGE_ICONS[normalizedState] ||
    EXECUTION_STATE_BADGE_ICONS[EXECUTION_STATES.IDLE]
  );
}
