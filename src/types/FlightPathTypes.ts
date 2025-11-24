import {
  EXECUTION_STATES,
  STEP_STATUS,
  ExecutionState,
  StepStatus,
} from "./DashboardConstants";
import { SupportedModel } from "./ModelConstants";

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
  id?: string; // Optional unique identifier for tracking across queue reloads
  prompt: string;
  model?: SupportedModel; // Supports all Chat models (22 total). CLI validates and falls back if unsupported.
  newChatSession?: boolean; // Whether to start a new chat session (default: true in multi-prompt workflows)
  allowDynamicExtension?: boolean; // If true, inject queue extension instructions
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
  completedIds: Set<string>; // Track completed prompt IDs and hashes
  totalExecutionTime: number; // Milliseconds of active execution time (pause-aware)
  queueExtensions: number; // How many times queue was extended
  lastReloadTime?: number; // Timestamp of last reload
  startTime?: number; // When execution started (for time tracking)
  pausedTime?: number; // When queue was paused (for pause duration calculation)
  totalPausedDuration: number; // Total time spent paused (milliseconds)
}

/**
 * Dynamic queue configuration
 */
export interface DynamicQueueConfig {
  enabled: boolean;
  dynamicExtensionOnLastPrompt: boolean;
  maxQueueSize: number; // 1-1000 (default: 100)
  maxExecutionTime: number; // In seconds (300-86400, default: 18000)
  unlimitedMode: boolean; // If true, ignore maxQueueSize AND maxExecutionTime
  notifyOnExtension: boolean;
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
