import {
  type HarnessId,
  type PreviewPermissionAction,
  type PreviewPermissionRuleStatus,
  type PreviewMutationScope,
  type PreviewPropertySource,
  type PreviewPromptCategory,
  type PreviewStepType,
  type PreviewTruncationReason,
  type WorktreeConfigOrigin,
  type WorktreeMode,
} from "./DashboardConstants";
import type { CompatibilityDiagnostic } from "./CompatibilityTypes";
import type { CommandDisplayShell } from "./CommandDisplayFormatter";
import type { ParallelGroupDefinition } from "./CtrlYokeTypes";
import type { SUB_WORKFLOW_SOURCE_KINDS } from "./SubWorkflowTypes";

export type { CommandDisplayShell } from "./CommandDisplayFormatter";

export type {
  PreviewPermissionAction,
  PreviewPermissionRuleStatus,
  PreviewMutationScope,
  PreviewPropertySource,
  PreviewPromptCategory,
  PreviewStepType,
  PreviewTruncationReason,
} from "./DashboardConstants";

export interface RedactionSpan {
  start: number;
  end: number;
  ruleId: string;
  replacement: string;
}

export interface WorkflowExecutionPreview {
  workflow: WorkflowPreviewSummary;
  steps: StepExecutionPreview[];
  parallelGroups: ParallelGroupDefinition[];
  parallelGroupPreflights: ParallelGroupPreflightPreview[];
  diagnostics: CompatibilityDiagnostic[];
  /** Absent when the workflow is not configured to use a worktree. */
  worktree?: WorktreeExecutionPreview;
  /**
   * Workflow-root and worktree fields whose authored `{{name}}` placeholders
   * were substituted (`harness`, `maxSteps`, `worktree.branch`, ...).
   */
  substitutions?: SubstitutedFieldPreview[];
  /**
   * Fields whose substitution failed its policy. A run would stop on each
   * before any side effect: a run-start blocker fails the whole run start,
   * a step blocker fails that step. Blocked steps have no step preview.
   */
  substitutionBlockers?: VariableSubstitutionBlockerPreview[];
}

/** One field whose authored placeholders were substituted. */
export interface SubstitutedFieldPreview {
  /** Field path, relative to the step for a step's own list. */
  path: string;
  /** The authored text, placeholders included. */
  authored: string;
  /** The value the run uses. */
  value: string;
}

/** A variable substitution that fails validation, reported instead of thrown. */
export interface VariableSubstitutionBlockerPreview {
  /** The failure, naming the field, the variable and its value. */
  message: string;
  /** The blocked step; absent for a run-start (workflow-level) blocker. */
  stepIndex?: number;
}

export interface ParallelGroupPreflightPreview {
  parallelGroupId: string;
  effectiveWidth: number;
  executableMemberCount: number;
}

export interface WorktreeExecutionPreview {
  mode: WorktreeMode;
  /** Which tier supplied the mode: the workflow itself, or a settings default. */
  origin: WorktreeConfigOrigin;
  branch?: string;
  /** The authored named-worktree `directory`, when one was set. */
  directory?: string;
  /** Branch the existing `directory` holds now, before any switch. */
  directoryCurrentBranch?: string;
  switchBlocker?: string;
  base?: string;
  /** Setup command after variable substitution, as it will be executed. */
  setupCommand?: string;
  eligible: boolean;
  eligibilityReason?: string;
  /** The directory the run is expected to execute in, when knowable without
   *  creating anything. Absent for managed mode (its path depends on a
   *  run ID assigned only when the workflow actually runs). */
  plannedDirectory?: string;
  /** True when `plannedDirectory` was confirmed against an existing Git
   *  worktree entry rather than computed as a best guess. */
  plannedDirectoryIsExact: boolean;
  /** Explains why `plannedDirectory` is absent, or why it is only a guess. */
  plannedDirectoryNotice?: string;
}

export interface WorkflowPreviewSummary {
  name: string;
  stepCount: number;
  sourcePath?: string;
  definitionRevision?: string;
  harnessIds: HarnessId[];
  totalByteCount: number;
  totalTokenEstimate: number;
  workspaceMutationCount: number;
}

export interface StepExecutionPreview {
  stepIndex: number;
  stepId?: string;
  parallelGroupId?: string;
  stepName?: string;
  type: PreviewStepType;
  resolvedProperties: ResolvedPropertiesPreview;
  prompt?: CategorizedPromptPreview;
  command?: CommandPreview;
  permissionApplication?: PermissionApplicationPreview;
  sandbox?: EffectiveSandboxPreview;
  mcpApplication?: McpApplicationPreview;
  workspaceMutations: WorkspaceMutationPreview[];
  variables: VariableResolutionPreview[];
  conditions: ConditionPreview;
  diagnostics: CompatibilityDiagnostic[];
  /** This step's fields whose authored placeholders were substituted. */
  substitutions?: SubstitutedFieldPreview[];
  /** Present for a `type: workflow` step; see {@link SubWorkflowStepPreview}. */
  subWorkflow?: SubWorkflowStepPreview;
}

