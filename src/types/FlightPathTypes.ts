import {
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  STEP_STATUS,
  WORKFLOW_ATTEMPT_COMMANDS,
  ExecutionState,
  FinalStepPhase,
  StepStatus,
  type RunnerId,
  type PromptTerminalStatus,
  type WorkflowAttemptStatus,
  STEP_TYPES,
  PRIOR_CONTEXT_KEYWORDS,
  type ConditionAction,
  type CompareSource,
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
  | (typeof PRIOR_CONTEXT_KEYWORDS)[keyof typeof PRIOR_CONTEXT_KEYWORDS]
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
 *
 * Supports two transport modes — exactly one of `command` or `url` must be set:
 * - **stdio** (`command`): Spawns a local process (e.g. `npx -y @scope/server`)
 * - **remote** (`url`): Connects to a hosted HTTP/SSE endpoint (e.g. `https://mcp.example.com`)
 */
export interface McpServerConfig {
  /** Unique server identifier */
  id: string;
  /** Command to run the MCP server process (stdio servers). Required when `url` is not set. */
  command?: string;
  /** Arguments to pass to the command (stdio servers only) */
  args?: string[];
  /** Environment variables for the server process (stdio servers only) */
  env?: Record<string, string>;
  /** Tools to auto-approve: true = all tools, string[] = specific tools */
  autoApprove?: boolean | string[];
  /** Remote endpoint URL (streamable-http or SSE servers). Required when `command` is not set. */
  url?: string;
  /** Transport protocol for remote servers. Defaults to "streamable-http". */
  transport?: "streamable-http" | "sse";
  /** HTTP headers to send with every request (remote servers only, e.g. Authorization) */
  headers?: Record<string, string>;
}

/**
 * Logical hook event names — mapped to CLI-specific event names at inject time.
 *
 * | Logical name      | Claude/Qwen      | Copilot CLI        | Gemini CLI   | Codex  | OpenCode                |
 * |-------------------|------------------|--------------------|--------------|--------|-------------------------|
 * | "stop"            | Stop             | agentStop          | AfterAgent   | notify | session.status idle      |
 * | "sessionStart"    | SessionStart     | sessionStart       | SessionStart | (none) | session.created          |
 * | "preToolUse"      | PreToolUse       | preToolUse         | BeforeTool   | (none) | tool.execute.before      |
 * | "postToolUse"     | PostToolUse      | postToolUse        | AfterTool    | (none) | tool.execute.after       |
 * | "userPromptSubmit"| UserPromptSubmit | userPromptSubmitted| BeforeAgent  | (none) | (none)                   |
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

  /**
   * Pre-condition script gate that runs before the prompt.
   * - PreCondition object: Gate this prompt on a script check
   * - null: Explicitly disable workflow-level pre-condition for this prompt
   * - undefined: Inherit from workflow-level pre-condition (if configured)
   */
  preCondition?: PreCondition | null;

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
   * - null: Explicitly disable inherited overrides (use harness local config)
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
  steps?: WorkflowStep[];
  finalStep?: WorkflowStep;
  /**
   * Workflow-level variable defaults for `{{varName}}` substitution.
   * CLI `--var key=value` flags override these at runtime (highest precedence).
   * Variables are substituted in: prompt text, model, additionalArgs, hook commands,
   * and endCondition script paths before execution.
   */
  vars?: Record<string, string>;
}

/**
 * Runtime state for workflow-level finalStep execution.
 */
export interface FinalStepRuntimeState {
  phase: FinalStepPhase;
  loopCount: number;
  status?: StepStatus;
  startedAt?: number;
  completedAt?: number;
  /** Response texts from each finalStep loop execution, indexed by loopIndex (0-based).
   *  Used by priorContext "finalStepAll" and "finalStepPrevious" keywords. */
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
  finalStep?: FinalStepRuntimeState;
}

/**
 * Runtime execution fields owned by WorkflowStateMachine.
 * PromptQueue projects these onto QueueState for consumers.
 */
export interface WorkflowRuntimeState {
  status: ExecutionState;
  stopped: boolean;
  startTime?: number;
  pausedTime?: number;
  totalPausedDuration: number;
}

export type WorkflowRuntimeCommand =
  | "startExecution"
  | "pause"
  | "resume"
  | "requestStop"
  | "confirmStopped"
  | "complete"
  | "fail"
  | "reopenForContinuation";

export interface WorkflowRuntimeTransition {
  command: WorkflowRuntimeCommand;
  previous: WorkflowRuntimeState;
  current: WorkflowRuntimeState;
  timestampMs: number;
}

export type WorkflowAttemptTarget =
  | { kind: typeof FINAL_STEP_PHASES.QUEUE; stepIndex: number }
  | { kind: typeof FINAL_STEP_PHASES.FINAL_STEP; loopIndex: number };

export type { WorkflowAttemptStatus };

