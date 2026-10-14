import {
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  STEP_STATUS,
  STEP_TYPES,
  WORKFLOW_ATTEMPT_COMMANDS,
  ExecutionState,
  FinalStepPhase,
  StepStatus,
  type RunnerId,
  type PromptTerminalStatus,
  type WorkflowAttemptStatus,
  PRIOR_CONTEXT_KEYWORDS,
  CONDITION_ACTIONS,
  type ConditionAction,
  type CompareSource,
  type ScriptOperator,
  type HarnessId,
  type ExecutionMode,
  type HookEvent,
  type McpTransport,
  type FailureKind,
  type AttemptCostConfidence,
  type AttemptCostNoteCode,
  type AttemptCostSource,
  type AttemptCostUnavailableReason,
  type WorkflowTokenCoverage,
  WORKTREE_MODES,
  WORKTREE_LIFECYCLE_OWNERS,
  WORKTREE_LIFECYCLE_STATES,
  WORKTREE_BRANCH_STATES,
  WORKTREE_DIRECTORY_STATES,
  WORKTREE_DIRECTORY_OUTCOMES,
  WORKTREE_EDIT_KINDS,
  WORKTREE_LANDING_OUTCOMES,
  WORKTREE_MERGE_OUTCOMES,
  WORKFLOW_LOCK_LOCALITIES,
  WORKTREE_SETUP_OUTCOMES,
  type WorktreeConfigOrigin,
  SCRIPT_VERDICT_OUTCOMES,
  WORKFLOW_VIEW_ADDRESS_KIND,
  type ParallelGroupAdmission,
  type WorkflowValidationWarningCode,
  type GuardrailStopCode,
  type PriorContextDetail,
} from "./DashboardConstants";
import type { ResolverWorkspaceFolder } from "../platform/WorkspaceRootResolver";
export type {
  HarnessId,
  HookEvent,
  McpTransport,
  FailureKind,
  AttemptCostConfidence,
  AttemptCostNoteCode,
  AttemptCostSource,
  AttemptCostUnavailableReason,
  WorkflowTokenCoverage,
  ParallelGroupAdmission,
};
import type { ToolPermissionMode } from "./ExecutionPropertyTypes";
export type { ToolPermissionMode };

/**
 * Controls which prior prompt outputs are injected into the current prompt as context.
 *
 * - "all": Inject all previously-completed prompt outputs
 * - "previous": Inject only the immediately preceding prompt's output
 * - "none": Explicit no-op (same as omitting the field)
 * - number[]: Inject specific prompt outputs by 1-based prompt number (e.g., [1, 3])
 * - PreviousStepsPriorContext: Inject the last N outputs before this prompt
 *   (`{ previous: 3 }`), counted relative to the prompt so it survives reordering.
 * - PriorContextRunSource: Inject the complete, terminal timeline of a
 *   completed run in this workspace, selected by workflow and run number.
 *   Sources intentionally contain no path.
 *
 * Context is injected as an XML block before the user's prompt text.
 * Note: When used with resumeSession:true, context may be duplicated — this is accepted behavior.
 */
export type PriorContext =
  | (typeof PRIOR_CONTEXT_KEYWORDS)[keyof typeof PRIOR_CONTEXT_KEYWORDS]
  | number[]
  | PreviousStepsPriorContext
  | PriorContextRunSource;

/**
 * A completed run in this workspace, as a person types it: `workflow` is a
 * lineage key, workflow name, or key slug, and `run` is the run's number or
 * `RunRef`. Without `run`, the lineage's latest completed run is used, so the
 * source follows new runs. Resolved to a `WorkflowRunAddress` at execution.
 */
export interface PriorContextRunSource {
  workflow: string;
  run?: number | RunRef;
}

/** True when a prior-context value selects another run's output. */
export function isPriorContextRunSource(
  value: unknown
): value is PriorContextRunSource {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return false;
  }
  const source = value as Record<string, unknown>;
  return (
    typeof source.workflow === "string" &&
    (source.run === undefined ||
      typeof source.run === "string" ||
      (typeof source.run === "number" &&
        Number.isSafeInteger(source.run) &&
        source.run >= 1))
  );
}

/**
 * The last `previous` earlier queue steps that produced output, oldest first.
 * Same "produced output" rule as the `"previous"` keyword, which is the
 * `previous: 1` case — steps with no output never count toward N.
 */
export interface PreviousStepsPriorContext {
  previous: number;
}

/** True when a prior-context value selects the last N outputs. */
export function isPreviousStepsPriorContext(
  value: PriorContext | undefined
): value is PreviousStepsPriorContext {
  return (
    !!value &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    "previous" in value &&
    typeof value.previous === "number"
  );
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
  transport?: McpTransport;
  /** HTTP headers to send with every request (remote servers only, e.g. Authorization) */
  headers?: Record<string, string>;
  /**
   * Tool names from this server to deny at execution time.
   * Use bare tool names without the `mcp__serverid__` prefix (e.g. `["append_step"]`).
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
  /** Environment map consumed by the hook process. */
  env?: Record<string, string>;
  /** Optional timeout in seconds (only respected by CLIs that support per-hook timeouts). */
  timeoutSec?: number;
}

/** Runtime-only hook launcher metadata prepared by the CLI execution planner. */
export interface PreparedUserHookConfig extends UserHookConfig {
  envFile?: string;
  envId?: string;
  bashCommand?: string;
  powershellCommand?: string;
}

