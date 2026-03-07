import { create } from "zustand";
import {
  EXECUTION_STATES,
  STEP_STATUS,
  type ExecutionState,
  type StepStatus,
  type FinalPromptPhase,
  type PromptItem,
  type CliOutput,
  type RetryState,
  type StatusMessage,
} from "../types/messages";
import type {
  WorkflowOutputHistory,
  StepOutput,
} from "@root/types/OutputHistoryTypes";
import { useUiStore } from "./uiStore";
import { WebviewLog } from "@utils/logger";
import { CLI_EVENT_TYPES } from "../types/cliEvents";

/**
 * Merge incoming streaming events into an existing event array.
 * Consecutive TEXT or THINKING events of the same type (and same label) are
 * concatenated into a single event so the UI renders them as continuous text
 * instead of one React element per streaming token.
 */
function mergeStreamingEvents(existing: any[], incoming: any[]): any[] {
  const result = [...existing];
  for (const event of incoming) {
    if (event.type === CLI_EVENT_TYPES.TEXT || event.type === CLI_EVENT_TYPES.THINKING) {
      const last = result[result.length - 1];
      if (
        last &&
        last.type === event.type &&
        (event.type !== CLI_EVENT_TYPES.THINKING ||
          (last.data?.label ?? undefined) === (event.data?.label ?? undefined))
      ) {
        result[result.length - 1] = {
          ...last,
          data: { ...last.data, text: (last.data?.text || "") + (event.data?.text || "") },
        };
        continue;
      }
    }
    result.push(event);
  }
  return result;
}

/**
 * Workflow state - Core workflow execution data
 */
interface WorkflowState {
  // Core workflow data
  fileName: string | null;
  workflowName: string | null;
  prompts: PromptItem[];
  executionState: ExecutionState;
  currentStep: number;
  totalSteps: number;
  finalPrompt: PromptItem | null;
  finalPromptStatus: StepStatus | null;
  finalPromptLoopCount: number;
  finalPromptPhase: FinalPromptPhase | null;

  // Step-indexed maps for outputs, retries, and messages
  cliOutputs: Record<number, CliOutput[]>;
  finalPromptOutputs: Record<number, CliOutput[]>;
  retryStates: Record<number, RetryState>;
  statusMessages: Record<number, StatusMessage[]>;
  finalPromptStatusMessages: Record<number, StatusMessage[]>;

  // Streaming state (for incremental output)
  streamingChunks: Record<number, string>;

  // Self-contained history snapshot for the currently-viewed historical run.
  // When isViewingHistory=true (in uiStore), OutputSection renders from historyOutputs
  // instead of cliOutputs. The live cliOutputs continue to be updated normally —
  // history browsing has zero impact on live capture.
  historyOutputs: {
    stepCount: number;
    steps: Record<number, StepOutput>;
    finalPromptOutputs?: Record<number, StepOutput>;
    runMetadata: Pick<
      WorkflowOutputHistory,
      "runId" | "startedAt" | "completedAt" | "executionState"
    >;
  } | null;
}

/**
 * Workflow actions
 */
interface WorkflowActions {
  // Setters
  setFileName: (fileName: string | null) => void;
  setWorkflowName: (name: string | null) => void;
  setPrompts: (prompts: PromptItem[]) => void;
  updatePrompt: (index: number, updates: Partial<PromptItem>) => void;
  setExecutionState: (state: ExecutionState) => void;
  setCurrentStep: (step: number) => void;
  setTotalSteps: (total: number) => void;
  setFinalPrompt: (finalPrompt: PromptItem | null) => void;
  setFinalPromptStatus: (
    status: StepStatus | null,
    loopCount: number,
    phase: FinalPromptPhase | null
  ) => void;

  // CLI output management
  addCliOutput: (stepIndex: number, output: CliOutput) => void;
  addFinalPromptOutput: (loopIndex: number, output: CliOutput) => void;
  clearCliOutputs: (stepIndex: number) => void;
  appendStreamingChunk: (stepIndex: number, chunk: string) => void;
  clearStreamingChunk: (stepIndex: number) => void;
  appendStreamingEvents: (stepIndex: number, events: any[]) => void;

  // Retry management
  setRetryState: (
    stepIndex: number,
    currentRetry: number,
    maxRetries: number
  ) => void;
  clearRetryState: (stepIndex: number) => void;

