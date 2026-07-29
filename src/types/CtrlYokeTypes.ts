import {
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  STEP_TYPES,
  WORKFLOW_ATTEMPT_COMMANDS,
  ExecutionState,
  FinalStepPhase,
  StepStatus,
  type RunnerId,
  type PromptTerminalStatus,
  type WorkflowAttemptStatus,
  PRIOR_CONTEXT_KEYWORDS,
  type ConditionAction,
  type CompareSource,
  type HarnessId,
  type ExecutionMode,
  type HookEvent,
  type FailureKind,
} from "./DashboardConstants";
export type { HarnessId, HookEvent, FailureKind };
import { ToolPermissionMode } from "../core/harness/shared/interfaces/IToolPermissionMapper";
export type { ToolPermissionMode };

/**
 * Controls which prior prompt outputs are injected into the current prompt as context.
 *
 * - "all": Inject all previously-completed prompt outputs
 * - "previous": Inject only the immediately preceding prompt's output
 * - "none": Explicit no-op (same as omitting the field)
 * - number[]: Inject specific prompt outputs by 1-based prompt number (e.g., [1, 3])
 * - WorkflowRunAddress: Inject the complete, terminal timeline of an explicitly
 *   addressed run in this workspace. Addresses intentionally contain no path.
 *
 * Context is injected as an XML block before the user's prompt text.
 * Note: When used with resumeSession:true, context may be duplicated — this is accepted behavior.
 */
export type PriorContext =
  | (typeof PRIOR_CONTEXT_KEYWORDS)[keyof typeof PRIOR_CONTEXT_KEYWORDS]
  | number[]
  | WorkflowRunAddress;

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
  /**
   * Human-readable description, shown in the MCP manager UI. ctrlyoke-only
   * metadata — deliberately omitted by every harness export path so it never
   * leaks an unrecognized key into external tools' native config files.
   */
  description?: string;
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
  /**
   * Tool names from this server to deny at execution time.
   * Use bare tool names without the `mcp__serverid__` prefix (e.g. `["ctrlyoke_append_queue"]`).
   * Translated to `mcp__<id>__<tool>` deny patterns and merged into the harness permission args.
   * Supported on harnesses that accept tool deny patterns (e.g. Claude CLI `--disallowedTools`).
   */
  deniedTools?: string[];
}

/**
 * A user-defined hook to run alongside ctrlyoke's built-in hooks.
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

export type ErrorBehaviorAction = "stop" | "retry" | "continue";

/** Policy for internal errors in any step phase: pre-condition, prompt/harness, end-condition, or script execution. */
export interface ErrorBehavior {
  onError: ErrorBehaviorAction;
  maxRetries?: number;
  retryDelayMs?: number;
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
  /** Harness/framework for execution (Copilot CLI, Claude CLI, Codex CLI, etc.) */
  harness?: HarnessId;

  /** AI model to use */
  model?: string;

  /**
   * Where this step runs.
   * - "interactive": live PTY/TUI — user can steer and answer questions
   * - "headless": background child process — output in the Output panel
   * - undefined: inherit from workflow, then settings (defaults.executionMode)
   *
   * Not nullable: there is no "no mode" state, so the tri-state null pattern
   * used by agent/skills/additionalArgs does not apply.
   */
  executionMode?: ExecutionMode;

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
   * - string[]: server IDs (e.g., "ctrlyoke") or McpServerConfig objects
   * - null: explicitly disable inherited MCP servers
   * - undefined: inherit from workflow/settings
   *
   * Include "ctrlyoke" to enable dynamic queue extension via ctrlyoke's MCP server.
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

  /** Extra CLI flags appended to ctrlyoke's standard argument set.
   * ctrlyoke continues to manage model, permissions, workspace dirs, and session flags normally.
   * Tokens are injected before the tool permission args. Applies only to CLI harnesses.
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
   * Internal-error policy for every phase of the step: pre-condition,
   * harness/prompt, end-condition, and script execution.
   * - object: override the workflow/settings policy
   * - null: explicitly disable inherited errorBehavior
   * - undefined: inherit from workflow/settings
   */
  errorBehavior?: ErrorBehavior | null;

