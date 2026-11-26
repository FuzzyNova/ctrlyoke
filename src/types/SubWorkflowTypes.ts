import type {
  PromptFile,
  ParsedPromptFile,
  RunRef,
  WorkingFileWorktreeRuntime,
  WorkflowKey,
} from "./CtrlYokeTypes";
import type {
  PromptTerminalStatus,
  SubWorkflowCancellationSource,
} from "./DashboardConstants";

/** Host boundary used by the shared workflow executor to launch child runs. */
export interface SubWorkflowHost {
  launch(request: SubWorkflowLaunchRequest): Promise<SubWorkflowHandle>;
}

/** Input needed to create or resume a child workflow run. */
export interface SubWorkflowLaunchRequest {
  source: { kind: "file"; resolvedPath: string };
  parent: SubWorkflowParentLink;
  parentExecution: {
    executionRoot: string;
    executionCheckoutRoot: string;
  };
  delegationChain: readonly string[];
  /** Reserved for child-run reattachment; ignored by this launcher round. */
  resumeChildRun?: { workflowKey: WorkflowKey; runRef: RunRef };
  /** Reserved for cycle detection; ignored by this launcher round. */
  ancestorPaths?: readonly string[];
  /** Passed to the instance factory; host-specific capability behavior is deferred. */
  concurrent?: boolean;
}

/** Durable identity of the parent step requesting the child run. */
export interface SubWorkflowParentLink {
  workflowKey: WorkflowKey;
  runRef: RunRef;
  stepId: string;
  loopIndex?: number;
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
    getState(): import("./CtrlYokeTypes").QueueState;
    onDidChangeState(
      listener: (state: import("./CtrlYokeTypes").QueueState) => void
    ): { dispose(): void };
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
  executeLoadedPromptFile(): Promise<void>;
  pause(): Promise<void>;
  cancelPause(): Promise<void>;
  stop(): Promise<void>;
}

export interface SubWorkflowInstanceOptions {
  concurrent: boolean;
  ancestorPaths: readonly string[];
  delegationChain: readonly string[];
}

export type SubWorkflowInstanceFactory = (
  options: SubWorkflowInstanceOptions
) => SubWorkflowInstance;