/** Runtime metadata passed to OpenCode's hook plugin for scoped environments. */
export type OpenCodeUserHookConfig = PreparedUserHookConfig;

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

export type ErrorBehaviorAction =
  | typeof CONDITION_ACTIONS.CONTINUE
  | typeof CONDITION_ACTIONS.STOP_WORKFLOW
  | typeof CONDITION_ACTIONS.RETRY;

/** Policy for internal errors in any step phase: pre-condition, prompt/harness, end-condition, or script execution. */
export interface ErrorBehavior {
  onError: ErrorBehaviorAction;
  maxRetries?: number;
  retryDelaySec?: number;
}

/**
 * Workflow-level worktree authoring. `true` is accepted at the input boundary
 * and normalized to the managed object form by PromptFileParser.
 */
export type WorktreeConfig =
  | false
  | true
  | string
  | {
      mode: typeof WORKTREE_MODES.MANAGED;
      merge?: boolean;
      keep?: boolean;
      base?: string;
      setup?: string;
    }
  | {
      mode: typeof WORKTREE_MODES.NAMED;
      branch: string;
      base?: string;
      setup?: string;
    };

/** Settings defaults reuse the same shorthand/object forms as workflow worktree. */
export type WorktreeDefaultConfig = WorktreeConfig;
export type WorktreeObjectConfig = Extract<WorktreeConfig, { mode: string }>;

/** Worktree settings plus the tier that supplied the value for one run. */
export interface WorktreeResolution {
  /** Absent means the working checkout is used. */
  config?: WorktreeObjectConfig;
  origin: WorktreeConfigOrigin;
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

  /**
   * Secret environment-variable names granted to this step.
   * - string[]: explicit grant list
   * - null: explicitly disable inherited secret grants
   * - undefined: inherit from workflow/settings
   *
   * Inline !NAME references in the prompt remain authoritative grants even
   * when this array is explicitly cleared.
   */
  secrets?: string[] | null;

  /** Resume existing chat session (default: false, start new session) */
  resumeSession?: boolean;

