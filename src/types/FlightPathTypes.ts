import {
  EXECUTION_STATES,
  STEP_STATUS,
  ExecutionState,
  FinalPromptPhase,
  StepStatus,
  type RunnerId,
} from "./DashboardConstants";
import { ToolPermissionMode } from "../flightpath/harness/shared/interfaces/IToolPermissionMapper";
export type { ToolPermissionMode };

/**
 * Controls which prior prompt outputs are injected into the current prompt as context.
 *
 * - "all": Inject all previously-completed prompt outputs
 * - "previous": Inject only the immediately preceding prompt's output
 * - "none": Explicit no-op (same as omitting the field)
 * - number[]: Inject specific prompt outputs by 1-based prompt number (e.g., [1, 3])
 *
 * Context is injected as an XML block before the user's prompt text.
 * Note: When used with resumeSession:true, context may be duplicated — this is accepted behavior.
 */
export type PriorContext =
  | "all"
  | "previous"
  | "none"
  | "finalPromptAll"
  | "finalPromptPrevious"
  | number[];

/**
 * Harness/Agent framework selection
 * (The AI framework/tool used for execution, not the model provider)
 */
export enum Harness {
  CopilotCli = "copilot-cli", // Copilot CLI
  CopilotChat = "copilot-chat", // Copilot Chat
  ClaudeCli = "claude-cli", // Claude Code CLI
  CodexCli = "codex-cli", // Codex CLI
  OpenCodeCli = "opencode-cli", // OpenCode CLI
  QwenCli = "qwen-cli", // Qwen Code CLI
  GeminiCli = "gemini-cli", // Gemini CLI
}

/**
 * User-defined MCP server configuration for attaching external MCP servers to harness invocations.
 */
export interface McpServerConfig {
  /** Unique server identifier */
  id: string;
  /** Command to run the MCP server (e.g., "node", "python") */
  command: string;
  /** Arguments to pass to the command */
  args?: string[];
  /** Environment variables for the server process */
  env?: Record<string, string>;
  /** Tools to auto-approve: true = all tools, string[] = specific tools */
  autoApprove?: boolean | string[];
}

/**
 * Logical hook event names — mapped to CLI-specific event names at inject time.
 *
 * | Logical name      | Claude/Qwen      | Copilot CLI  | Gemini CLI   | Codex  | OpenCode                |
 * |-------------------|------------------|--------------|--------------|--------|-------------------------|
 * | "stop"            | Stop             | sessionEnd   | AfterAgent   | notify | session.status idle     |
 * | "sessionStart"    | SessionStart     | sessionStart | SessionStart | (none) | session.created         |
 * | "preToolUse"      | PreToolUse       | (none)       | (none)       | (none) | (unknown)               |
 * | "postToolUse"     | PostToolUse      | (none)       | (none)       | (none) | (unknown)               |
 * | "userPromptSubmit"| UserPromptSubmit | (none)       | (none)       | (none) | (none)                  |
 */
export type HookEvent =
  | "stop"
  | "sessionStart"
  | "preToolUse"
  | "postToolUse"
  | "userPromptSubmit";

/**
 * A user-defined hook to run alongside FlightPath's built-in hooks.
 */
export interface UserHookConfig {
  /** Logical hook event name. Unsupported events for the active harness are silently skipped. */
  event: HookEvent;
  /** Command to run. Resolved relative to workspace root if not absolute. */
  command: string;
  /** Optional timeout in seconds (only respected by CLIs that support per-hook timeouts). */
  timeoutSec?: number;
}

/**
 * Per-workflow/prompt tool permission overrides.
 * Follows three-tier precedence: prompt > workflow > global VS Code settings.
 * Only applies to CLI harnesses.
 */
