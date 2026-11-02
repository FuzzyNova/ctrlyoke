import type { RunRef, WorkflowKey } from "./CtrlYokeTypes";
import type {
  WorkflowRunManifest,
  WorkflowTimelineEvent,
} from "./WorkflowTimelineTypes";
import type { ExecutionState } from "./DashboardConstants";

/**
 * A run bundle: one run exported as a reviewable directory
 * (dev/backlog/RUN_EXPORT_PLAN.md §3). Paths inside it are portable
 * (`src/utils/RunBundlePaths.ts`) and its identity is provenance only.
 */
export const RUN_BUNDLE_KIND = "ctrlyoke.run.bundle" as const;
export const RUN_BUNDLE_SCHEMA_VERSION = 1 as const;
export const RUN_BUNDLE_DIR_SUFFIX = ".ctrlyokerun";

export const RUN_BUNDLE_FILES = {
  BUNDLE: "run.json",
  DEFINITION: "workflow.ctrlyoke.json",
  MANIFEST: "manifest.json",
  EVENTS: "events.jsonl",
  RUNTIME: "run.ctrlyoke.json",
  CHANGES: "changes.patch",
  ASSETS_DIR: "assets",
} as const;

/** The redaction pass every export applies (§2.1): resolved secrets plus heuristics. */
export const RUN_BUNDLE_REDACTION_POLICY = "secrets-v1" as const;

export const RUN_BUNDLE_CONTINUATION_KINDS = {
  QUEUE: "queue",
  FINAL_STEP: "finalStep",
} as const;

export const RUN_BUNDLE_WORKTREE_MODES = {
  NONE: "none",
  MANAGED: "managed",
  NAMED: "named",
} as const;
export type RunBundleWorktreeMode =
  (typeof RUN_BUNDLE_WORKTREE_MODES)[keyof typeof RUN_BUNDLE_WORKTREE_MODES];

/**
 * Where an imported run's `changes.patch` lands (§4, §5.3). These are the
 * `ctrlyoke import --changes` values; the dashboard import modal uses the
 * same ones.
 */
export const RUN_CHANGES_TARGETS = {
  /** A new managed worktree at the base commit; the checkout is untouched. */
  WORKTREE: "worktree",
  /** The importing checkout, which must be clean and at the base commit. */
  CHECKOUT: "checkout",
  /** The user synced the code; compare and warn, apply nothing. */
  SKIP: "skip",
} as const;
export type RunChangesTarget =
  (typeof RUN_CHANGES_TARGETS)[keyof typeof RUN_CHANGES_TARGETS];

/**
 * The target used when none is chosen (§4): a managed run gets a new managed
 * worktree, `none`/`named` the checkout. Never adjusted for a dirty checkout;
 * that fails loudly instead of falling back.
 */
export function defaultRunChangesTarget(
  mode: RunBundleWorktreeMode
): RunChangesTarget {
  return mode === RUN_BUNDLE_WORKTREE_MODES.MANAGED
    ? RUN_CHANGES_TARGETS.WORKTREE
    : RUN_CHANGES_TARGETS.CHECKOUT;
}

/** Outcome of `RunBundleImporter.importRun` and `ctrlyoke import --json`. */
export const RUN_IMPORT_STATUSES = {
  IMPORTED: "imported",
  ALREADY_IMPORTED: "alreadyImported",
} as const;

/** `importedFrom.kind` on a lineage or run imported from elsewhere. */
export const RUN_IMPORT_SOURCE_KINDS = {
  RUN_BUNDLE: "runBundle",
} as const;

export interface RunBundleContinuation {
  executionState: ExecutionState;
  nextStep:
    | { kind: typeof RUN_BUNDLE_CONTINUATION_KINDS.QUEUE; stepIndex: number }
    | { kind: typeof RUN_BUNDLE_CONTINUATION_KINDS.FINAL_STEP; pass: number };
  pendingStepCount: number;
  worktreeMode: RunBundleWorktreeMode;
  workspace: {
    baseCommit: string;
    branch: string;
    patch?: {
      file: typeof RUN_BUNDLE_FILES.CHANGES;
      sha256: string;
      files: number;
      binary: number;
    };
  };
}

/** What a step ran with; informational, never used to resume a session. */
export interface RunBundleStepProvenance {
  stepIndex: number;
  harness?: string;
  model?: string;
  sessionId?: string;
}

export interface RunBundleManifest {
  schemaVersion: typeof RUN_BUNDLE_SCHEMA_VERSION;
  kind: typeof RUN_BUNDLE_KIND;
  exportedAt: string;
  exportedByVersion: string;
  /**
   * The exporting workspace, home-relative where possible. Recorded for the
   * reader only: a loader resolves `${workspaceFolder}` against its own
   * workspace, never against this.
   */
  sourceRoot: string;
  lineage: { workflowName: string; originalFile?: string };
  provenance: {
    workflowKey: WorkflowKey;
    runRef: RunRef;
    runId: number;
    steps: RunBundleStepProvenance[];
  };
  /** Origin chain when the exported run was itself imported. */
  importedFrom?: import("./CtrlYokeTypes").WorkingFileRuntime["importedFrom"];
  /** Workspace snapshot, undo and redo events; dropped unless asked for. */
  includesSnapshots: boolean;
  /** Whether the bundle retained per-chunk deltas; absent in legacy bundles (kept). */
  includesStreamDeltas?: boolean;
  redaction: {
    policy: typeof RUN_BUNDLE_REDACTION_POLICY;
    removedCount: number;
    /** Removals per rule id (`exact-secret`, `bearer-token`, ...). */
    byRule: Record<string, number>;
    /** Removals per bundle file name. */
    byFile?: Record<string, number>;
  };
  /** Absolute paths the run touched outside the workspace and home. */
  externalPaths: string[];
  /** Bundled files referenced by the definition; absent in 0.2.0 bundles. */
  assets?: Array<{ path: string; sha256: string; bytes: number }>;
  /** Present when the run has pending work and can continue. */
  continuation?: RunBundleContinuation;
}

/** A timeline event in a bundle: the run identity is in `provenance` instead. */
export type RunBundleEvent = WithoutRunIdentity<WorkflowTimelineEvent>;

/** Distributes over the event union so each member keeps its own payload type. */
type WithoutRunIdentity<Event> = Event extends unknown
  ? Omit<Event, "workflowId" | "runId">
  : never;

/** The run manifest in a bundle, its identity demoted to `provenance`. */
export type RunBundleRunManifest = Omit<
  WorkflowRunManifest,
  "workflowId" | "runId"
>;
