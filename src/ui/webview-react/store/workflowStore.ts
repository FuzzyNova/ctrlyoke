import { create } from "zustand";

interface WorkflowState {
  fileName: string | null;
  workflowName: string | null;
  prompts: any[];
  executionState: "idle" | "running" | "paused" | "completed" | "error";
  currentStep: number;
  totalSteps: number;
  cliOutputs: Record<number, string[]>;
  retryStates: Record<number, { currentRetry: number; maxRetries: number }>;
  statusMessages: Record<number, string[]>;

  setFileName: (fileName: string | null) => void;
  setWorkflowName: (name: string | null) => void;
  setPrompts: (prompts: any[]) => void;
  updatePrompt: (index: number, updates: any) => void;
  setExecutionState: (state: any) => void;
  setCurrentStep: (step: number) => void;
  addCliOutput: (stepIndex: number, output: string) => void;
  setRetryState: (
    stepIndex: number,
    currentRetry: number,
    maxRetries: number
  ) => void;
  addStatusMessage: (stepIndex: number, message: string) => void;
  resetWorkflow: () => void;
}

export const useWorkflowStore = create<WorkflowState>((set) => ({
  fileName: null,
  workflowName: null,
  prompts: [],
  executionState: "idle",
  currentStep: 0,
  totalSteps: 0,
  cliOutputs: {},
  retryStates: {},
  statusMessages: {},

  setFileName: (fileName) => set({ fileName }),
  setWorkflowName: (workflowName) => set({ workflowName }),
  setPrompts: (prompts) => set({ prompts, totalSteps: prompts.length }),

  updatePrompt: (index, updates) =>
    set((state) => ({
      prompts: state.prompts.map((p, i) =>
        i === index ? { ...p, ...updates } : p
      ),
    })),

  setExecutionState: (executionState) => set({ executionState }),
  setCurrentStep: (currentStep) => set({ currentStep }),

  addCliOutput: (stepIndex, output) =>
    set((state) => ({
      cliOutputs: {
        ...state.cliOutputs,
        [stepIndex]: [...(state.cliOutputs[stepIndex] || []), output],
      },
    })),

  setRetryState: (stepIndex, currentRetry, maxRetries) =>
    set((state) => ({
      retryStates: {
        ...state.retryStates,
        [stepIndex]: { currentRetry, maxRetries },
      },
    })),

  addStatusMessage: (stepIndex, message) =>
    set((state) => ({
      statusMessages: {
        ...state.statusMessages,
        [stepIndex]: [...(state.statusMessages[stepIndex] || []), message],
      },
    })),

  resetWorkflow: () =>
    set({
      fileName: null,
      workflowName: null,
      prompts: [],
      executionState: "idle",
      currentStep: 0,
      totalSteps: 0,
      cliOutputs: {},
      retryStates: {},
      statusMessages: {},
    }),
}));