  /**
   * MCP servers to attach for this prompt/workflow.
   * - string[]: server IDs (e.g., "ctrlyoke") or McpServerConfig objects
   * - null: explicitly disable inherited MCP servers
   * - undefined: inherit from workflow/settings
   *
   * Include "ctrlyoke" to let the harness append steps through ctrlyoke's MCP server (a dynamic workflow).
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
  priorContextDetail?: PriorContextDetail;

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

/**
 * Schema-backed execution properties shared by workflows and prompt steps.
 * Parser normalization and working-file persistence both consume this list so
 * adding a property to ExecutionProperties cannot leave one path behind.
 */
export const EXECUTION_PROPERTY_KEYS = [
  "harness",
  "model",
  "executionMode",
  "agent",
  "skills",
  "secrets",
  "resumeSession",
  "mcpServers",
  "sessionId",
  "endCondition",
  "preCondition",
  "priorContext",
  "priorContextDetail",
  "additionalArgs",
  "toolPermissions",
  "errorBehavior",
  "hooks",
] as const satisfies readonly (keyof ExecutionProperties)[];

export interface PromptFile extends ExecutionProperties {
  /** Workflow definition schema version; omitted on hand-authored legacy files (format 1). */
  schemaVersion?: number;
  /** Maximum number of workflow steps for this run; omitted inherits settings. */
  maxSteps?: number;
  /** Worktree selection authored at the workflow root. */
  worktree?: WorktreeConfig;
  /** External roots requested for this workflow, or null to disable access. */
  trustedExternalRoots?: string[] | null;
  prompt?: string;
  steps?: WorkflowStep[];
  /** Normalized flat-step topology for authored parallel groups. */
  parallelGroups?: ParallelGroupDefinition[];
  finalStep?: WorkflowStep;
  /**
   * Workflow-level variable defaults for `{{varName}}` substitution.
   * CLI `--var key=value` flags override these at runtime (highest precedence).
   * Substituted into: prompt text, model, additionalArgs, hook command/env,
   * preCondition script/env, endCondition script/env/retryPrompt/passRetryPrompt,
   * script-step script/env, and worktree setup commands — see `VarSubstitutor`.
   * Every script/condition process also receives each var as a
   * `CTRLYOKE_VAR_<KEY>` environment variable regardless of `{{varName}}` usage.
   */
  vars?: Record<string, string>;
}

/** A parsed workflow plus non-blocking schema warnings for authored unknown keys. */
export interface ParsedPromptFile extends PromptFile {
  warnings: WorkflowValidationWarning[];
}

/**
 * Runtime state for workflow-level finalStep execution.
 */
export interface FinalStepRuntimeState {
  phase: FinalStepPhase;
  loopCount: number;
  status?: StepStatus;
  /** Structured classification for the latest final-step failure. */
  failureKind?: FailureKind;
  /** Human-readable reason for the latest final-step failure. */
  failureMessage?: string;
  startedAt?: number;
  completedAt?: number;
  preCondition?: ConditionEvaluationSummary;
  endCondition?: ConditionEvaluationSummary;
}

/**
 * Stable identity for a workflow lineage directory in run storage: `.runs/<workflowKey>/`.
 * A sanitized name plus creation timestamp, minted once by `WorkflowLineageRepository`
 * and never re-derived from a mutable file path. Opaque — always go through
 * `WorkflowPaths`/`WorkflowLineageRepository` to mint or validate one.
 */
export type WorkflowKey = string & { readonly __workflowKey: unique symbol };

/**
 * Stable identity for one promoted run directory in run storage: `.runs/<workflowKey>/run-<ts>/`.
 * The run directory name itself (`run-<UTC-ms-timestamp>`). Opaque — always go through
 * `WorkflowPaths`/`WorkflowLineageRepository` to mint or validate one.
 */
export type RunRef = string & { readonly __runRef: unique symbol };

export interface CoordinationParticipant {
  /** Server-assigned, stable for the lifetime of the lease. */
  participantId: string;
  kind: "ctrlyoke-step" | "external";
  /** True when ctrlyoke derived this identity rather than accepting it from the caller. */
  attested: boolean;
  label: string;
  via: "mcp" | "cli";
  address?: {
    workflowKey: WorkflowKey;
    runRef: RunRef;
    stepIndex?: number;
    stepName?: string;
    parallelGroupId?: string;
  };
  pid?: number;
  lastHeartbeat?: number;
  leaseExpiresAt?: number;
}

export interface CoordinationEntry {
  /** Board format version (PersistedSchemaGuard); absent on entries written before versioning. */
  schemaVersion?: number;
  seq: number;
  at: string;
  kind: "note" | "claim" | "release" | "join" | "leave";
  /** Denormalized so readers can attribute entries after a participant is compacted away. */
  from: {
    participantId: string;
    label: string;
    /** Absent on entries written before participant kinds existed; resolve with `resolveCoordinationParticipantKind`. */
    kind?: CoordinationParticipant["kind"];
    attested: boolean;
    address?: CoordinationParticipant["address"];
  };
  /** Full lease record carried by join entries; absent on other entry kinds. */
  participant?: CoordinationParticipant;
  to?: string[];
  text?: string;
  paths?: string[];
  reason?: string;
  via: "mcp" | "cli";
}

/** Bounded execution-root coordination state projected to dashboard clients. */
export interface CoordinationScopeSnapshot {
  executionRoot: string;
  identity: string;
  /** Absolute path of this scope's `board.jsonl`, so the dashboard can offer to open the raw log. */
  boardPath: string;
  participants: CoordinationParticipant[];
  entries: CoordinationEntry[];
  claims: Array<{
    path: string;
    owner: Pick<
      CoordinationParticipant,
      "participantId" | "label" | "attested"
    >;
    reason?: string;
    claimedAtSequence: number;
  }>;
  attestationNotice: string;
}

/** A client's addressed view into a lineage: either the mutable draft or one promoted run. */
export type WorkflowViewAddress =
  | { workflowKey: WorkflowKey; kind: typeof WORKFLOW_VIEW_ADDRESS_KIND.DRAFT }
  | {
      workflowKey: WorkflowKey;
      kind: typeof WORKFLOW_VIEW_ADDRESS_KIND.RUN;
      runRef: RunRef;
    };

/** Addresses exactly one promoted run within a lineage. */
export interface WorkflowRunAddress {
  workflowKey: WorkflowKey;
  runRef: RunRef;
}

/**
 * Authoritative lineage metadata and allocation state, persisted at
 * `.runs/<workflowKey>/workflow.json` in run storage. `WorkflowLineageRepository` is the only writer.
 */
export interface WorkflowLineageDescriptor {
  schemaVersion: number;
  workflowKey: WorkflowKey;
  workflowName: string;
  /** Path to the source prompt file, if any (undefined for ephemeral/dashboard-created lineages). */
  originalFile?: string;
  /** True for internal lineages that should not appear in the recent-workflows list. */
  isSystemGenerated?: boolean;
  isFavorite: boolean;
  createdAt: number;
  lastModifiedAt: number;
  /** Repairable hint, not the storage source of truth — validate against manifests before trusting. */
  latestRunRef?: RunRef;
  /** Source lineage when this workflow was created as a variant. Informational only. */
  sourceWorkflowKey?: WorkflowKey;
  /** Source run when this workflow was created from a promoted run. Informational only. */
  sourceRunRef?: RunRef;
  /** Source display name when this workflow was created as a variant. */
  sourceWorkflowName?: string;
  /** Time at which this workflow variant was created. */
  variantCreatedAt?: number;
  /** Monotonic; never decremented after deletion. */
  nextRunId: number;
  /**
   * The lineage's one mutable preparation target. Always `undefined` through phase 1 —
   * draft/rewind editing is introduced in phase 3.
   */
  pendingEdit?:
    | { kind: typeof WORKTREE_EDIT_KINDS.DRAFT }
    | {
        kind: typeof WORKTREE_EDIT_KINDS.REWIND;
        runRef: RunRef;
        fromStepIndex: number;
        baseDefinitionRevision: number;
      };
  /** Optimistic-concurrency counter for descriptor metadata/allocation changes. */
  revision: number;
}

/** Options for creating a draft in a new or already-known lineage. */
export interface WorkflowLineageCreationOptions {
  existingWorkflowKey?: WorkflowKey;
  isSystemGenerated?: boolean;
}

/**
 * Persisted worktree lifecycle metadata for a working file.
 *
 * This includes managed-worktree outcomes even while those fields are not
 * exposed by the authored workflow schema. Runtime persistence needs one
 * stable shape before the managed lifecycle is implemented.
 */
export interface WorkingFileWorktreeRuntime {
  schemaVersion: 1;
  mode: typeof WORKTREE_MODES.MANAGED | typeof WORKTREE_MODES.NAMED;
  origin: "created" | "discovered" | "recovered";
  branchName: string;
  worktreePath: string;
  executionRoot: string;
  executionCheckoutRoot: string;
  sourceCheckoutRoot: string;
  namedWorkspaceRoots: ResolverWorkspaceFolder[];
  baseCommit: string;
  /** Recorded comparison base used for named-branch divergence, when known. */
  comparisonBaseLabel?: string;
  comparisonBaseCommit?: string;
  /** Number of files in the landed branch diff from baseCommit, when known. */
  changedFileCount?: number;
  /** Whether the named checkout had uncommitted changes at run start. */
  dirty?: boolean;
  /** Whether source checkout changes existed when the managed worktree was created. */
  sourceCheckoutDirty?: boolean;
  targetBranch?: string;
  lifecycleOwner: (typeof WORKTREE_LIFECYCLE_OWNERS)[keyof typeof WORKTREE_LIFECYCLE_OWNERS];
  lifecycleState: (typeof WORKTREE_LIFECYCLE_STATES)[keyof typeof WORKTREE_LIFECYCLE_STATES];
  setupOutcome?: (typeof WORKTREE_SETUP_OUTCOMES)[keyof typeof WORKTREE_SETUP_OUTCOMES];
  landingOutcome?: (typeof WORKTREE_LANDING_OUTCOMES)[keyof typeof WORKTREE_LANDING_OUTCOMES];
  mergeOutcome?: (typeof WORKTREE_MERGE_OUTCOMES)[keyof typeof WORKTREE_MERGE_OUTCOMES];
  directoryState: (typeof WORKTREE_DIRECTORY_STATES)[keyof typeof WORKTREE_DIRECTORY_STATES];
  branchState: (typeof WORKTREE_BRANCH_STATES)[keyof typeof WORKTREE_BRANCH_STATES];
  finalBranchTip?: string;
  conflictFiles?: string[];
  message?: string;
  updatedAt: number;
}

/** Persisted worktree fields safe to carry in run-list/history projections. */
export type WorktreeRunProjection = Pick<
  WorkingFileWorktreeRuntime,
  | "mode"
  | "branchName"
  | "worktreePath"
  | "sourceCheckoutRoot"
  | "sourceCheckoutDirty"
  | "directoryState"
  | "landingOutcome"
  | "mergeOutcome"
> &
  Partial<
    Pick<
      WorkingFileWorktreeRuntime,
      | "baseCommit"
      | "changedFileCount"
      | "lifecycleState"
      | "branchState"
      | "comparisonBaseLabel"
      | "comparisonBaseCommit"
    >
  >;

/** Project the disk-authoritative runtime to fields safe for status/history views. */
export function projectWorktreeRuntime(
  worktree: WorkingFileWorktreeRuntime | undefined
): WorktreeRunProjection | undefined {
  if (!worktree) return undefined;
  return {
    mode: worktree.mode,
    branchName: worktree.branchName,
    worktreePath: worktree.worktreePath,
    sourceCheckoutRoot: worktree.sourceCheckoutRoot,
    ...(worktree.sourceCheckoutDirty !== undefined
      ? { sourceCheckoutDirty: worktree.sourceCheckoutDirty }
      : {}),
    baseCommit: worktree.baseCommit,
    lifecycleState: worktree.lifecycleState,
    directoryState: worktree.directoryState,
    branchState: worktree.branchState,
    ...(worktree.landingOutcome
      ? { landingOutcome: worktree.landingOutcome }
      : {}),
    ...(worktree.mergeOutcome ? { mergeOutcome: worktree.mergeOutcome } : {}),
    ...(worktree.comparisonBaseLabel
      ? { comparisonBaseLabel: worktree.comparisonBaseLabel }
      : {}),
    ...(worktree.comparisonBaseCommit
      ? { comparisonBaseCommit: worktree.comparisonBaseCommit }
      : {}),
    ...(worktree.changedFileCount !== undefined
      ? { changedFileCount: worktree.changedFileCount }
      : {}),
  };
}

/** Partial lifecycle patch applied to persisted worktree runtime metadata. */
export type WorkingFileWorktreeRuntimePatch =
  Partial<WorkingFileWorktreeRuntime>;

/** Terminal result of a managed worktree settlement. */
export interface WorktreeCompletionResult {
  landingOutcome: (typeof WORKTREE_LANDING_OUTCOMES)[keyof typeof WORKTREE_LANDING_OUTCOMES];
  mergeOutcome?: (typeof WORKTREE_MERGE_OUTCOMES)[keyof typeof WORKTREE_MERGE_OUTCOMES];
  directoryOutcome: (typeof WORKTREE_DIRECTORY_OUTCOMES)[keyof typeof WORKTREE_DIRECTORY_OUTCOMES];
  branchState: (typeof WORKTREE_BRANCH_STATES)[keyof typeof WORKTREE_BRANCH_STATES];
  branchName: string;
  targetBranch?: string;
  conflictFiles?: string[];
  autoCommitted?: boolean;
  changedFileCount?: number;
  message?: string;
}

/**
 * Runtime metadata for working files (optional, not required for user-created files)
 * Tracks workflow execution state only - does NOT include execution properties
 * (those are tracked at workflow root and per-prompt _runtime)
 */
export interface WorkingFileRuntime {
  /** Run-file format version (`PersistedSchemaGuard`); stamped on every write. */
  schemaVersion?: number;
  /** Latest persisted run activity, including edits such as appending steps. */
  lastActivityAt?: number;
  currentIndex: number;
  executionState: ExecutionState;
  /** Latest run-scoped token aggregate projected from timeline history. */
  tokenTotals?: WorkflowTokenTotals;
  /** Wall-clock timestamp when active execution timing began. */
  startTime?: number;
  /** Wall-clock timestamp when the current pause began. */
  pausedTime?: number;
  /** Accumulated time spent paused before the current pause, in milliseconds. */
  totalPausedDuration?: number;
  /** Wall-clock timestamp when execution reached a terminal state. */
  executionEndTime?: number;
  /** Structured reason when a run ended because an execution guardrail fired. */
  stopReason?: WorkflowStopReason;
  /** Durable admission state for the currently executing parallel group. */
  activeParallelGroup?: ActiveParallelGroupRuntime;
  finalStep?: FinalStepRuntimeState;
  /**
   * Durable marker for an in-place, nonzero rewind. The full pre-rewind file is
   * kept beside the run until the continuation is committed or discarded.
   */
  pendingRewind?: {
    fromStepIndex: number;
    baseDefinitionRevision: number;
  };
  /** Disk-authoritative lifecycle metadata for a worktree-backed run. */
  worktree?: WorkingFileWorktreeRuntime;
  /** Durable notice when an inherited worktree default degraded to none. */
  worktreeNotice?: string;
}

export interface ActiveParallelGroupRuntime {
  groupId: string;
  admission: ParallelGroupAdmission;
}

/** Pause-aware execution timing, as owned by WorkflowStateMachine and persisted on `_runtime`. */
export type ExecutionTiming = Pick<
  WorkingFileRuntime,
  "startTime" | "pausedTime" | "totalPausedDuration" | "executionEndTime"
>;

/**
 * Active execution time: wall-clock time since `startTime` minus every pause.
 * The clock freezes at `executionEndTime` once the run settles and otherwise
 * reads `now`. Returns 0 before the timer has started.
 */
export function computeActiveExecutionMs(
  timing: ExecutionTiming,
  now: number
): number {
  if (timing.startTime === undefined) {
    return 0;
  }
  const referenceTime = timing.executionEndTime ?? now;
  const activePauseDuration =
    timing.pausedTime !== undefined ? referenceTime - timing.pausedTime : 0;
  return (
    referenceTime -
    timing.startTime -
    (timing.totalPausedDuration ?? 0) -
    activePauseDuration
  );
}

/**
 * Active execution time of a persisted run whose clock is not advancing
 * (settled or paused). Returns `undefined` for a run that never started or is
 * still ticking, because a snapshot cannot say how long a live run has gone on.
 */
export function frozenActiveExecutionMs(
  timing: ExecutionTiming
): number | undefined {
  if (timing.startTime === undefined) {
    return undefined;
  }
  const frozenAt = timing.executionEndTime ?? timing.pausedTime;
  return frozenAt === undefined
    ? undefined
    : Math.max(0, computeActiveExecutionMs(timing, frozenAt));
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
  /** Structured reason when a run ended because an execution guardrail fired. */
  stopReason?: WorkflowStopReason;
}

/** Run-level execution guardrail stop details; thresholds use their native unit. */
export interface WorkflowStopReason {
  code: GuardrailStopCode;
  threshold: number;
  observed: number;
  unit: "steps" | "seconds";
  message: string;
}

export type WorkflowRuntimeCommand =
  import("./DashboardConstants").WorkflowRuntimeCommand;

export interface WorkflowRuntimeTransition {
  command: WorkflowRuntimeCommand;
  previous: WorkflowRuntimeState;
  current: WorkflowRuntimeState;
  timestampMs: number;
}

export type WorkflowAttemptTarget =
  | { kind: typeof FINAL_STEP_PHASES.QUEUE; stepIndex: number }
  | { kind: typeof FINAL_STEP_PHASES.FINAL_STEP; loopIndex: number };

export interface StepExecutionOutcome {
  target: WorkflowAttemptTarget;
  status: PromptTerminalStatus;
  failureReason?: string;
  /** False when a per-step continue policy resolved a failed attempt. */
  terminalFailure?: boolean;
}

export interface ParallelGroupOutcome {
  group: ParallelGroupDefinition;
  outcomes: StepExecutionOutcome[];
  settledCount: number;
  terminalFailure: boolean;
  paused: boolean;
  stopped: boolean;
}

export type { WorkflowAttemptStatus };

export interface WorkflowAttemptState {
  target: WorkflowAttemptTarget;
  attemptIndex: number;
  status: WorkflowAttemptStatus;
  /**
   * When the *whole-step* attempt began — i.e. before its pre-condition gate,
   * not when the harness prompt was sent. Use `promptStartedAt` to stamp
   * prompt-phase output.
   */
  startedAt: number;
  /**
   * When this attempt's prompt phase began, set once the harness prompt is
   * about to be sent. Distinct from `startedAt` because the attempt spans
   * pre-condition → prompt → end-condition: a pre-condition that runs for
   * minutes would otherwise back-date every prompt output entry to before the
   * pre-condition's own output, which sorts the prompt above the gate that
   * produced it. Undefined until the prompt phase starts.
   */
  promptStartedAt?: number;
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
 * Stored at `.runs/<workflowKey>/{draft,run-<ts>}/workflow.ctrlyoke.json` in run storage.
 */
export interface WorkingFile extends PromptFile {
  startedAt: number; // Timestamp when workflow started
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

/**
 * Display properties shared by every authored workflow step.
 *
 * These fields belong to the step itself rather than to either execution
 * property family, so prompt and script steps keep the same authored identity
 * when they are parsed, exported, or mutated.
 */
export interface StepDisplayProperties {
  /** Optional human-readable display label. */
  name?: string;
  /** When false, the step remains in the workflow but never executes. */
  enabled?: boolean;
  /** Optional authored identity colour in six-digit RGB hex form. */
  color?: string;
}

export interface PromptStep extends ExecutionProperties, StepDisplayProperties {
  /** Step type discriminant — defaults to "prompt" when absent */
  type?: typeof STEP_TYPES.PROMPT;
  prompt: string;
  sessionId?: string | number; // Session ID for resuming conversations (string session ID, or number = resume from that prompt index)
  _runtime?: PromptRuntimeMetadata; // Per-prompt runtime metadata
}

/**
 * Script step — runs a shell command with no AI harness interaction.
 * Shares _runtime with PromptRuntimeMetadata for startedAt/completedAt tracking.
 */
export interface ScriptStep extends ScriptProperties, StepDisplayProperties {
  type: typeof STEP_TYPES.SCRIPT;
  /** Execution mode for this script step; undefined inherits from settings. */
  executionMode?: ExecutionMode;
  /** Secret environment-variable names granted to this script step. */
  secrets?: string[] | null;
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

/**
 * Normalized topology for one authored `parallel:` item.
 * Indices are inclusive and refer to the flat `PromptFile.steps` array.
 */
export interface ParallelGroupDefinition {
  id: string;
  startIndex: number;
  endIndex: number;
  failFast: boolean;
}

/** Type guard: returns true if the step is a ScriptStep */
export function isScriptStep(step: WorkflowStep): step is ScriptStep {
  return step.type === STEP_TYPES.SCRIPT;
}

/**
 * True when a workflow has something to execute. A `finalStep` counts as a
 * step: a final-step-only workflow (empty `steps`, orchestrating `finalStep`)
 * is a valid, supported shape — the final step appends the queue at runtime via
 * `append_step`. See the Spec-Driven Loop template. Anything that
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

export interface ScriptVerdict {
  compareSource: CompareSource;
  /** The comparison the author configured. Never inferred from the output. */
  operator: ScriptOperator;
  expected?: string;
  actual: string;
  exitCode?: number;
  outcome: (typeof SCRIPT_VERDICT_OUTCOMES)[keyof typeof SCRIPT_VERDICT_OUTCOMES];
  action: ConditionAction;
  actionDetail?: string;
  durationMs: number;
  timedOut?: boolean;
  error?: string;
}

/** Default expectation shown when a script comparison omits `expected`. */
export const DEFAULT_SCRIPT_VERDICT_EXPECTED_TEXT =
  "exit code 0 (no `expected` set)";

/**
 * The latest evaluation details retained for the automation result projection.
 * The action is populated for pre-conditions, where it explains a gate decision.
 */
export interface ConditionEvaluationSummary {
  passed: boolean;
  action?: ConditionAction;
  script: string;
  expected?: string;
  compareSource?: CompareSource;
  operator?: ScriptOperator;
  actual: string;
  stdout: string;
  stderr: string;
  exitCode?: number;
  durationMs: number;
  error?: string;
}

/**
 * Per-prompt runtime execution metadata.
 * Tracks execution state for individual prompts within a workflow.
 */
export interface PromptRuntimeMetadata extends ExecutionProperties {
  /**
   * Timestamp when the executor claimed this step for dispatch. This is not
   * the timestamp when runtime metadata was written.
   */
  startedAt?: number;

