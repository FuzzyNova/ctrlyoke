import {
  EXECUTION_STATES,
  STEP_STATUS,
  ExecutionState,
  StepStatus,
} from "./DashboardConstants";

/**
 * Harness/Agent framework selection
 * (The AI framework/tool used for execution, not the model provider)
 */
export enum Harness {
  CopilotCli = "copilot-cli", // Copilot CLI
  CopilotChat = "copilot-chat", // Copilot Chat
  ClaudeCli = "claude-cli", // Claude Code CLI
  CodexCli = "codex-cli", // Codex CLI
}

/**
 * Claude CLI status (separate from Copilot status for clarity)
 */
export type ClaudeCliStatus = "Initializing" | "Ready" | "Unavailable";

/**
 * Shared execution properties for prompts, workflows, and runtime metadata.
 * Using this interface ensures consistency across all levels of the execution hierarchy.
 *
 * Precedence order:
 * 1. Prompt-level properties (highest priority)
 * 2. Workflow-level properties
 * 3. VS Code global settings (lowest priority/fallback)
 */
export interface ExecutionProperties {
  /** Harness/framework for execution (Copilot CLI, Claude CLI, Codex CLI, Copilot Chat) */
  harness?: Harness;

  /** AI model to use */
  model?: string;

  /** Custom agent file (.agent.md) */
  agent?: string;

  /** Resume existing chat session (default: false, start new session) */
  resumeSession?: boolean;

  /** Allow dynamic queue extension */
  allowDynamicExtension?: boolean;

  /** Session ID for resuming CLI conversations */
  sessionId?: string | number;

  /** End condition validation
   * - EndCondition object: Run validation after prompt completion
   * - null: Explicitly disable workflow-level end condition for this prompt
   * - undefined: Inherit from workflow-level end condition (if configured)
   */
  endCondition?: EndCondition | null;
}

export interface PromptFile extends ExecutionProperties {
  prompt?: string;
  prompts?: PromptItem[];
}

/**
 * Runtime metadata for working files (optional, not required for user-created files)
 * Tracks workflow execution state only - does NOT include execution properties
 * (those are tracked at workflow root and per-prompt _runtime)
 */
export interface WorkingFileRuntime {
  currentIndex: number;
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

export interface PromptItem extends ExecutionProperties {
  name?: string; // Optional human-readable display label
  prompt: string;
  sessionId?: string | number; // Session ID for resuming conversations (string for CLI, number for legacy chat)
  _runtime?: PromptRuntimeMetadata; // Per-prompt runtime metadata
}

/**
 * Optional workflow context for temp file naming and session resolution.
 * Used by CliIntegration to create meaningful temp file names.
 */
export interface WorkflowContext {
  promptIndex: number;
  allPrompts: PromptItem[];
  filePath?: string;
  workflowFile?: PromptFile;
  promptQueue?: any; // Avoid circular dependency with PromptQueue
}

/**
 * Per-prompt runtime execution metadata.
 * Tracks execution state for individual prompts within a workflow.
 */
export interface PromptRuntimeMetadata extends ExecutionProperties {
  /** Timestamp when prompt started */
  startedAt: number;

  /** Timestamp when prompt completed */
  completedAt?: number;

  /** Retry count if applicable */
  retryCount?: number;
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
  completedIds: Set<string>; // Fast-lookup cache of completed prompt indices (as strings: "0", "1", ...)
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