  // Status message management
  addStatusMessage: (
    stepIndex: number,
    message: string,
    severity?: "info" | "warning" | "error"
  ) => void;
  addFinalPromptStatusMessage: (
    loopIndex: number,
    message: string,
    severity?: "info" | "warning" | "error"
  ) => void;
  clearStatusMessages: (stepIndex: number) => void;

  // Step status management
  setStepStatus: (stepIndex: number, status: StepStatus) => void;

  // History management
  loadHistoryRun: (
    history: WorkflowOutputHistory,
    availableRuns: number,
    runIndex: number
  ) => void;
  clearHistoryOutputs: () => void;

  // Reset execution state only — preserves all CLI outputs and run history.
  // Resets executionState→IDLE, currentStep→0, and all prompt statuses→PENDING.
  // Used by "Clear workflow state" so users can edit prompts without losing output.
  resetExecutionState: (prompts: PromptItem[]) => void;

  // Partial runtime state clear (for append-continuation runs)
  clearRuntimeStateFromStep: (startStep: number) => void;

  // Promote history snapshot data into live cliOutputs/statusMessages for preserved steps.
  // Called before switching from history→live view on a continuation run so the user
  // still sees previous prompts' output in the live panel.
  promoteHistoryToLive: (stepCount: number) => void;

  // Bulk operations
  loadWorkflow: (data: {
    fileName: string;
    workflowName?: string;
    prompts: PromptItem[];
    executionState?: ExecutionState;
    currentStep?: number;
    results?: Array<{ status?: StepStatus }>;
    finalPrompt?: PromptItem | null;
    finalPromptStatus?: StepStatus | null;
    finalPromptLoopCount?: number;
    finalPromptPhase?: FinalPromptPhase | null;
  }) => void;
  resetWorkflow: () => void;
  clearAllRuntimeState: () => void;
}

/**
 * Computed selectors (derived state)
 */
interface WorkflowSelectors {
  // Check if there are pending prompts in the queue
  hasPendingPrompts: () => boolean;
  // Get current prompt being executed
  getCurrentPrompt: () => PromptItem | null;
  // Get prompt by index
  getPromptByIndex: (index: number) => PromptItem | null;
  // Check if workflow is currently running
  isWorkflowRunning: () => boolean;
  // Check if workflow is paused
  isWorkflowPaused: () => boolean;
  // Check if workflow is stopped
  isWorkflowStopped: () => boolean;
  // Check if workflow is idle
  isWorkflowIdle: () => boolean;
  // Check if workflow is complete
  isWorkflowComplete: () => boolean;
  // Get all outputs for a step (including retries)
  getStepOutputs: (stepIndex: number) => CliOutput[];
  // Get latest output for a step
  getLatestOutput: (stepIndex: number) => CliOutput | null;
  // Check if a step has failed
  isStepFailed: (stepIndex: number) => boolean;
  // Get completed step count
  getCompletedCount: () => number;
}

const initialState: WorkflowState = {
  fileName: null,
  workflowName: null,
  prompts: [],
  executionState: EXECUTION_STATES.IDLE,
  currentStep: 0,
  totalSteps: 0,
  finalPrompt: null,
  finalPromptStatus: null,
  finalPromptLoopCount: 0,
  finalPromptPhase: null,
  cliOutputs: {},
  finalPromptOutputs: {},
  retryStates: {},
  statusMessages: {},
  finalPromptStatusMessages: {},
  streamingChunks: {},
  historyOutputs: null,
};

export const useWorkflowStore = create<
  WorkflowState & WorkflowActions & WorkflowSelectors
