import type { RunRef, WorkflowKey } from "./CtrlYokeTypes";
import type {
  WorkflowRunManifest,
  WorkflowTimelineEvent,
} from "./WorkflowTimelineTypes";

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
} as const;

/** The redaction pass every export applies (§2.1): resolved secrets plus heuristics. */
export const RUN_BUNDLE_REDACTION_POLICY = "secrets-v1" as const;

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
  /** Workspace snapshot, undo and redo events; dropped unless asked for. */
  includesSnapshots: boolean;
  redaction: {
    policy: typeof RUN_BUNDLE_REDACTION_POLICY;
    removedCount: number;
    /** Removals per rule id (`exact-secret`, `bearer-token`, ...). */
    byRule: Record<string, number>;
  };
  /** Absolute paths the run touched outside the workspace and home. */
  externalPaths: string[];
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