  /** Stable identity for this queue step within its run. */
  stepId?: string;

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

  /** False when the failed step was resolved by its per-step continue policy. */
  terminalFailure?: boolean;
}

/**
 * Which output source is compared against `expected`. Default: `"exitCode"`.
 *
 * - `"exitCode"`: the numeric exit code. `"true"`/`"false"` are NOT accepted —
 *   exit 0 means "no error", and the boolean translation was removed.
 * - `"stdout"` / `"stderr"`: the trimmed text. Neither also requires a clean
 *   exit; if the author asked about the text, the text is the condition.
 *
 * How the comparison is made is `operator`'s job, never inferred from the value.
 */
export type EndConditionCompareSource = CompareSource;

/** Action options for endCondition onPass/onFail */
export type EndConditionAction = Exclude<ConditionAction, "skipPrompt">;

/** Action options for preCondition onPass/onFail */
export type PreConditionAction = Exclude<ConditionAction, "retry">;

/** Action options for scriptStep onPass/onFail */
export type ScriptStepAction = Exclude<ConditionAction, "retry" | "skipPrompt">;

/**
 * A non-blocking finding from PromptFileParser: the workflow parses, loads, and
 * runs, but something it states may not take effect. Warnings carry a stable
 * `code` and RFC 6901 `propertyPointer`; consumers identify them by those
 * rather than by parsing `message`.
 */
export interface WorkflowValidationWarning {
  code: WorkflowValidationWarningCode;
  message: string;
  /** RFC 6901 pointer to the authored value, e.g. `/steps/2/endCondition/expected`. */
  propertyPointer: string;
}

/** The result of `PromptFileParser.validateWorkflowSteps`. */
export interface WorkflowValidationResult {
  /** False only when `errors` is non-empty — warnings never invalidate a workflow. */
  valid: boolean;
  errors: string[];
  warnings: WorkflowValidationWarning[];
}

/**
 * Shared script execution properties used by endCondition, preCondition, and scriptStep.
 */
export interface ScriptProperties {
  script: string;
  /** Environment map consumed by the script process. */
  env?: Record<string, string>;
  /** Which output source is compared against `expected`. Default: `"exitCode"`. */
  compareSource?: EndConditionCompareSource;
  /** How the source is compared against `expected`. Default: `"eq"`. */
  operator?: ScriptOperator;
  /**
   * Value the source is compared against. When absent, the condition passes on
   * exit code 0 — there is no boolean form, and `true`/`false` are not accepted.
   * A number is accepted at the authoring boundary (`expected: 0`) and
   * normalized to a string by `resolveScriptComparison`.
   */
  expected?: string | number;
  /** Compare text case-insensitively. Only applies to string operators. */
  ignoreCase?: boolean;
  timeoutSec?: number;
  /** Pins the shell for this script's inline-text execution path. See scriptProperties description. */
  shell?: string;
}

export interface EndCondition extends ScriptProperties {
  /** Maximum shared retry attempts across both pass and fail directions (default: 0). */
  maxRetries?: number;
  retryPrompt?: string; // Template with placeholders for retry messages
  passRetryPrompt?: string; // Template with placeholders for pass-retry messages
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
  parallelGroups: ParallelGroupDefinition[];
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
  /** Latest run-scoped token aggregate projected from timeline history. */
  tokenTotals?: WorkflowTokenTotals;
}

/**
 * Dynamic queue configuration
 */
export interface DynamicQueueConfig {
  maxSteps: number; // -1 or positive integer (default: 100)
  maxParallelSteps: number; // Active members per parallel group (default: 6)
  maxWorkflowExecutionTime: number; // In seconds (-1 or 3600-604800, default: 86400)
}

export interface PromptResult {
  prompt: string;
  status: StepStatus; // Use type from DashboardConstants
  timestamp: Date;
  endConditionResult?: boolean;
  error?: string;
  /** Structured classification for failures raised by the harness runtime. */
  failureKind?: FailureKind;
  retryCount?: number; // Track retry attempts for this prompt
  scriptOutput?: string; // Capture last script output for debugging
  preCondition?: ConditionEvaluationSummary;
  endCondition?: ConditionEvaluationSummary;
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
  draftDirectory?: string;
}

export interface AttemptCostEstimate {
  /** Total estimated cost in USD for this attempt. */
  usd: number;
  /** Where the number came from — governs the label and the disclaimer. */
  source: AttemptCostSource;
  /** Whether every billing relationship used by the calculation is verified. */
  confidence: AttemptCostConfidence;
  /** Machine-readable explanation for a fallback/substitution shown in the tooltip. */
  noteCode?: AttemptCostNoteCode;
  /** Model the price table was keyed on; shown in the tooltip. */
  modelId?: string;
  /** Optional component breakdown for the tooltip. */
  breakdown?: {
    inputUsd?: number;
    outputUsd?: number;
    cachedInputUsd?: number;
    cacheWriteUsd?: number;
    reasoningUsd?: number;
  };
}

export interface WorkflowTokenTotals {
  /** Sum of every AI attempt's `TokenStats.total` observed in this run. */
  total: number;
  /** Complete only when every executed AI attempt reported a usable total. */
  coverage: WorkflowTokenCoverage;
  /** AI attempts included in `total`. */
  reportedAttemptCount: number;
  /** AI attempts executed, including retries and manual reruns. */
  attemptCount: number;
  /** False while the run can still add usage. */
  isFinal: boolean;
  /** Summed attempt cost. Absent when no attempt was priceable. */
  costUsd?: number;
  /** True when at least one included attempt could not be priced. */
  costPartial?: boolean;
  /** Distinct attempt cost sources represented, in stable display order. */
  costSources?: AttemptCostSource[];
  /** Same aggregate partitioned by the harness recorded on each immutable attempt output. */
  byHarness: Partial<Record<HarnessId, WorkflowHarnessTokenTotals>>;
  /** Same per-harness subtotals partitioned by the attempt start's local day. */
  byLocalDay: Record<
    string,
    Partial<Record<HarnessId, WorkflowHarnessTokenTotals>>
  >;
}

export interface WorkflowHarnessTokenTotals {
  input: number;
  output: number;
  cachedInput?: number;
  cacheCreated?: number;
  reasoningOutput?: number;
  total: number;
  coverage: WorkflowTokenCoverage;
  reportedAttemptCount: number;
  attemptCount: number;
  costUsd?: number;
  costPartial?: boolean;
  costSources?: AttemptCostSource[];
}

/** Redacted ownership projection for a proven external execution. */
export interface ExternalExecutionOwnerSummary {
  locality: typeof WORKFLOW_LOCK_LOCALITIES.EXTERNAL;
  runner: RunnerId;
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
  /** Structured reason when a run ended because an execution guardrail fired. */
  stopReason?: WorkflowStopReason;
  /** 0-indexed: index of the next prompt to execute (mirrors PromptQueue.state.currentIndex) */
  currentStep: number;
  totalSteps: number;
  startedAt?: number;
  /** Active workflow execution time, excluding confirmed pauses. */
  executionTimeMs?: number;
  /** Timestamp when executionTimeMs was sampled for a live-running summary. */
  executionTimeUpdatedAt?: number;
  completedAt?: number;
  /** Present only when a proven external execution owns this run. */
  externalOwner?: ExternalExecutionOwnerSummary;
  /** Resolved harness this workflow runs on (workflow/step override, or the global default). */
  harness?: HarnessId;
  /** Resolved worktree identity for the currently executing run, when applicable. */
  worktree?: Pick<WorktreeRunProjection, "branchName" | "worktreePath">;
  /** Present when the workflow definition has an enabled final step. */
  hasFinalStep?: boolean;
  /** Current execution phase of the final step, when one is configured. */
  finalStepPhase?: FinalStepPhase;
  /** Set only while the final step is the attempt actually executing right now. */
  finalStepRunning?: boolean;
  /** Run-navigation metadata for this lineage's list row. Not yet populated for running workflows. */
  runNav?: WorkflowRunNavigationSummary;
  tokenTotals?: WorkflowTokenTotals;
}

/**
 * Derive the final-step state carried by lightweight workflow summaries.
 * Keep this definition/runtime pairing single-sourced across local and external runs.
 */
export function deriveWorkflowFinalStepSummary(
  finalStep: PromptFile["finalStep"],
  finalStepRuntime: FinalStepRuntimeState | undefined
): Pick<
  WorkflowSummary,
  "hasFinalStep" | "finalStepPhase" | "finalStepRunning"
> {
  return {
    hasFinalStep: !!finalStep && finalStep.enabled !== false,
    ...(finalStepRuntime ? { finalStepPhase: finalStepRuntime.phase } : {}),
    finalStepRunning:
      finalStepRuntime?.phase === FINAL_STEP_PHASES.FINAL_STEP &&
      finalStepRuntime.status === STEP_STATUS.RUNNING,
  };
}

/** Read-only ownership identity discovered when a window opens on a managed worktree. */
export interface WorkspaceWorktreeOwnership {
  branchName: string;
  worktreePath: string;
  sourceCheckoutRoot: string;
}

/**
 * Returns the 1-indexed step number for display (logs, UI labels), bounded by
 * the queue size. The internal cursor equals `totalSteps` after completion, so
 * adding one without clamping would report impossible progress such as 3/2.
 */
export const workflowDisplayStep = (
  s: Pick<WorkflowSummary, "currentStep" | "totalSteps">
): number => Math.max(0, Math.min(s.currentStep + 1, s.totalSteps));

/** Visible row text for a lineage executing its final step. */
export const FINAL_STEP_PROGRESS_LABEL = "Final step";

/**
 * Whether a running row has step progress to show. A workflow whose only work
 * is its final step (`steps: []`) has no queue to count, but while that final
 * step executes it still reports "Final step".
 */
export const hasWorkflowStepProgress = (
  s: Pick<WorkflowSummary, "totalSteps" | "finalStepRunning">
): boolean => s.totalSteps > 0 || s.finalStepRunning === true;

/**
 * Returns the running row's step-progress label, including its final-step state.
 */
export const workflowStepProgressLabel = (
  s: Pick<WorkflowSummary, "currentStep" | "totalSteps" | "finalStepRunning">
): string =>
  s.finalStepRunning
    ? FINAL_STEP_PROGRESS_LABEL
    : `${workflowDisplayStep(s)}/${s.totalSteps}`;

/**
 * The spoken form of `workflowStepProgressLabel`, branching on the same field so
 * the visible text and the accessible name can never disagree about *which*
 * state the row is in. They are phrased differently on purpose: a screen reader
 * reads "2/2" as "two slash two", so the numeric branch stays spelled out.
 */
export const workflowStepProgressAccessibleLabel = (
  s: Pick<WorkflowSummary, "currentStep" | "totalSteps" | "finalStepRunning">
): string =>
  s.finalStepRunning
    ? FINAL_STEP_PROGRESS_LABEL.toLowerCase()
    : `step ${workflowDisplayStep(s)} of ${s.totalSteps}`;

/**
 * Process lock file written at the lineage root while one of its runs is executing.
 * Enables the VS Code extension and CLI to coexist without stomping on each other's state.
 * Lock file path: `.runs/<workflowKey>/runner.json` in run storage.
 */
export interface RunnerHostIdentity {
  /** Runner process represented by this host identity. */
  runner: RunnerId;
  /** Stable identity for one VS Code Extension Host or CLI process. */
  hostInstanceId: string;
  /** OS process ID of the host. */
  pid: number;
}

export interface WorkflowRunnerLock {
  /** Persisted lock schema version. */
  schemaVersion: 2;
  /** Lineage this lock belongs to. */
  workflowKey: WorkflowKey;
  /** The exact run this lock is executing — never merely the viewed run. */
  runRef: RunRef;
  /** Which runner created this lock */
  runner: RunnerId;
  /** OS process ID of the runner (Extension Host PID for vscode, CLI process PID for cli) */
  pid: number;
  /** Stable identity for the process/Extension Host that owns this lock. */
  hostInstanceId: string;
  /** Identity of the workflow execution represented by this lock. */
  executionInstanceId: string;
  /**
   * Random token generated fresh on every acquire. Heartbeat/release must present a matching
   * token, so a stale process can never refresh or unlink a successor's lock.
   */
  ownerToken: string;
  /** Unix ms timestamp when execution started */
  startedAt: number;
  /** Unix ms timestamp updated every 5s while running — guards against PID recycling */
  lastHeartbeat: number;
}

// Re-export constants for convenience
export { EXECUTION_STATES };