>((set, get) => ({
  ...initialState,

  // ============================================================================
  // SETTERS
  // ============================================================================

  setFileName: (fileName) => set({ fileName }),

  setWorkflowName: (workflowName) => set({ workflowName }),

  setPrompts: (prompts) =>
    set({
      prompts,
      totalSteps: prompts.length,
    }),

  updatePrompt: (index, updates) =>
    set((state) => ({
      prompts: state.prompts.map((p, i) =>
        i === index ? { ...p, ...updates } : p
      ),
    })),

  setExecutionState: (executionState) => set({ executionState }),

  setCurrentStep: (currentStep) => set({ currentStep }),

  setTotalSteps: (totalSteps) => set({ totalSteps }),

  setFinalPrompt: (finalPrompt) =>
    set((state) => ({
      finalPrompt,
      ...(finalPrompt
        ? {}
        : {
            finalPromptStatus: null,
            finalPromptLoopCount: 0,
            finalPromptPhase: null,
            finalPromptOutputs: {},
            finalPromptStatusMessages: {},
          }),
      prompts: state.prompts,
    })),

  setFinalPromptStatus: (status, loopCount, phase) =>
    set({
      finalPromptStatus: status,
      finalPromptLoopCount: loopCount,
      finalPromptPhase: phase,
    }),

  // ============================================================================
  // CLI OUTPUT MANAGEMENT
  // ============================================================================

  addCliOutput: (stepIndex, output) =>
    set((state) => {
      const outputs = state.cliOutputs[stepIndex] || [];
      const attemptIndex = output.attemptIndex ?? 0;
      let newOutputs: CliOutput[];

      // Guard: If no retry state exists for this step, reject phantom retries.
      // Only end conditions can trigger retries, so attemptIndex > 0 without
      // retry state means something is wrong (e.g. undisposed event listener).
      const retryState = state.retryStates[stepIndex];
      if (attemptIndex === 0 && !retryState) {
        // Initial attempt with no retry state: find and replace existing entry
        // for attemptIndex 0 (handles streaming→final replacement and any
        // accidental double-writes).
        const existingIdx = outputs.findIndex(
          (o) => (o.attemptIndex ?? 0) === 0
        );

        if (existingIdx >= 0) {
          const existing = outputs[existingIdx];

          // Preserve streamed response if final output lacks structured data
          if (
            existing.isStreaming &&
            existing.response &&
            existing.response.length > 0 &&
            !(
              output.structured &&
              (output.structured as any).events &&
              (output.structured as any).events.length > 0
            )
          ) {
            newOutputs = [
              ...outputs.slice(0, existingIdx),
              { ...output, response: existing.response },
              ...outputs.slice(existingIdx + 1),
            ];
          } else {
            newOutputs = [
              ...outputs.slice(0, existingIdx),
              output,
              ...outputs.slice(existingIdx + 1),
            ];
          }
        } else {
          // No existing entry for attempt 0 — first write
          newOutputs = [...outputs, output];
        }
      } else if (attemptIndex > 0 && !retryState) {
        // Bug: retry output without retry state — replace attempt 0 and warn.
        // This should no longer happen after the captureOutputInit fix, but
        // keep the guard for safety and add verbose logging.
        WebviewLog.warn(
          `[WorkflowStore] Received attemptIndex=${attemptIndex} for step ${stepIndex} but no retry state exists. ` +
            `Existing outputs: ${outputs.length} (attempts: ${outputs.map((o) => o.attemptIndex ?? 0).join(",")}). ` +
            `Replacing initial output (likely a bug — retryState should have been sent first).`
        );
        newOutputs = [output];
      } else {
        // Retry with valid retry state: place at the correct index
        // Find existing entry for this attemptIndex and replace, or append
        const existingIdx = outputs.findIndex(
          (o) => (o.attemptIndex ?? 0) === attemptIndex
        );

        if (existingIdx >= 0) {
          const existing = outputs[existingIdx];

          // Preserve streamed response if applicable
          if (
            existing.isStreaming &&
            existing.response &&
            existing.response.length > 0 &&
            !(
              output.structured &&
              (output.structured as any).events &&
              (output.structured as any).events.length > 0
            )
          ) {
            newOutputs = [
              ...outputs.slice(0, existingIdx),
              { ...output, response: existing.response },
              ...outputs.slice(existingIdx + 1),
            ];
          } else {
            newOutputs = [
              ...outputs.slice(0, existingIdx),
              output,
              ...outputs.slice(existingIdx + 1),
            ];
          }
          WebviewLog.debug(
            `[WorkflowStore] addCliOutput: replaced attempt ${attemptIndex} for step ${stepIndex} (${existingIdx}/${outputs.length})`
          );
        } else {
          // New retry attempt — append
          newOutputs = [...outputs, output];
          WebviewLog.debug(
            `[WorkflowStore] addCliOutput: appended attempt ${attemptIndex} for step ${stepIndex} (total: ${newOutputs.length}, retryState: ${retryState?.currentRetry}/${retryState?.maxRetries})`
          );
        }
      }

      return {
        cliOutputs: {
          ...state.cliOutputs,
          [stepIndex]: newOutputs,
        },
        // Clear streaming chunk when final output arrives
        streamingChunks: {
          ...state.streamingChunks,
          [stepIndex]: "",
        },
      };
    }),

  addFinalPromptOutput: (loopIndex, output) =>
    set((state) => {
      const outputs = state.finalPromptOutputs[loopIndex] || [];
      const attemptIndex = output.attemptIndex ?? 0;
      const existingIdx = outputs.findIndex(
        (o) => (o.attemptIndex ?? 0) === attemptIndex
      );

      const newOutputs =
        existingIdx >= 0
          ? [
              ...outputs.slice(0, existingIdx),
              output,
              ...outputs.slice(existingIdx + 1),
            ]
          : [...outputs, output];

      return {
        finalPromptOutputs: {
          ...state.finalPromptOutputs,
          [loopIndex]: newOutputs,
        },
      };
    }),

  clearCliOutputs: (stepIndex) =>
    set((state) => {
      const { [stepIndex]: _, ...rest } = state.cliOutputs;
      return { cliOutputs: rest };
    }),

  appendStreamingChunk: (stepIndex, chunk) =>
    set((state) => ({
      streamingChunks: {
        ...state.streamingChunks,
        [stepIndex]: (state.streamingChunks[stepIndex] || "") + chunk,
      },
    })),

  clearStreamingChunk: (stepIndex) =>
    set((state) => ({
      streamingChunks: {
        ...state.streamingChunks,
        [stepIndex]: "",
      },
    })),

  appendStreamingEvents: (stepIndex, events) =>
    set((state) => {
      const outputs = state.cliOutputs[stepIndex] || [];
      let newOutputs: CliOutput[];

      // Find the streaming buffer for attemptIndex 0 (streaming is always initial attempt)
      const streamingIdx = outputs.findIndex(
        (o) => o.isStreaming && (o.attemptIndex ?? 0) === 0
      );

      if (streamingIdx < 0) {
        // No streaming buffer yet — create one with explicit attemptIndex
        newOutputs = [
          ...outputs,
          {
            prompt: "",
            response: "",
            structured: { events: mergeStreamingEvents([], events), metadata: {} },
            elapsed: 0,
            isStreaming: true,
            timestampMs: Date.now(),
            attemptIndex: 0,
          },
        ];
      } else {
        // Append events to existing streaming buffer, merging consecutive text/thinking deltas
        const streamingBuffer = outputs[streamingIdx];
        const existingStructured = streamingBuffer.structured as any;
        const existingEvents = existingStructured?.events || [];

        newOutputs = [
          ...outputs.slice(0, streamingIdx),
          {
            ...streamingBuffer,
            structured: {
              ...existingStructured,
              events: mergeStreamingEvents(existingEvents, events),
              metadata: existingStructured?.metadata || {},
            },
          },
          ...outputs.slice(streamingIdx + 1),
        ];
      }

      return {
        cliOutputs: {
          ...state.cliOutputs,
          [stepIndex]: newOutputs,
        },
      };
    }),

  // ============================================================================
  // RETRY MANAGEMENT
  // ============================================================================

  setRetryState: (stepIndex, currentRetry, maxRetries) =>
    set((state) => ({
      retryStates: {
        ...state.retryStates,
        [stepIndex]: { currentRetry, maxRetries },
      },
    })),

  clearRetryState: (stepIndex) =>
    set((state) => {
      const { [stepIndex]: _, ...rest } = state.retryStates;
      return { retryStates: rest };
    }),

  // ============================================================================
  // STATUS MESSAGE MANAGEMENT
  // ============================================================================

  addStatusMessage: (stepIndex, message, severity = "info") =>
    set((state) => ({
      statusMessages: {
        ...state.statusMessages,
        [stepIndex]: [
          ...(state.statusMessages[stepIndex] || []),
          { message, severity, timestamp: Date.now() },
        ],
      },
    })),

  addFinalPromptStatusMessage: (loopIndex, message, severity = "info") =>
    set((state) => ({
      finalPromptStatusMessages: {
        ...state.finalPromptStatusMessages,
        [loopIndex]: [
          ...(state.finalPromptStatusMessages[loopIndex] || []),
          { message, severity, timestamp: Date.now() },
        ],
      },
    })),

  clearStatusMessages: (stepIndex) =>
    set((state) => {
      const { [stepIndex]: _, ...rest } = state.statusMessages;
      return { statusMessages: rest };
    }),

  // ============================================================================
  // STEP STATUS MANAGEMENT
  // ============================================================================

  setStepStatus: (stepIndex, status) =>
    set((state) => ({
      prompts: state.prompts.map((p, i) =>
        i === stepIndex ? { ...p, status } : p
      ),
    })),

  // ============================================================================
  // BULK OPERATIONS
  // ============================================================================

  loadWorkflow: ({
    fileName,
    workflowName,
    prompts,
    executionState = EXECUTION_STATES.IDLE,
    currentStep = 0,
    results = [],
    finalPrompt = null,
    finalPromptStatus = null,
    finalPromptLoopCount = 0,
    finalPromptPhase = null,
  }) => {
    // Apply status from results to prompts
    const promptsWithStatus = prompts.map((prompt, index) => ({
      ...prompt,
      status: (results[index]?.status as StepStatus) || STEP_STATUS.PENDING,
    }));

    set({
      fileName,
      workflowName: workflowName ?? null,
      prompts: promptsWithStatus,
      executionState,
      currentStep,
      totalSteps: prompts.length,
      finalPrompt,
      finalPromptStatus,
      finalPromptLoopCount,
      finalPromptPhase,
      // Clear runtime state on new workflow
      cliOutputs: {},
      finalPromptOutputs: {},
      retryStates: {},
      statusMessages: {},
      finalPromptStatusMessages: {},
      streamingChunks: {},
    });
  },

  // ============================================================================
  // HISTORY MANAGEMENT
  // ============================================================================

  loadHistoryRun: (history, availableRuns, runIndex) =>
    set(() => {
      // Update uiStore for history view state
      useUiStore.getState().setHistoryView(runIndex, availableRuns);

      // Populate self-contained history snapshot
      return {
        historyOutputs: {
          stepCount: history.runStepCount,
          steps: history.promptOutputs,
          finalPromptOutputs: history.finalPromptOutputs,
          runMetadata: {
            runId: history.runId,
            startedAt: history.startedAt,
            completedAt: history.completedAt,
            executionState: history.executionState,
          },
        },
      };
    }),

  clearHistoryOutputs: () => set(() => ({ historyOutputs: null })),

  resetExecutionState: (prompts) =>
    set(() => ({
      prompts: prompts.map((p) => ({ ...p, status: STEP_STATUS.PENDING })),
      totalSteps: prompts.length,
      executionState: EXECUTION_STATES.IDLE,
      currentStep: 0,
      // cliOutputs, retryStates, statusMessages, streamingChunks, historyOutputs
      // are intentionally preserved so the run history and output panel are unaffected.
    })),

  clearRuntimeStateFromStep: (startStep) =>
    set((state) => {
      const newCliOutputs = { ...state.cliOutputs };
      const newRetryStates = { ...state.retryStates };
      const newStatusMessages = { ...state.statusMessages };
      const newStreamingChunks = { ...state.streamingChunks };

      Object.keys(newCliOutputs).forEach((key) => {
        if (Number(key) >= startStep) {
          delete newCliOutputs[Number(key)];
        }
      });
      Object.keys(newRetryStates).forEach((key) => {
        if (Number(key) >= startStep) {
          delete newRetryStates[Number(key)];
        }
      });
      Object.keys(newStatusMessages).forEach((key) => {
        if (Number(key) >= startStep) {
          delete newStatusMessages[Number(key)];
        }
      });
      Object.keys(newStreamingChunks).forEach((key) => {
        if (Number(key) >= startStep) {
          delete newStreamingChunks[Number(key)];
        }
      });

      return {
        cliOutputs: newCliOutputs,
        retryStates: newRetryStates,
        statusMessages: newStatusMessages,
        streamingChunks: newStreamingChunks,
        finalPromptOutputs: {},
        finalPromptStatusMessages: {},
        finalPromptStatus: null,
        finalPromptLoopCount: 0,
        finalPromptPhase: null,
      };
    }),

  promoteHistoryToLive: (stepCount) =>
    set((state) => {
      if (!state.historyOutputs) {
        WebviewLog.debug(
          `[WorkflowStore] promoteHistoryToLive(${stepCount}): no historyOutputs, nothing to promote`
        );
        return {};
      }

      const newCliOutputs = { ...state.cliOutputs };
      const newStatusMessages = { ...state.statusMessages };
      let promoted = 0;

      for (let i = 0; i < stepCount; i++) {
        const stepData = state.historyOutputs.steps[i];
        if (stepData) {
          // Only populate if live data is missing for this step
          if (!newCliOutputs[i] || newCliOutputs[i].length === 0) {
            newCliOutputs[i] = stepData.cliOutputs;
            promoted++;
          }
          if (!newStatusMessages[i] || newStatusMessages[i].length === 0) {
            newStatusMessages[i] = stepData.statusMessages;
          }
        }
      }

      WebviewLog.debug(
        `[WorkflowStore] promoteHistoryToLive(${stepCount}): promoted ${promoted} step(s) from history into live cliOutputs`
      );
      return { cliOutputs: newCliOutputs, statusMessages: newStatusMessages };
    }),

  resetWorkflow: () => set(initialState),

  clearAllRuntimeState: () =>
    set({
      cliOutputs: {},
      finalPromptOutputs: {},
      retryStates: {},
      statusMessages: {},
      finalPromptStatusMessages: {},
      streamingChunks: {},
      finalPromptStatus: null,
      finalPromptLoopCount: 0,
      finalPromptPhase: null,
    }),

  // ============================================================================
  // COMPUTED SELECTORS
  // ============================================================================

  /**
   * Check if there are pending prompts in the queue.
   * Returns true if there are prompts that haven't been executed yet.
   * Used to determine whether Run button should say "Run" or "Run Next".
   */
  hasPendingPrompts: () => {
    const { prompts, executionState, currentStep, totalSteps } = get();

    if (prompts.length === 0) {
      return false;
    }

    // If we're idle, check if this is a fresh workflow or resumed workflow
    if (executionState === EXECUTION_STATES.IDLE) {
      // Fresh workflow (not started yet) - no pending prompts, just "Run"
      if (currentStep === 0) {
        return false;
      }
      // Resumed workflow (some prompts completed) - has pending prompts, show "Run Next"
      return currentStep < totalSteps;
    }

    // If stopped, there are pending prompts (current was cancelled, may have more after)
    if (executionState === EXECUTION_STATES.STOPPED) {
      return currentStep < totalSteps;
    }

    // If running/paused, check if there are prompts after current step
    if (
      executionState === EXECUTION_STATES.RUNNING ||
      executionState === EXECUTION_STATES.PAUSED
    ) {
      return currentStep < totalSteps;
    }

    // If completed, no pending prompts
    return false;
  },

  getCurrentPrompt: () => {
    const { prompts, currentStep } = get();
    if (currentStep >= 0 && currentStep < prompts.length) {
      return prompts[currentStep];
    }
    return null;
  },

  getPromptByIndex: (index) => {
    const { prompts } = get();
    if (index >= 0 && index < prompts.length) {
      return prompts[index];
    }
    return null;
  },

  isWorkflowRunning: () => get().executionState === EXECUTION_STATES.RUNNING,

  isWorkflowPaused: () => get().executionState === EXECUTION_STATES.PAUSED,

  isWorkflowStopped: () => get().executionState === EXECUTION_STATES.STOPPED,

  isWorkflowIdle: () => get().executionState === EXECUTION_STATES.IDLE,

  isWorkflowComplete: () => get().executionState === EXECUTION_STATES.COMPLETED,

  getStepOutputs: (stepIndex) => get().cliOutputs[stepIndex] || [],

  getLatestOutput: (stepIndex) => {
    const outputs = get().cliOutputs[stepIndex];
    if (outputs && outputs.length > 0) {
      return outputs[outputs.length - 1];
    }
    return null;
  },

  isStepFailed: (stepIndex) => {
    const { prompts } = get();
    const prompt = prompts[stepIndex];
    return prompt?.status === STEP_STATUS.FAILED;
  },

  getCompletedCount: () => {
    const { prompts } = get();
    return prompts.filter((p) => p.status === STEP_STATUS.COMPLETED).length;
  },
}));

// Re-export types for convenience (imported from consolidated sources)
export type {
  PromptItem,
  CliOutput,
  RetryState,
  StatusMessage,
} from "../types/messages";