export interface WorkflowAttemptState {
  target: WorkflowAttemptTarget;
  attemptIndex: number;
  status: WorkflowAttemptStatus;
  startedAt: number;
  completedAt?: number;
  retryCount?: number;
  maxRetries?: number;
  failureReason?: string;
}

export type WorkflowAttemptCommand =
  (typeof WORKFLOW_ATTEMPT_COMMANDS)[keyof typeof WORKFLOW_ATTEMPT_COMMANDS];

export interface WorkflowAttemptTransition {
  command: WorkflowAttemptCommand;
  previous?: WorkflowAttemptState;
  current: WorkflowAttemptState;
  timestampMs: number;
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

/** Discriminant type for workflow steps */
export type WorkflowStepType = (typeof STEP_TYPES)[keyof typeof STEP_TYPES];

export interface PromptStep extends ExecutionProperties {
  /** Step type discriminant — defaults to "prompt" when absent */
  type?: typeof STEP_TYPES.PROMPT;
  name?: string; // Optional human-readable display label
  prompt: string;
  sessionId?: string | number; // Session ID for resuming conversations (string for CLI, number for Copilot Chat)
  _runtime?: PromptRuntimeMetadata; // Per-prompt runtime metadata
}

/**
 * Script step — runs a shell command with no AI harness interaction.
 * Shares _runtime with PromptRuntimeMetadata for startedAt/completedAt tracking.
 */
export interface ScriptStep extends ScriptProperties {
  type: typeof STEP_TYPES.SCRIPT;
  name?: string;
  /** What to do when the script passes. Default: "continue". */
  onPass?: ScriptStepAction;
  /** What to do when the script fails. Default: "stopWorkflow". */
  onFail?: ScriptStepAction;
  _runtime?: PromptRuntimeMetadata; // Reuse for startedAt/completedAt/terminalStatus
}

/** Union type for all workflow steps */
export type WorkflowStep = PromptStep | ScriptStep;

/** Type guard: returns true if the step is a ScriptStep */
export function isScriptStep(step: WorkflowStep): step is ScriptStep {
  return step.type === STEP_TYPES.SCRIPT;
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
  terminalStatus?: PromptTerminalStatus;

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
export type EndConditionCompareSource = CompareSource;

/** Action options for endCondition onPass/onFail */
export type EndConditionAction = Exclude<ConditionAction, "skipPrompt">;

/** Action options for preCondition onPass/onFail */
export type PreConditionAction = Exclude<ConditionAction, "retry">;

/** Action options for scriptStep onPass/onFail */
export type ScriptStepAction = Exclude<ConditionAction, "retry" | "skipPrompt">;

/**
 * Shared script execution properties used by endCondition, preCondition, and scriptStep.
 */
export interface ScriptProperties {
  script: string;
  /** Controls which output source is compared against `returns`. Default: `"auto"`. */
  compareSource?: EndConditionCompareSource;
  /** Expected result to compare against. When absent, exit code 0 = pass. */
  returns?: string;
  timeout?: number;
}

export interface EndCondition extends ScriptProperties {
  /** Required for endCondition: expected result to compare against. */
  returns: string;
  maxRetries?: number; // Maximum number of retry attempts (default: 0)
  retryPrompt?: string; // Template with placeholders for retry messages
  resumeSessionOnRetry?: boolean; // Resume the same session for retries (default: true). Set false to start a fresh session for each retry.
  /** What to do when the end condition passes. Default: "continue". */
  onPass?: EndConditionAction;
  /** What to do when the end condition fails. Default: "stopWorkflow". When "retry" and maxRetries unset, defaults to 1 retry. */
  onFail?: EndConditionAction;
}

/**
 * Pre-condition script gate that runs before a prompt step.
 * Determines whether to run the prompt, skip it, or stop the workflow.
 */
export interface PreCondition extends ScriptProperties {
  /** What to do when the pre-condition passes. Default: "continue" (run the prompt). */
  onPass?: PreConditionAction;
  /** What to do when the pre-condition fails. Default: "skipPrompt". */
  onFail?: PreConditionAction;
}

/**
 * Full public state of the queue, combining topology fields from PromptQueue
 * with runtime execution fields from WorkflowStateMachine.
 *
 * Consumers always receive this combined shape via PromptQueue.getState().
 * The WorkflowRuntimeState fields (status, stopped, startTime, pausedTime,
 * totalPausedDuration) are authoritative in WorkflowStateMachine and projected
 * here by spreading stateMachine.getSnapshot() last in getState().
 */
export interface QueueState extends WorkflowRuntimeState {
  currentIndex: number;
  steps: WorkflowStep[];
  results: PromptResult[];
  completedIndices: Set<string>; // Fast-lookup cache of completed prompt indices (as strings: "0", "1", ...)
  totalExecutionTime: number; // Milliseconds of active execution time (pause-aware)
  queueExtensions: number; // How many times queue was extended
  lastReloadTime?: number; // Timestamp of last reload
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
  runner: RunnerId;
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
export { EXECUTION_STATES, STEP_STATUS, STEP_TYPES };