export interface ToolPermissionsOverride {
  /** Permission mode override. Falls back to global if omitted. */
  mode?: ToolPermissionMode;
  /** Tool patterns to allow (used in custom mode). Uses Copilot CLI format — auto-converted for Claude/Qwen. */
  allowedTools?: string[];
  /** Tool patterns to deny (takes precedence over allow list). */
  deniedTools?: string[];
}

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

  /**
   * Custom agent file (.agent.md).
   * - string: explicit agent override
   * - null: explicitly disable inherited agent
   * - undefined: inherit from workflow/settings
   */
  agent?: string | null;

  /**
   * Skills to attach (frontmatter-only progressive disclosure via <skillInstructions>).
   * - string[]: explicit skill selection
   * - null: explicitly disable inherited skills
   * - undefined: inherit from workflow/settings
   */
  skills?: string[] | null;

  /** Resume existing chat session (default: false, start new session) */
  resumeSession?: boolean;

  /**
   * MCP servers to attach for this prompt/workflow.
   * - string[]: server IDs (e.g., "flightpath") or McpServerConfig objects
   * - null: explicitly disable inherited MCP servers
   * - undefined: inherit from workflow/settings
   *
   * Include "flightpath" to enable dynamic queue extension via FlightPath's MCP server.
   */
  mcpServers?: (string | McpServerConfig)[] | null;

  /** Session ID for resuming CLI conversations */
  sessionId?: string | number;

  /** End condition validation
   * - EndCondition object: Run validation after prompt completion
   * - null: Explicitly disable workflow-level end condition for this prompt
   * - undefined: Inherit from workflow-level end condition (if configured)
   */
  endCondition?: EndCondition | null;

  /** Controls injection of prior prompt outputs into this prompt's text.
   *  See PriorContext type for valid values. Omitting the field = no injection. */
  priorContext?: PriorContext;

  /** Extra CLI flags appended to FlightPath's standard argument set.
   * FlightPath continues to manage model, permissions, workspace dirs, and session flags normally.
   * Tokens are injected before the tool permission args. Applies only to CLI harnesses; ignored for copilot-chat.
   * Example: "--effort high --max-turns 10"
   *
   * - string: Use these additional args (overrides workflow and settings)
   * - null: Explicitly disable additional args (even if workflow/settings define some)
   * - undefined: Inherit from workflow, then settings
   */
  additionalArgs?: string | null;

  /**
   * Tool permission overrides for this prompt/workflow.
   * - object: Override tool permissions (mode, allowedTools, deniedTools)
   * - null: Explicitly disable inherited overrides (passthrough to harness local config)
   * - undefined: Inherit from workflow/settings
   */
  toolPermissions?: ToolPermissionsOverride | null;

  /**
   * User-defined hooks to run alongside FlightPath's completion-detection hooks.
   * Supported events vary by harness; unsupported events are silently ignored.
   * - undefined: inherit from workflow/settings
   * - null or []: explicitly no hooks
   * - [...]: per-event override from the tier below
   */
  hooks?: UserHookConfig[] | null;
}

export interface PromptFile extends ExecutionProperties {
  prompt?: string;
  prompts?: PromptItem[];
  finalPrompt?: PromptItem;
}

/**
 * Runtime state for workflow-level finalPrompt execution.
 */
export interface FinalPromptRuntimeState {
  phase: FinalPromptPhase;
  loopCount: number;
  status?: StepStatus;
  startedAt?: number;
  completedAt?: number;
  /** Response texts from each finalPrompt loop execution, indexed by loopIndex (0-based).
   *  Used by priorContext "finalPromptAll" and "finalPromptPrevious" keywords. */
  responseTexts?: string[];
}

/**
 * Runtime metadata for working files (optional, not required for user-created files)
 * Tracks workflow execution state only - does NOT include execution properties
 * (those are tracked at workflow root and per-prompt _runtime)
 */
export interface WorkingFileRuntime {
  currentIndex: number;
  executionState: ExecutionState;
  finalPrompt?: FinalPromptRuntimeState;
}

/**
 * Working file format - same schema as PromptFile with optional runtime metadata
 * Stored in .flightpath/.queue/ directory
 */
export interface WorkingFile extends PromptFile {
  originalFile?: string; // Path to original prompt file (undefined for ephemeral/dashboard-created workflows)
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
 * Per-prompt runtime execution metadata.
 * Tracks execution state for individual prompts within a workflow.
 */
export interface PromptRuntimeMetadata extends ExecutionProperties {
  /** Timestamp when prompt started */
  startedAt: number;