/**
 * What a `type: workflow` step's preview stands for. The preview never
 * expands a child workflow's steps (v1).
 *
 * - `file`: the step previews as one `workflow`-type entry, "Runs <file>".
 *   The child resolves its own harness, model and settings when it starts,
 *   so the entry carries no prompt or command, and its `resolvedProperties`
 *   (kept for the DTO's shape) are not the child's; show `workflowPath`.
 * - `inline`: the step previews as the prompt or script step it wraps,
 *   materialized as at launch (D13): the parent's workflow-level properties
 *   and effective vars, substituted by the child. `worktree` is the child's
 *   own managed or named worktree; absent when it runs in the parent's
 *   checkout or the main checkout.
 */
export type SubWorkflowStepPreview =
  | {
      source: typeof SUB_WORKFLOW_SOURCE_KINDS.FILE;
      /** The authored path; a workflow path is never substituted (D11). */
      workflowPath: string;
    }
  | {
      source: typeof SUB_WORKFLOW_SOURCE_KINDS.INLINE;
      /** The child run's name: the step's name, else parent and position. */
      childName: string;
      worktree?: WorktreeExecutionPreview;
    };

export interface EffectiveSandboxPreview {
  kind: "on" | "off" | "harness";
  detail?: string;
}

export interface ResolvedPropertiesPreview {
  harnessId: HarnessId;
  harnessVersion?: string;
  model?: string;
  executionMode?: string;
  continuationMode?: string;
  session: SessionPreview;
  agent?: string;
  skills: string[];
  /** Granted names only; values are intentionally never part of a preview DTO. */
  secrets?: string[];
  mcpServerIds: string[];
  hooks: HookPreview[];
  permissions: PermissionSettingsPreview;
  limits: ExecutionLimitsPreview;
  conditions: ConditionPreview;
  propertySources: Record<string, PreviewPropertySource>;
}

export interface SessionPreview {
  present: boolean;
  resolutionSource?: string;
}

export interface HookPreview {
  event: string;
  command: string;
  redactions: RedactionSpan[];
  inlineConfigFragment?: string;
  inlineConfigRedactions?: RedactionSpan[];
}

export interface PermissionSettingsPreview {
  mode?: string;
  allowedRules: string[];
  deniedRules: string[];
}

export interface ExecutionLimitsPreview {
  maxQueueSteps?: number;
  maxStepsSource?: "workflow maxSteps" | "setting queue.maxSteps";
  maxExecutionSeconds?: number;
  maxPromptTimeoutSeconds?: number;
  scriptTimeoutSeconds?: number;
  maxTokens?: number;
  violations: string[];
}

export interface CategorizedPromptPreview {
  sections: CategorizedPromptSectionPreview[];
  totalByteCount: number;
  includedBodyByteCount: number;
  bodyBudgetBytes: number;
}

export interface CategorizedPromptSectionPreview {
  category: PreviewPromptCategory;
  byteCount: number;
  lineCount: number | null;
  tokenEstimate: number | null;
  chunkIndex: number;
  contentHash: string | null;
  body?: string;
  truncationReason?: PreviewTruncationReason;
  path?: string;
  providerReference?: string;
  modifiedTimeMs?: number;
}

export interface CommandPreview {
  executable: string;
  args: string[];
  displayCommand: string;
  /** Shell dialect `displayCommand` is quoted for; the dashboard offers a
   * toggle to re-render `args` for another dialect (see
   * `CommandDisplayFormatter.renderCommandForDisplay`). */
  displayShell: CommandDisplayShell;
  /** True when `args` is already a fully cmd.exe-escaped verbatim payload
   * (the `.cmd`/`.bat` launcher fallback) — re-rendering for another shell
   * would mangle it, so the dashboard must not offer the toggle. */
  requiresShellVerbatimArgs: boolean;
  /** True when a headless prompt is sent on stdin, so `args` and
   * `displayCommand` do not contain it. */
  promptOnStdin?: boolean;
  cwd: string;
  environmentKeys: string[];
}

export interface PermissionApplicationPreview {
  effectiveMode?: string;
  rules: PermissionRulePreview[];
  nativeArguments: string[];
  workspaceMutation?: WorkspaceMutationPreview;
  diagnostics: CompatibilityDiagnostic[];
}

export interface PermissionRulePreview {
  action: PreviewPermissionAction;
  rule: string;
  status: PreviewPermissionRuleStatus;
  nativeRule?: string;
  reason?: string;
}

export interface McpApplicationPreview {
  injectionMethod: string;
  servers: McpServerPreview[];
}

export interface McpServerPreview {
  id: string;
  transport: string;
  toolFilters: string[];
  environmentKeys: string[];
  injectionMethod?: string;
  inlineConfigFragment?: string;
  inlineConfigRedactions?: RedactionSpan[];
}

export interface WorkspaceMutationPreview {
  path?: string;
  scope: PreviewMutationScope;
  ownedKeys: string[];
  operation: string;
  warning?: string;
}

export interface VariableResolutionPreview {
  name: string;
  source: PreviewPropertySource;
  value: string;
  redactions: RedactionSpan[];
}

export interface ConditionPreview {
  pre: ConditionDefinitionPreview[];
  end: ConditionDefinitionPreview[];
  retry: RetryPreview;
  errorBehavior?: string;
}

export interface ConditionDefinitionPreview {
  kind: string;
  configured: boolean;
  scriptPath?: string;
  description?: string;
}

export interface RetryPreview {
  maxAttempts: number;
  backoffSeconds?: number;
}
