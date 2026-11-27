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
      }
    | {
        kind: typeof SUB_WORKFLOW_SOURCE_KINDS.INLINE;
        definition: PromptFile;
        displayName: string;
        parentDefinition: InlineParentDefinition;
      };
  parent: SubWorkflowParentLink;
  parentExecution: {
    executionRoot: string;
    executionCheckoutRoot: string;
    prepareWorktreeChild?: () => Promise<void>;
  };
  delegationChain: readonly string[];
  /** Continue this exact child run instead of creating a new lineage. */
  resumeChildRun?: { workflowKey: WorkflowKey; runRef: RunRef };
  stateRoot: string;
  /** Reserved for cycle detection; ignored by this launcher round. */
  ancestorPaths?: readonly string[];
  /** Passed to the instance factory; host-specific capability behavior is deferred. */
  concurrent?: boolean;
}

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

/** Control surface and run identity for a launched child. */
export interface SubWorkflowHandle {
  readonly workflowKey: WorkflowKey;
  readonly runRef: RunRef;
  readonly done: Promise<SubWorkflowResult>;
  pause(): Promise<void>;
  cancelPause(): Promise<void>;
  stop(): Promise<void>;
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
}

export interface SubWorkflowInstanceOptions {
  concurrent: boolean;
  ancestorPaths: readonly string[];
  delegationChain: readonly string[];
}

export type SubWorkflowInstanceFactory = (
  options: SubWorkflowInstanceOptions
) => SubWorkflowInstance;
