import { create } from "zustand";
import {
  EXECUTION_STATES,
  STEP_STATUS,
  type ExecutionState,
  type StepStatus,
} from "../types/messages";

/**
 * Prompt item shape (matches FlightPathTypes.PromptItem)
 */
export interface PromptItem {
  id?: string;
  prompt: string;
  provider?: string;
  model?: string;
  agent?: string;
  resumeSession?: boolean;
  sessionId?: string | number;
  allowDynamicExtension?: boolean;
  endCondition?: {
    script: string;
    returns?: string;
    timeout?: number;
    maxRetries?: number;
    retryPrompt?: string;
  } | null;
  _runtime?: {
    provider?: string;
    model?: string;
    sessionId?: string;
    startedAt?: number;
    completedAt?: number;
    retryCount?: number;
    isRetry?: boolean;
  };
  // Status for UI display
  status?: StepStatus;
}

/**
 * CLI output for a step (may have multiple for retries)
 */
export interface CliOutput {
  prompt: string;
  response: string;
  structured?: unknown;
  elapsed: number;
  tokens?: { prompt: number; completion: number };
  isStreaming: boolean;
  cliCommand?: string;
  workingDirectory?: string;
}

/**
 * Retry state for a step
 */
export interface RetryState {
  currentRetry: number;
  maxRetries: number;
}

/**
 * Status message for a step
 */
export interface StatusMessage {
  message: string;
  severity: "info" | "warning" | "error";
  timestamp: number;
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

  // Step-indexed maps for outputs, retries, and messages
  cliOutputs: Record<number, CliOutput[]>;
  retryStates: Record<number, RetryState>;
  statusMessages: Record<number, StatusMessage[]>;

  // Streaming state (for incremental output)
  streamingChunks: Record<number, string>;
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

  // CLI output management
  addCliOutput: (stepIndex: number, output: CliOutput) => void;
  clearCliOutputs: (stepIndex: number) => void;
  appendStreamingChunk: (stepIndex: number, chunk: string) => void;
  clearStreamingChunk: (stepIndex: number) => void;

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
  clearStatusMessages: (stepIndex: number) => void;

  // Step status management
  setStepStatus: (stepIndex: number, status: StepStatus) => void;

  // Bulk operations
  loadWorkflow: (data: {
    fileName: string;
    workflowName?: string;
    prompts: PromptItem[];
    executionState?: ExecutionState;
    currentStep?: number;
    results?: Array<{ status?: StepStatus }>;
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
  cliOutputs: {},
  retryStates: {},
  statusMessages: {},
  streamingChunks: {},
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

  // ============================================================================
  // CLI OUTPUT MANAGEMENT
  // ============================================================================

  addCliOutput: (stepIndex, output) =>
    set((state) => ({
      cliOutputs: {
        ...state.cliOutputs,
        [stepIndex]: [...(state.cliOutputs[stepIndex] || []), output],
      },
      // Clear streaming chunk when final output arrives
      streamingChunks: {
        ...state.streamingChunks,
        [stepIndex]: "",
      },
    })),

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
      // Clear runtime state on new workflow
      cliOutputs: {},
      retryStates: {},
      statusMessages: {},
      streamingChunks: {},
    });
  },

  resetWorkflow: () => set(initialState),

  clearAllRuntimeState: () =>
    set({
      cliOutputs: {},
      retryStates: {},
      statusMessages: {},
      streamingChunks: {},
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
