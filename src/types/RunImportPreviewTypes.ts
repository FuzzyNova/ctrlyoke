import type { HarnessId } from "./DashboardConstants";
import type { McpServerConfig, ScriptProperties } from "./CtrlYokeTypes";

export type RunImportSessionAvailability =
  "available" | "missing" | "unknown" | "malformed";

export interface RunImportPreviewProvenance {
  workflowName: string;
  sourceRoot: string;
  exportedAt: string;
  exportedByVersion: string;
  alreadyImported?: { workflowKey: string; runRef?: string };
}

export type RunImportChangesTarget =
  "managed-worktree" | "current-checkout" | "skip";

export interface RunImportPreviewContinuation {
  baseCommit: {
    commit: string;
    exists: boolean;
    instruction?: string;
  };
  worktreeMode: "none" | "managed" | "named";
  defaultChangesTarget: RunImportChangesTarget;
  allowedChangesTargets: RunImportChangesTarget[];
  checkoutClean: boolean;
  checkoutAtBaseCommit: boolean;
  patchFileCount: number;
}

export interface RunImportPreviewPendingStep {
  stepIndex: number;
  name?: string;
  kind: "prompt" | "script";
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
}
