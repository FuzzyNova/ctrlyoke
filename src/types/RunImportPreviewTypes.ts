import type {
  HarnessId,
  SessionAvailability,
  STEP_TYPES,
} from "./DashboardConstants";
import type { McpServerConfig, ScriptProperties } from "./CtrlYokeTypes";
import type { RunBundleWorktreeMode, RunChangesTarget } from "./RunBundleTypes";

export type RunImportSessionAvailability = SessionAvailability;

export interface RunImportPreviewProvenance {
  workflowName: string;
  sourceRoot: string;
  exportedAt: string;
  exportedByVersion: string;
  alreadyImported?: { workflowKey: string; runRef?: string };
}

export type RunImportChangesTarget = RunChangesTarget;

export interface RunImportPreviewContinuation {
  baseCommit: {
    commit: string;
    exists: boolean;
    instruction?: string;
  };
  worktreeMode: RunBundleWorktreeMode;
  /** What `ctrlyoke import` uses without `--changes` (`defaultRunChangesTarget`). */
  defaultChangesTarget: RunImportChangesTarget;
  /** Targets that can succeed here; `checkout` only when clean at base. */
  allowedChangesTargets: RunImportChangesTarget[];
  checkoutClean: boolean;
  checkoutAtBaseCommit: boolean;
  patchFileCount: number;
}

export interface RunImportPreviewPendingStep {
  stepIndex: number;
  name?: string;
  kind: (typeof STEP_TYPES)[keyof typeof STEP_TYPES];
  promptPreview?: string;
  script?: ScriptProperties;
  preCondition?: ScriptProperties;
  endCondition?: ScriptProperties;
  additionalArgs?: string;
  mcpServers?: (string | McpServerConfig)[] | null;
  secretGrants: Array<{ name: string; approved: boolean }>;
  harness?: HarnessId;
  model?: string;
  previouslyUsed?: { harness?: string; model?: string };
  promptRedacted: boolean;
}

export interface RunImportPreviewSession {
  stepIndex: number;
  sessionId?: string;
  harness: HarnessId;
  availability: RunImportSessionAvailability;
  executedStepIndices: number[];
  notFromThisRun: boolean;
  hint?: string;
}

export interface RunImportPreviewBlocker {
  code: "base-commit-missing" | "missing-asset";
  message: string;
  stepIndex?: number;
  path?: string;
}

/** Serializable, workspace-specific preview shown before importing or continuing a run. */
export interface RunImportPreview {
  provenance: RunImportPreviewProvenance;
  continuable: boolean;
  continuation?: RunImportPreviewContinuation;
  pendingSteps: RunImportPreviewPendingStep[];
  sessions: RunImportPreviewSession[];
  blockers: RunImportPreviewBlocker[];
  warnings?: string[];
}
