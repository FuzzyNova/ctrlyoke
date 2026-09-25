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
import {
  STEP_TYPES,
  WORKFLOW_EXECUTION_CONTROL_ACTIONS,
  WORKFLOW_VIEW_ADDRESS_KIND,
  type StepType,
  type WorkflowExecutionControlAction,
} from "@root/types/DashboardConstants";

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
 * Codicon class names for a step's *kind* (prompt vs script).
 *
 * Every surface that identifies a step by shape reads this — the chip rail, the
 * expanded step row, and the output pane's parallel activity label — so the two
 * glyphs cannot drift apart between panes.
 */
export const STEP_KIND_ICONS: Record<StepType, string> = {
  [STEP_TYPES.PROMPT]: "codicon-comment",
  [STEP_TYPES.SCRIPT]: "codicon-terminal-powershell",
};

/**
 * Get the codicon class for a step's kind. Anything that is not explicitly a
 * script step is a prompt step, matching `isScriptWorkflowStep`.
 */
export function getStepKindIconClass(stepType: StepType | undefined): string {
  return stepType === STEP_TYPES.SCRIPT
    ? STEP_KIND_ICONS[STEP_TYPES.SCRIPT]
    : STEP_KIND_ICONS[STEP_TYPES.PROMPT];
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
  [STEP_STATUS.CANCELLED]: "text-indicator-running",
  [STEP_STATUS.SKIPPED]: "text-indicator-running",
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
const STATUS_LABELS: Record<StepStatus, string> = {
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
 * Get the left-rail/chip accent class for a step's status. This is the
 * fallback identity-bar rendering used everywhere `resolveStepColor` returns
 * nothing (`ui.stepColorMode: "none"`), so it must cover every status, not
 * just terminal ones — a step that hasn't run yet must not read as "done".
 * PENDING -> none (nothing has happened yet), SENT/RUNNING -> in-progress
 * (matches `STATUS_COLORS`' charts-blue), FAILED -> error (red),
 * CANCELLED/SKIPPED -> warning (yellow), COMPLETED -> success (green).
 */
export function getStepAccentClass(status: StepStatus): string {
  switch (status) {
    case STEP_STATUS.PENDING:
      return "bg-transparent";
    case STEP_STATUS.SENT:
    case STEP_STATUS.RUNNING:
      return "bg-charts-blue";
    case STEP_STATUS.CANCELLED:
    case STEP_STATUS.SKIPPED:
      return "bg-indicator-running";
    case STEP_STATUS.FAILED:
      return "bg-indicator-error";
    default:
      return "bg-indicator-success";
  }
}

/**
 * Execution state icons (for workflow-level status)
 */
const EXECUTION_STATE_ICONS: Record<ExecutionState, string> = {
  [EXECUTION_STATES.IDLE]: "codicon-circle-outline",
  [EXECUTION_STATES.RUNNING]: "codicon-play",
  [EXECUTION_STATES.PAUSING]: "codicon-debug-pause",
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
const EXECUTION_STATE_COLORS: Record<ExecutionState, string> = {
  [EXECUTION_STATES.IDLE]: "text-description-fg",
  [EXECUTION_STATES.RUNNING]: "text-charts-blue",
  [EXECUTION_STATES.PAUSING]: "text-indicator-running",
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
const EXECUTION_STATE_LABELS: Record<ExecutionState, string> = {
  [EXECUTION_STATES.IDLE]: "Ready",
  [EXECUTION_STATES.RUNNING]: "Running",
  [EXECUTION_STATES.PAUSING]: "Pausing...",
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
    state === EXECUTION_STATES.RUNNING ||
    state === EXECUTION_STATES.PAUSING ||
    state === EXECUTION_STATES.CANCELLING
  );
}

/**
 * Check if a workflow step is actively being executed by the AI.
 * Returns true for RUNNING or PAUSING (AI is processing right now).
 * Use for: step display, editor lock, animation, timer ticking.
 */
export function isWorkflowRunning(state: ExecutionState): boolean {
  return (
    state === EXECUTION_STATES.RUNNING || state === EXECUTION_STATES.PAUSING
  );
}

/**
 * Whether a step is one of the steps the backend is executing *right now*.
 *
 * `activeStepIndices` is the authoritative set and can hold several indices at
 * once (every live member of a parallel group), so it wins wherever it is
 * populated; `currentStep` is only the fallback for a run that has not
 * published one. This is deliberately the same rule `usePromptStatus` uses to
 * resolve the RUNNING *status*, and every surface that paints a running
 * affordance — step rows, a group's member rows, the collapsed chip rail —
 * must share it. When they disagreed, the step wearing the running outline was
 * the one showing a completed check.
 */
export function isStepExecuting(
  state: ExecutionState,
  index: number,
  currentStep: number,
  activeStepIndices: readonly number[]
): boolean {
  if (!isWorkflowRunning(state)) return false;
  return activeStepIndices.length > 0
    ? activeStepIndices.includes(index)
    : index === currentStep;
}

/**
 * Check if a workflow is in an active/in-progress state.
 * Returns true for RUNNING, PAUSING, or PAUSED.
 * Use for: active-workflow dropdown, prompt counters, message routing guards.
 */
export function isWorkflowActive(state: ExecutionState): boolean {
  return (
    state === EXECUTION_STATES.RUNNING ||
    state === EXECUTION_STATES.PAUSING ||
    state === EXECUTION_STATES.PAUSED
  );
}

/**
 * Check if a workflow run has finished for good.
 * Returns true for COMPLETED, ERROR, or STOPPED — the states in which a run is
 * no longer the lineage's executing run. IDLE is deliberately excluded: it is a
 * transient load/clear state, not the end of an execution.
 */
export function isExecutionFinished(state: ExecutionState): boolean {
  return (
    state === EXECUTION_STATES.COMPLETED ||
    state === EXECUTION_STATES.ERROR ||
    state === EXECUTION_STATES.STOPPED
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
    state === EXECUTION_STATES.RUNNING ||
    state === EXECUTION_STATES.PAUSING ||
    state === EXECUTION_STATES.PAUSED
  );
}

export type { WorkflowExecutionControlAction };

interface WorkflowExecutionControlSlot {
  action: WorkflowExecutionControlAction;
  label: string;
  icon: string;
  enabled: boolean;
  title: string;
  emphasized?: boolean;
}

export interface WorkflowExecutionControlsState {
  slot1: WorkflowExecutionControlSlot;
  slot2: WorkflowExecutionControlSlot;
  slot3: WorkflowExecutionControlSlot;
  isRunning: boolean;
  isPausing: boolean;
  isPaused: boolean;
  isCancelling: boolean;
}

export interface WorkflowExecutionControlsInput {
  viewedExecutionState: ExecutionState;
  viewedKind:
    | typeof WORKFLOW_VIEW_ADDRESS_KIND.DRAFT
    | typeof WORKFLOW_VIEW_ADDRESS_KIND.RUN
    | null;
  hasFile: boolean;
  hasSteps: boolean;
  pendingRewind: boolean;
  /**
   * State of the lineage's executing run when it is not the run being viewed.
   * Only an *active* value is authoritative here: callers derive it from
   * summaries that can be frozen snapshots, and a snapshot that still reads
   * "idle"/"completed" must never mask the live viewed state (see below).
   */
  executionRunState?: ExecutionState | null;
  executionRunLabel?: string | null;
  /**
   * The viewed run exists but has never executed anything: persisted IDLE,
   * still on step 0, no step or final-step status. Seeding a run and executing
   * it are separate operations (`Set start position` to the first step seeds
   * without running), so this state is reachable and its natural action is
   * Run, not Re-run — re-running would fork yet another empty run and leave
   * this one stranded. Only honored alongside `hasSteps`, so a run whose
   * definition has not arrived yet keeps the safe Re-run affordance.
   */
  viewedRunUnstarted?: boolean;
}

/**
 * Derive dashboard execution-control state from workflow runtime state.
 *
 * Keep header/button semantics here so components don't each reinterpret
 * resumable, cancellable, and restartable execution states.
 */
export function getWorkflowExecutionControls({
  viewedExecutionState,
  viewedKind,
  hasFile,
  hasSteps,
  pendingRewind,
  executionRunState,
  executionRunLabel,
  viewedRunUnstarted,
}: WorkflowExecutionControlsInput): WorkflowExecutionControlsState {
  // The executing run's state only wins while it is genuinely active. Callers
  // can only supply it from summaries, and the addressed `runSummaries`
  // snapshot is frozen at the last RUN_VIEW_LOADED — a run seeded and started
  // in one gesture leaves a summary reading "idle" for the entire run. Letting
  // that stale value win reported "nothing is executing" (disabled Pause/Stop)
  // over live PAUSING/PAUSED and suppressed the pausing banner outright.
  const executionState =
    executionRunState && isWorkflowActive(executionRunState)
      ? executionRunState
      : viewedExecutionState;
  const isRunning = executionState === EXECUTION_STATES.RUNNING;
  const isPausing = executionState === EXECUTION_STATES.PAUSING;
  const isPaused = executionState === EXECUTION_STATES.PAUSED;
  const isCancelling = executionState === EXECUTION_STATES.CANCELLING;
  const executionActive = isRunning || isPausing || isPaused || isCancelling;
  const startableRun = Boolean(viewedRunUnstarted) && hasSteps;
  const targetSuffix = executionRunLabel ? ` for ${executionRunLabel}` : "";
  const disabled = (label: string, icon: string, title: string) => ({
    action: WORKFLOW_EXECUTION_CONTROL_ACTIONS.NONE,
    label,
    icon,
    enabled: false,
    title,
  });

  if (executionActive) {
    const slot1 =
      viewedKind === WORKFLOW_VIEW_ADDRESS_KIND.DRAFT
        ? disabled(
            "Run",
            "codicon-debug-start",
            `Execution is active${targetSuffix}`
          )
        : pendingRewind
          ? disabled(
              "Continue",
              "codicon-debug-continue",
              `Execution is active${targetSuffix}`
            )
          : startableRun
            ? disabled(
                "Run",
                "codicon-debug-start",
                `Execution is active${targetSuffix}`
              )
            : disabled(
                "Re-run",
                "codicon-refresh",
                `Execution is active${targetSuffix}`
              );
    const slot2 = isPaused
      ? {
          action: WORKFLOW_EXECUTION_CONTROL_ACTIONS.RESUME,
          label: "Resume",
          icon: "codicon-debug-continue",
          enabled: true,
          title: `Resume${targetSuffix}`,
        }
      : isPausing
        ? {
            action: WORKFLOW_EXECUTION_CONTROL_ACTIONS.CANCEL_PAUSE,
            label: "Cancel pause",
            icon: "codicon-debug-pause",
            enabled: true,
            title: `Cancel pause${targetSuffix}`,
          }
        : {
            action: WORKFLOW_EXECUTION_CONTROL_ACTIONS.PAUSE,
            label: "Pause",
            icon: "codicon-debug-pause",
            enabled: isRunning,
            title: `Pause after the current step completes${targetSuffix}`,
          };
    return {
      slot1,
      slot2,
      slot3: {
        action: WORKFLOW_EXECUTION_CONTROL_ACTIONS.STOP,
        label: "Stop",
        icon: "codicon-debug-stop",
        enabled: true,
        title: `Stop${targetSuffix}`,
      },
      isRunning,
      isPausing,
      isPaused,
      isCancelling,
    };
  }

  if (
    viewedKind === null ||
    (viewedKind === WORKFLOW_VIEW_ADDRESS_KIND.DRAFT && !hasFile)
  ) {
    return {
      slot1: disabled("Run", "codicon-debug-start", "Load a workflow to run"),
      slot2: disabled("Pause", "codicon-debug-pause", "Nothing is executing"),
      slot3: disabled("Stop", "codicon-debug-stop", "Nothing is executing"),
      isRunning,
      isPausing,
      isPaused,
      isCancelling,
    };
  }

  if (viewedKind === WORKFLOW_VIEW_ADDRESS_KIND.DRAFT && !hasSteps) {
    return {
      slot1: disabled("Run", "codicon-debug-start", "Add steps to run"),
      slot2: disabled("Pause", "codicon-debug-pause", "Nothing is executing"),
      slot3: disabled("Stop", "codicon-debug-stop", "Nothing is executing"),
      isRunning,
      isPausing,
      isPaused,
      isCancelling,
    };
  }

  const slot1 =
    viewedKind === WORKFLOW_VIEW_ADDRESS_KIND.DRAFT
      ? {
          action: WORKFLOW_EXECUTION_CONTROL_ACTIONS.RUN_DRAFT,
          label: "Run",
          icon: "codicon-debug-start",
          enabled: true,
          title: "Run draft",
        }
      : pendingRewind
        ? {
            action: WORKFLOW_EXECUTION_CONTROL_ACTIONS.RESTART,
            label: "Restart",
            icon: "codicon-debug-restart",
            enabled: true,
            title:
              "Start a new run from the beginning, discarding this continuation",
          }
        : startableRun
          ? {
              action: WORKFLOW_EXECUTION_CONTROL_ACTIONS.START_RUN,
              label: "Run",
              icon: "codicon-debug-start",
              enabled: true,
              title: "Run this workflow from the beginning",
              emphasized: true,
            }
          : {
              action: WORKFLOW_EXECUTION_CONTROL_ACTIONS.RERUN,
              label: "Re-run",
              icon: "codicon-refresh",
              enabled: true,
              title: "Seed and run a new run from this definition",
              emphasized: true,
            };
  // Resume only applies outside a pending rewind: while a rewind is pending,
  // slot 2 is dedicated to Continue instead (see below).
  const resumable =
    !pendingRewind &&
    viewedKind === WORKFLOW_VIEW_ADDRESS_KIND.RUN &&
    (viewedExecutionState === EXECUTION_STATES.PAUSED ||
      viewedExecutionState === EXECUTION_STATES.STOPPED ||
      viewedExecutionState === EXECUTION_STATES.ERROR);
  return {
    slot1,
    slot2: pendingRewind
      ? {
          action: WORKFLOW_EXECUTION_CONTROL_ACTIONS.CONTINUE,
          label: "Continue",
          icon: "codicon-debug-continue",
          enabled: true,
          title: "Continue this run with the edited suffix",
          emphasized: true,
        }
      : resumable
        ? {
            action: WORKFLOW_EXECUTION_CONTROL_ACTIONS.RESUME,
            label: "Resume",
            icon: "codicon-debug-continue",
            enabled: true,
            title: "Resume this run",
          }
        : // Slot 2 is the pause/resume/continue slot. Resume/Continue are only
          // offered when this run actually has interrupted or rewound work;
          // otherwise it falls back to a disabled Pause so an idle workflow
          // reads as Run · Pause · Stop rather than advertising work that does
          // not exist.
          disabled("Pause", "codicon-debug-pause", "Nothing is executing"),
    slot3: disabled("Stop", "codicon-debug-stop", "Nothing is executing"),
    isRunning,
    isPausing,
    isPaused,
    isCancelling,
  };
}

/**
 * Execution state badge classes (background + text color)
 * Used for status badges in workflow status and recent workflows
 */
const EXECUTION_STATE_BADGE_CLASSES: Record<ExecutionState, string> = {
  [EXECUTION_STATES.IDLE]: "bg-status-idle text-white",
  [EXECUTION_STATES.RUNNING]: "bg-status-running text-white",
  [EXECUTION_STATES.PAUSING]: "bg-status-paused text-white",
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
const EXECUTION_STATE_BADGE_ICONS: Record<ExecutionState, string> = {
  [EXECUTION_STATES.IDLE]: "codicon-circle-large",
  [EXECUTION_STATES.RUNNING]: "codicon-play",
  [EXECUTION_STATES.PAUSING]: "codicon-debug-pause",
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