  /**
   * User-defined hooks to run alongside ctrlyoke's completion-detection hooks.
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
}

/**
 * Stable identity for a workflow lineage directory: `.ctrlyoke/.runs/<workflowKey>/`.
 * A sanitized name plus creation timestamp, minted once by `WorkflowLineageRepository`
 * and never re-derived from a mutable file path. Opaque — always go through
 * `WorkflowPaths`/`WorkflowLineageRepository` to mint or validate one.
 */
export type WorkflowKey = string & { readonly __workflowKey: unique symbol };

/**
 * Stable identity for one promoted run directory: `.ctrlyoke/.runs/<workflowKey>/run-<ts>/`.
 * The run directory name itself (`run-<UTC-ms-timestamp>`). Opaque — always go through
 * `WorkflowPaths`/`WorkflowLineageRepository` to mint or validate one.
 */
export type RunRef = string & { readonly __runRef: unique symbol };

/** A client's addressed view into a lineage: either the mutable draft or one promoted run. */
export type WorkflowViewAddress =
  | { workflowKey: WorkflowKey; kind: "draft" }
  | { workflowKey: WorkflowKey; kind: "run"; runRef: RunRef };

/** Addresses exactly one promoted run within a lineage. */
export interface WorkflowRunAddress {
  workflowKey: WorkflowKey;
  runRef: RunRef;
}

/** True when a persisted prior-context value addresses one promoted run. */
export function isWorkflowRunAddress(
  value: PriorContext | undefined
): value is WorkflowRunAddress {
  return (
    !!value &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    typeof value.workflowKey === "string" &&
    typeof value.runRef === "string"
  );
}

/**
 * Authoritative lineage metadata and allocation state, persisted at
 * `.ctrlyoke/.runs/<workflowKey>/workflow.json`. `WorkflowLineageRepository` is the only writer.
 */
export interface WorkflowLineageDescriptor {
  schemaVersion: number;
  workflowKey: WorkflowKey;
  workflowName: string;
  /** Path to the source prompt file, if any (undefined for ephemeral/dashboard-created lineages). */
  originalFile?: string;
  isFavorite: boolean;
  createdAt: number;
  lastModifiedAt: number;
  /** Repairable hint, not the storage source of truth — validate against manifests before trusting. */
  latestRunRef?: RunRef;
  /** Monotonic; never decremented after deletion. */
  nextRunId: number;
  /**
   * The lineage's one mutable preparation target. Always `undefined` through phase 1 —
   * draft/rewind editing is introduced in phase 3.
   */
  pendingEdit?:
    | { kind: "draft" }
    | {
        kind: "rewind";
        runRef: RunRef;
        fromStepIndex: number;
        baseDefinitionRevision: number;
      };
  /** Optimistic-concurrency counter for descriptor metadata/allocation changes. */
  revision: number;
}

/**
 * Runtime metadata for working files (optional, not required for user-created files)
 * Tracks workflow execution state only - does NOT include execution properties
 * (those are tracked at workflow root and per-prompt _runtime)
 */
export interface WorkingFileRuntime {
  currentIndex: number;
  executionState: ExecutionState;
  /** Wall-clock timestamp when active execution timing began. */
  startTime?: number;
  /** Wall-clock timestamp when the current pause began. */
  pausedTime?: number;
  /** Accumulated time spent paused before the current pause, in milliseconds. */
  totalPausedDuration?: number;
  /** Wall-clock timestamp when execution reached a terminal state. */
  executionEndTime?: number;
  finalStep?: FinalStepRuntimeState;
  /**
   * Durable marker for an in-place, nonzero rewind. The full pre-rewind file is
   * kept beside the run until the continuation is committed or discarded.
   */
  pendingRewind?: {
    fromStepIndex: number;
    baseDefinitionRevision: number;
  };
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
  executionEndTime?: number;
}

export type WorkflowRuntimeCommand =
  | "startExecution"
  | "pause"
  | "confirmPaused"
  | "cancelPause"
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
 * Working file format - same schema as PromptFile with optional runtime metadata.
 * Stored at `.ctrlyoke/.runs/<workflowKey>/{draft,run-<ts>}/workflow.ctrlyoke.json`.
 */
export interface WorkingFile extends PromptFile {
  originalFile?: string; // Path to original prompt file (undefined for ephemeral/dashboard-created workflows)
  workflowName: string; // Derived from original filename
  startedAt: number; // Timestamp when workflow started
  lastModifiedAt?: number; // Timestamp when workflow was last modified (optional for backward compatibility)
  isFavorite?: boolean; // Whether the workflow should be pinned to the top of recent workflow history
  /**
   * Monotonic counter bumped in-memory by `PromptQueue` on every definition-changing
   * mutation (append/insert/replace/delete/reorder/property edit, or a rewind's suffix
   * edit — phase 3) and serialized by `WorkingFileManager`. Not bumped for pure runtime
   * persistence. Starts at 1; a promoted run restarts its own sequence at 1.
   * `OutputHistoryManager`/`TimelineRecorder` commit a `DEFINITION_REVISION_COMMITTED`
   * snapshot before a revision's first output and tag `CLI_OUTPUT_RECORDED` events with
   * the revision that produced them (revision 1 itself is not re-committed as an event —
   * the run's own `workflow.ctrlyoke.json`, written at promotion, already is that record).
   */
  definitionRevision: number;
  _runtime?: WorkingFileRuntime; // Optional runtime state (can be omitted for manual runs)
}

/** Discriminant type for workflow steps */
export type WorkflowStepType = (typeof STEP_TYPES)[keyof typeof STEP_TYPES];

export interface PromptStep extends ExecutionProperties {
  /** Step type discriminant — defaults to "prompt" when absent */
  type?: typeof STEP_TYPES.PROMPT;
  name?: string; // Optional human-readable display label
  /** When false, the step remains in the workflow but never executes. */
  enabled?: boolean;
  prompt: string;
  sessionId?: string | number; // Session ID for resuming conversations (string session ID, or number = resume from that prompt index)
  _runtime?: PromptRuntimeMetadata; // Per-prompt runtime metadata
}

/**
 * Script step — runs a shell command with no AI harness interaction.
 * Shares _runtime with PromptRuntimeMetadata for startedAt/completedAt tracking.
 */
export interface ScriptStep extends ScriptProperties {
  type: typeof STEP_TYPES.SCRIPT;
  name?: string;
  /** Execution mode for this script step; undefined inherits from settings. */
  executionMode?: ExecutionMode;
  /** When false, the step remains in the workflow but never executes. */
  enabled?: boolean;
  /** Internal-error policy; undefined inherits the workflow policy. */
  errorBehavior?: ErrorBehavior | null;
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
 * True when a workflow has something to execute. A `finalStep` counts as a
 * step: a final-step-only workflow (empty `steps`, orchestrating `finalStep`)
 * is a valid, supported shape — the final step appends the queue at runtime via
 * `ctrlyoke_append_queue`. See the Spec-Driven Loop template. Anything that
 * gates loading, validation, or execution on "does this workflow have work"
 * must use this rather than checking `steps.length` alone.
 */
export function hasExecutableSteps(workflow: {
  steps?: WorkflowStep[] | null;
  finalStep?: WorkflowStep | null;
}): boolean {
  return Boolean(workflow.steps?.length) || Boolean(workflow.finalStep);
}

/**
 * Script execution output captured from a ScriptStep run.
 * Stored in PromptRuntimeMetadata to enable priorContext injection for script steps.
 */
export interface ScriptRuntimeOutput {
  /** The script command that was run */
  command: string;
  stdout: string;
  stderr: string;
  exitCode?: number;
}

export type ScriptMatchRule =
  | "exitCode"
  | "exact"
  | "boolean"
  | "numericGte"
  | "substring"
  | "none";

export interface ScriptVerdict {
  compareSource: CompareSource;
  expected?: string;
  actual: string;
  actualSource: "stdout" | "stderr" | "exitCode";
  exitCode?: number;
  outcome: "passed" | "failed" | "errored";
  matchRule: ScriptMatchRule;
  action: ConditionAction;
  actionDetail?: string;
  durationMs: number;
  timedOut?: boolean;
  error?: string;
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