  /** Timestamp when prompt completed (set for all terminal states, not just successful completion) */
  completedAt?: number;

  /**
   * Terminal state of this prompt. Absent or 'completed' means successful completion.
   * Used to restore the correct visual status after a working file reload.
   */
  terminalStatus?: "completed" | "cancelled" | "failed";

  /** Retry count if applicable */
  retryCount?: number;

  /** The plain-text AI response from this prompt's execution.
   *  Stored here to enable priorContext injection in subsequent prompts.
   *  Also persists across pause/resume cycles via the working file. */
  responseText?: string;
}

/**
 * Controls which output source is compared against `returns`.
 *
 * - `"auto"` (default): `"true"`/`"false"` use exit code; all other values compare stdout.
 * - `"stdout"`: Always compare stdout. Requires a clean exit (exitCode === 0).
 * - `"stderr"`: Compare stderr content. Exit code is not checked.
 * - `"exitCode"`: Compare the numeric exit code. Use `"0"` for success, or any integer string.
 *   `"true"`/`"false"` are also accepted and map to exit 0 / non-zero.
 */
export type EndConditionCompareSource = "auto" | "stdout" | "stderr" | "exitCode";

export interface EndCondition {
  script: string;
  returns: string;
  /** Controls which output source is compared against `returns`. Default: `"auto"`. */
  compareSource?: EndConditionCompareSource;
  timeout?: number;
  maxRetries?: number; // Maximum number of retry attempts (default: 0)
  retryPrompt?: string; // Template with placeholders for retry messages
  resumeSessionOnRetry?: boolean; // Resume the same session for retries (default: true). Set false to start a fresh session for each retry.
}

export interface QueueState {
  currentIndex: number;
  status: ExecutionState; // Use type from DashboardConstants
  prompts: PromptItem[];
  results: PromptResult[];
  stopped: boolean; // True if stop() was called, reset on new execution
  completedIndices: Set<string>; // Fast-lookup cache of completed prompt indices (as strings: "0", "1", ...)
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

/**
 * Summary of a workflow instance — used by WorkflowOrchestrator to expose
 * lightweight status information without leaking the full WorkflowInstance.
 */
export interface WorkflowSummary {
  id: string;
  workflowName: string;
  filePath: string;
  workingFilePath?: string; // Path to .flightpath.json working file (for dedup with recent workflows list)
  executionState: ExecutionState;
  /** 0-indexed: index of the next prompt to execute (mirrors PromptQueue.state.currentIndex) */
  currentStep: number;
  totalSteps: number;
  startedAt?: number;
  completedAt?: number;
  /** Set to "cli" when the workflow is being executed by the FlightPath CLI. Undefined means vscode-managed. */
  managedBy?: RunnerId;
}

/** Returns the 1-indexed step number for display (logs, UI labels). currentStep is 0-indexed internally. */
export const workflowDisplayStep = (
  s: Pick<WorkflowSummary, "currentStep">
): number => s.currentStep + 1;

/**
 * Process lock file written alongside the working file while a workflow is running.
 * Enables the VS Code extension and CLI to coexist without stomping on each other's state.
 * Lock file path: {queueDir}/{workflowId}.runner.json
 */
export interface WorkflowRunnerLock {
  /** Which runner created this lock */
  runner: import("./DashboardConstants").RunnerId;
  /** OS process ID of the runner (Extension Host PID for vscode, CLI process PID for cli) */
  pid: number;
  /** Unix ms timestamp when execution started */
  startedAt: number;
  /** Unix ms timestamp updated every 5s while running — guards against PID recycling */
  lastHeartbeat: number;
  /** UUID generated once at extension activation (vscode) or CLI startup (cli) */
  instanceId: string;
  /** WorkflowInstance.id — matches the workflowId portion of the working file name */
  workflowId: string;
}

// Re-export constants for convenience
export { EXECUTION_STATES, STEP_STATUS };
