import {
  EXECUTION_STATES,
  STEP_STATUS,
  ExecutionState,
  StepStatus,
} from "./DashboardConstants";

/**
 * Copilot integration mode
 */
export enum CopilotIntegrationMode {
  CLI = "cli",
  Chat = "chat",
}

export interface PromptFile {
  prompt?: string;
  prompts?: PromptItem[];
}

export interface PromptItem {
  prompt: string;
  model?:
    | "claude-sonnet-4.5"
    | "claude-sonnet-4"
    | "claude-haiku-4.5"
    | "gpt-5";
  endCondition?: EndCondition;
}

export interface EndCondition {
  script: string;
  returns: string;
  timeout?: number;
  maxRetries?: number; // Maximum number of retry attempts (default: 0)
  retryPrompt?: string; // Template with placeholders for retry messages
}

export interface QueueState {
  currentIndex: number;
  status: ExecutionState; // Use type from DashboardConstants
  prompts: PromptItem[];
  results: PromptResult[];
  stopped: boolean; // True if stop() was called, reset on new execution
}

export interface PromptResult {
  prompt: string;
  status: StepStatus; // Use type from DashboardConstants
  timestamp: Date;
  endConditionResult?: boolean;
  error?: string;
  retryCount?: number; // Track retry attempts for this prompt
  scriptOutput?: string; // Capture last script output for debugging
}

// Re-export constants for convenience
export { EXECUTION_STATES, STEP_STATUS };
