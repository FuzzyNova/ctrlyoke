import type {
  PromptFile,
  ParsedPromptFile,
  QueueState,
  RunRef,
  WorkingFileWorktreeRuntime,
  WorkflowKey,
} from "./CtrlYokeTypes";
import type {
  PromptTerminalStatus,
  SubWorkflowCancellationSource,
  SubWorkflowWorktreePlacement,
} from "./DashboardConstants";
import { FINAL_STEP_PHASES } from "./DashboardConstants";

export const SUB_WORKFLOW_SOURCE_KINDS = {
  FILE: "file",
  INLINE: "inline",
} as const;

/** Host boundary used by the shared workflow executor to launch child runs. */
export interface SubWorkflowHost {
  launch(request: SubWorkflowLaunchRequest): Promise<SubWorkflowHandle>;
}

/** Input needed to create or resume a child workflow run. */
export interface SubWorkflowLaunchRequest {
  source:
    | {
        kind: typeof SUB_WORKFLOW_SOURCE_KINDS.FILE;
        resolvedPath: string;
        /**
         * The child file as parallel-group preflight already parsed it. The
         * launcher loads this instead of parsing the file again.
         */
        parsed?: ParsedPromptFile;
      }
    | {
        kind: typeof SUB_WORKFLOW_SOURCE_KINDS.INLINE;
        definition: PromptFile;
        displayName: string;
        parentDefinition: InlineParentDefinition;
      };
  parent: SubWorkflowParentLink;
  parentExecution: {
    /** Where a child with no `worktree` key runs (D4a). */
    executionRoot: string;
    /**
     * The parent's checkout. An inheriting child runs in it (D4a); a child
     * with its own worktree uses it as its source checkout (D4b): it branches
     * from its `HEAD`, targets its branch and `merge: true` lands in it.
     */
    executionCheckoutRoot: string;
    prepareWorktreeChild?: () => Promise<void>;
  };
  delegationChain: readonly string[];
  /** Continue this exact child run instead of creating a new lineage. */
  resumeChildRun?: { workflowKey: WorkflowKey; runRef: RunRef };
  stateRoot: string;
  /** Reserved for cycle detection; ignored by this launcher round. */
  ancestorPaths?: readonly string[];
  /**
   * True for a member of a parallel group that runs beside its siblings. The
   * CLI factory then builds a headless-only child, so concurrent children
   * never compete for the one TTY (R5).
   */
  concurrent: boolean;
}

/** How a sub-workflow child uses checkouts, from its own `worktree` key. */
export interface SubWorkflowWorktreePlan {
  readonly placement: SubWorkflowWorktreePlacement;
  /** A managed worktree with `merge: true`: it merges into the parent's checkout (D4b). */
  readonly mergesIntoParent: boolean;
}

/**
 * A sub-workflow step's child, resolved (and, for a file, parsed) before it
 * launches. Parallel-group preflight builds one per member and the launch
 * reuses it; a failure settles the member FAILED under its `onFail`.
 */
export type PreparedSubWorkflowLaunch =
  | {
      readonly ok: true;
      readonly source: SubWorkflowLaunchRequest["source"];
      /** The child file's absolute path; absent for an inline child. */
      readonly resolvedPath?: string;
      /**
       * How the child uses checkouts, from its definition's `worktree` key.
       * Absent while a file child is still unparsed.
       */
      readonly worktreePlan?: SubWorkflowWorktreePlan;
      /**
       * The group already ran the D4c parent-checkout check for this member
       * before fan-out, so its launch must not run it again.
       */
      readonly parentCheckoutPrepared?: boolean;
    }
  | { readonly ok: false; readonly failureMessage: string };

/**
 * The parent definition an inline child was authored in. The child has no
 * file of its own, so it resolves definition-relative references and
 * workflow-scoped trust approvals against the parent's file, mapped from the
 * same source checkout the parent maps it from.
 */
export interface InlineParentDefinition {
  /** The parent's authored definition path, before any worktree mapping. */
  sourceDefinitionPath?: string;
  /** The checkout that path lives in (the parent's source checkout). */
  sourceCheckoutRoot?: string;
  /** Trust identity used by the parent when it has no authored source file. */
  trustIdentityPath?: string;
}

/** Load-time inputs a parent hands to the child instance it launches. */
export interface SubWorkflowLoadOptions {
  parentRun?: SubWorkflowParentLink;
  parentExecution?: SubWorkflowLaunchRequest["parentExecution"];
  delegationChain?: readonly string[];
  /** Only for an inline child; see {@link InlineParentDefinition}. */
  parentDefinition?: InlineParentDefinition;
}

