import {
  type HarnessId,
  type PreviewPermissionAction,
  type PreviewPermissionRuleStatus,
  type PreviewMutationScope,
  type PreviewPropertySource,
  type PreviewPromptCategory,
  type PreviewStepType,
  type PreviewTruncationReason,
  type WorktreeMode,
} from "./DashboardConstants";
import type { CompatibilityDiagnostic } from "./CompatibilityTypes";
import type { CommandDisplayShell } from "./CommandDisplayFormatter";

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
  diagnostics: CompatibilityDiagnostic[];
  /** Absent when the workflow is not configured to use a worktree. */
  worktree?: WorktreeExecutionPreview;
}

export interface WorktreeExecutionPreview {
  mode: WorktreeMode;
  /** Which tier supplied the mode: the workflow itself, or a settings default. */
  origin: "authored" | "default";
  branch?: string;
  base?: string;
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
  stepName?: string;
  type: PreviewStepType;
  resolvedProperties: ResolvedPropertiesPreview;
  prompt?: CategorizedPromptPreview;
  command?: CommandPreview;
  permissionApplication?: PermissionApplicationPreview;
  mcpApplication?: McpApplicationPreview;
  workspaceMutations: WorkspaceMutationPreview[];
  variables: VariableResolutionPreview[];
  conditions: ConditionPreview;
  diagnostics: CompatibilityDiagnostic[];
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
  maxExecutionSeconds?: number;
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