  /** Session ID associated with the completed prompt output. */
  sessionId?: string;

  /** Completed prompt duration in seconds. */
  elapsed?: number;

  /** Context window usage captured from the last completed output. */
  contextWindowUsed?: number;
  contextWindowSize?: number;

  /** Structured runtime failure classification for this prompt attempt. */
  failureKind?: FailureKind;

  /** Human-readable failure message persisted for UI/history display. */
  failureMessage?: string;
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

/** Action options for endCondition onFail */
export type EndConditionAction = Exclude<ConditionAction, "skipPrompt">;

/** Action options for endCondition onPass. Retry requires orchestrator loop support. */
export type EndConditionPassAction = Exclude<EndConditionAction, "retry">;

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
  onPass?: EndConditionPassAction;
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
  /** Stable lineage identity for the loaded workflow; set once by WorkingFileManager.createWorkingFile. */
  workflowKey?: WorkflowKey;
  /** The run this working file currently addresses (undefined while still a draft, pre-first-execution). */
  runRef?: RunRef;
  /** Mirrors `WorkingFile.definitionRevision`; see that field's doc comment. */
  definitionRevision: number;
  /** Present only while this promoted run has an editable rewound suffix. */
  pendingRewind?: {
    fromStepIndex: number;
    baseDefinitionRevision: number;
  };
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
 * Lightweight per-lineage run-navigation metadata for workflow-list rows: whether a
 * lineage is drillable (more than one run, or a run plus a draft), and what to show
 * without loading every run's full `RunSummary`. Shared across `RecentWorkflow` and
 * `WorkflowSummary` rather than duplicated as parallel optional fields on each.
 */
export interface WorkflowRunNavigationSummary {
  primaryAddress: WorkflowViewAddress;
  primaryRunId?: number;
  runCount: number;
  hasDraft: boolean;
}

/**
 * Summary of a workflow instance — used by WorkflowOrchestrator to expose
 * lightweight status information without leaking the full WorkflowInstance.
 */
export interface WorkflowSummary {
  /** In-memory instance identity, retained only for live execution/terminal ownership. */
  id: string;
  /** Stable lineage identity for navigation and persisted selection. */
  workflowKey?: WorkflowKey;
  /** Exact promoted run being executed, when this summary represents a run. */
  runRef?: RunRef;
  workflowName: string;
  filePath: string;
  workingFilePath?: string; // Path to .ctrlyoke.json working file (for dedup with recent workflows list)
  executionState: ExecutionState;
  /** 0-indexed: index of the next prompt to execute (mirrors PromptQueue.state.currentIndex) */
  currentStep: number;
  totalSteps: number;
  startedAt?: number;
  /** Active workflow execution time, excluding confirmed pauses. */
  executionTimeMs?: number;
  /** Timestamp when executionTimeMs was sampled for a live-running summary. */
  executionTimeUpdatedAt?: number;
  completedAt?: number;
  /** Set to "cli" when the workflow is being executed by the ctrlyoke CLI. Undefined means vscode-managed. */
  managedBy?: RunnerId;
  /** Resolved harness this workflow runs on (workflow/step override, or the global default). */
  harness?: HarnessId;
  /** Run-navigation metadata for this lineage's list row. Not yet populated for running workflows. */
  runNav?: WorkflowRunNavigationSummary;
}

/**
 * Returns the 1-indexed step number for display (logs, UI labels), bounded by
 * the queue size. The internal cursor equals `totalSteps` after completion, so
 * adding one without clamping would report impossible progress such as 3/2.
 */
export const workflowDisplayStep = (
  s: Pick<WorkflowSummary, "currentStep" | "totalSteps">
): number => Math.max(0, Math.min(s.currentStep + 1, s.totalSteps));

/**
 * Process lock file written at the lineage root while one of its runs is executing.
 * Enables the VS Code extension and CLI to coexist without stomping on each other's state.
 * Lock file path: `.ctrlyoke/.runs/<workflowKey>/runner.json`.
 */
export interface WorkflowRunnerLock {
  /** Lineage this lock belongs to. */
  workflowKey: WorkflowKey;
  /** The exact run this lock is executing — never merely the viewed run. */
  runRef: RunRef;
  /** Which runner created this lock */
  runner: RunnerId;
  /** OS process ID of the runner (Extension Host PID for vscode, CLI process PID for cli) */
  pid: number;
  /**
   * Random token generated fresh on every acquire. Heartbeat/release must present a matching
   * token, so a stale process can never refresh or unlink a successor's lock.
   */
  ownerToken: string;
  /** UUID generated once at extension activation (vscode) or CLI startup (cli) */
  instanceId?: string;
  /** Unix ms timestamp when execution started */
  startedAt: number;
  /** Unix ms timestamp updated every 5s while running — guards against PID recycling */
  lastHeartbeat: number;
}

// Re-export constants for convenience
export { EXECUTION_STATES };