/** Durable identity of the parent step requesting the child run. */
export type SubWorkflowParentLink = {
  workflowKey: WorkflowKey;
  runRef: RunRef;
} & (
  | { phase: typeof FINAL_STEP_PHASES.QUEUE; stepId: string }
  | { phase: typeof FINAL_STEP_PHASES.FINAL_STEP; loopIndex: number }
);

export function isSameSubWorkflowParentLink(
  left: SubWorkflowParentLink | undefined,
  right: SubWorkflowParentLink
): boolean {
  if (
    !left ||
    left.workflowKey !== right.workflowKey ||
    left.runRef !== right.runRef ||
    left.phase !== right.phase
  )
    return false;
  return left.phase === FINAL_STEP_PHASES.QUEUE
    ? right.phase === FINAL_STEP_PHASES.QUEUE && left.stepId === right.stepId
    : right.phase === FINAL_STEP_PHASES.FINAL_STEP &&
        left.loopIndex === right.loopIndex;
}

/** The stop/pause controls a parent forwards to the child its step runs. */
export interface SubWorkflowControl {
  pause(): Promise<void>;
  /** Resume a pausing or paused child; never awaits the child's remaining run. */
  cancelPause(): Promise<void>;
  stop(): Promise<void>;
}

/** Control surface and run identity for a launched child. */
export interface SubWorkflowHandle extends SubWorkflowControl {
  readonly workflowKey: WorkflowKey;
  readonly runRef: RunRef;
  readonly done: Promise<SubWorkflowResult>;
}

/** Terminal outcome of the child run. */
export interface SubWorkflowResult {
  status: Extract<PromptTerminalStatus, "completed" | "failed" | "cancelled">;
  cancelledBy?: SubWorkflowCancellationSource;
  failedToStart?: boolean;
  failureMessage?: string;
  worktree?: Pick<
    WorkingFileWorktreeRuntime,
    | "mode"
    | "branchName"
    | "baseCommit"
    | "finalBranchTip"
    | "changedFileCount"
    | "landingOutcome"
    | "mergeOutcome"
    | "conflictFiles"
  >;
}

/** Narrow instance surface needed by SubWorkflowLauncher. */
export interface SubWorkflowInstance {
  /** Identifies the instance to the host that created it. */
  readonly id: string;
  readonly promptQueue: {
    getState(): QueueState;
    onDidChangeState(listener: (state: QueueState) => void): {
      dispose(): void;
    };
    getWorkflowFile(): PromptFile & {
      _runtime?: { worktree?: WorkingFileWorktreeRuntime };
    };
  };
  loadPromptFile(
    filePath: string,
    parsedPromptFile?: ParsedPromptFile | null,
    options?: {
      parentRun?: SubWorkflowParentLink;
      parentExecution?: SubWorkflowLaunchRequest["parentExecution"];
      delegationChain?: readonly string[];
    }
  ): Promise<boolean>;
  loadFromMemoryOrThrow(
    promptFile: PromptFile,
    displayName: string,
    options?: SubWorkflowLoadOptions
  ): Promise<string | undefined>;
  executeLoadedPromptFile(): Promise<void>;
  executeContinuationAtRun(
    workflowKey: WorkflowKey,
    runRef: RunRef,
    expectedDefinitionRevision: number,
    onPrepared?: () => Promise<void>,
    options?: {
      parentRun: SubWorkflowParentLink;
      parentExecution: SubWorkflowLaunchRequest["parentExecution"];
      delegationChain: readonly string[];
      parentDefinition?: InlineParentDefinition;
    }
  ): Promise<void>;
  pause(): Promise<void>;
  cancelPause(): Promise<void>;
  /** Resume a PAUSED run; starts a new execution cycle on the same run. */
  resume(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Settles when the current execution cycle ends. A run that pauses at a
   * step boundary ends its cycle, and `resume()` starts the next one.
   */
  whenExecutionSettled(): Promise<void>;
  /** Fires once when the instance is disposed (host shutdown). */
  onDidDispose(listener: () => void): { dispose(): void };
  /**
   * Fires when an execution cycle (a start, a continuation or a resume) is
   * RUNNING inside its startup guard: the first point at which `stop()` and
   * `pause()` act on that cycle. Before it, a child being loaded, rewound or
   * reopened is IDLE, STOPPED or PAUSED, where a stop falls back to the
   * detector and a pause is rejected.
   */
  onDidStartExecutionCycle(listener: () => void): { dispose(): void };
}

export interface SubWorkflowInstanceOptions {
  concurrent: boolean;
  ancestorPaths: readonly string[];
  delegationChain: readonly string[];
}

export type SubWorkflowInstanceFactory = (
  options: SubWorkflowInstanceOptions
) => SubWorkflowInstance;
