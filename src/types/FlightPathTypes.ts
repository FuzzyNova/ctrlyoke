import {
  EXECUTION_STATES,
  STEP_STATUS,
  ExecutionState,
  StepStatus,
} from "./DashboardConstants";

/**
 * Copilot integration mode
 */
export enum Provider {
  CopilotCli = "copilot-cli", // Copilot CLI
  CopilotChat = "copilot-chat", // Copilot Chat
  ClaudeCli = "claude-cli", // Claude Code CLI
  CodexCli = "codex-cli", // Codex CLI
}

/**
 * Claude CLI status (separate from Copilot status for clarity)
 */
export type ClaudeCliStatus = "Initializing" | "Ready" | "Unavailable";

export interface PromptFile {
  prompt?: string;
  prompts?: PromptItem[];
}

/**
 * Runtime metadata for working files (optional, not required for user-created files)
 */
export interface WorkingFileRuntime {
  currentIndex: number;
  completedPrompts: string[]; // IDs and hashes of completed prompts
  executionState: ExecutionState;
}

/**
 * Working file format - same schema as PromptFile with optional runtime metadata
 * Stored in .flightpath/.queue/ directory
 */
export interface WorkingFile extends PromptFile {
  originalFile: string; // Path to original prompt file
  workflowName: string; // Derived from original filename
  startedAt: number; // Timestamp when workflow started
  lastModifiedAt?: number; // Timestamp when workflow was last modified (optional for backward compatibility)
  _runtime?: WorkingFileRuntime; // Optional runtime state (can be omitted for manual runs)
}

export interface PromptItem {
  id?: string; // Optional unique identifier for tracking across queue reloads
  prompt: string;
  provider?: Provider; // Provider to use for this prompt (overrides global setting if specified)
  model?: string; // Model ID (dynamically discovered). CLI validates and falls back if unsupported.
  agent?: string; // Custom agent name for CLI mode (e.g., 'flightpath-orchestrator'). Ignored in Chat mode.
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
  workingFilePath?: string; // Path to working file (source of truth)
  workflowName?: string; // Custom workflow name (from working file)
}

/**
 * Dynamic queue configuration
 */
export interface DynamicQueueConfig {
  enabled: boolean;
  dynamicExtensionOnLastPrompt: boolean;
  maxQueueSize: number; // 1-1000 (default: 100)
  maxWorkflowExecutionTime: number; // In seconds (-1 or 3600-604800, default: 86400)
  unlimitedMode: boolean; // If true, ignore maxQueueSize AND maxWorkflowExecutionTime
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
