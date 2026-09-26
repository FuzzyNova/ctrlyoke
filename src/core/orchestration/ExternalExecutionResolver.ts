import * as fs from "fs/promises";
import type {
  RunnerHostIdentity,
  WorkflowKey,
  WorkflowRunnerLock,
  WorkingFile,
} from "../../types/CtrlYokeTypes";
import {
  ACTIVE_EXECUTION_STATES,
  EXTERNAL_EXECUTION_REASONS,
  EXTERNAL_EXECUTION_RESOLUTION_KINDS,
  EXTERNAL_EXECUTION_DECISION_STATES,
  EXTERNAL_EXECUTION_WATCH_ACTIONS,
  EXECUTION_STATES,
  WORKFLOW_LOCK_LIVENESS,
  WORKFLOW_LOCK_LOCALITIES,
  type ExternalExecutionReason,
  type ExternalExecutionWatchAction,
  type WorkflowLockLocality,
  type ExecutionState,
} from "../../types/DashboardConstants";
import {
  isExternalOwnedLock,
  readWorkflowLockOwnershipInspection,
  type WorkflowLockInspection,
  type WorkflowLockInspectionOptions,
} from "../../utils/WorkflowLockInspector";
import * as WorkflowPaths from "../../utils/WorkflowPaths";

/** Stable reasons why a working file is not eligible for external execution. */
export type NotExternalReason = ExternalExecutionReason;

/** The narrowed lock proof required to observe an external execution. */
export type ActiveExternalLockInspection = {
  liveness: typeof WORKFLOW_LOCK_LIVENESS.ACTIVE;
  locality: typeof WORKFLOW_LOCK_LOCALITIES.EXTERNAL;
  lock: WorkflowRunnerLock;
};

export type ExternalExecutionResolution =
  | {
      kind: typeof EXTERNAL_EXECUTION_RESOLUTION_KINDS.NOT_EXTERNAL;
      reason: NotExternalReason;
    }
  | {
      kind: typeof EXTERNAL_EXECUTION_RESOLUTION_KINDS.EXTERNAL_ACTIVE_RUN;
      workingFile: WorkingFile;
      inspection: ActiveExternalLockInspection;
    };

export interface ExternalExecutionResolverOptions extends WorkflowLockInspectionOptions {
  /** Override disk access for isolated tests and other orchestration adapters. */
  readWorkingFile?: (workingFilePath: string) => Promise<unknown>;
  /** Override structured lock inspection for deterministic race simulation. */
  inspectLock?: (
    workspaceRoot: string,
    workflowKey: WorkflowKey,
    observer: RunnerHostIdentity,
    options: WorkflowLockInspectionOptions
  ) => Promise<WorkflowLockInspection>;
  /** Receives the same decision that is emitted to the diagnostic log. */
  onDecision?: (decision: ExternalExecutionDecisionLog) => void;
}

/** Structured, secret-free decision record emitted by the resolver. */
export interface ExternalExecutionDecisionLog {
  event: "external-execution-resolution";
  workflowKey?: string;
  runRef?: string;
  persistedExecutionState?: ExecutionState;
  lockLiveness:
    | WorkflowLockInspection["liveness"]
    | typeof EXTERNAL_EXECUTION_DECISION_STATES.NOT_INSPECTED;
  lockRunner?: WorkflowRunnerLock["runner"];
  observerHostId?: string;
  lockHostId?: string;
  hostIdsMatch?: boolean;
  pidsMatch?: boolean;
  pidRelationship?: "same" | "different";
  locality?: WorkflowLockLocality;
  reason?:
    | NotExternalReason
    | typeof EXTERNAL_EXECUTION_RESOLUTION_KINDS.EXTERNAL_ACTIVE_RUN;
  externalWatchEligible: boolean;
  watchAction: ExternalExecutionWatchAction;
}

/** Stateless service that resolves whether one exact working file is external. */
export class ExternalExecutionResolver {
  constructor(
    private readonly workspaceRoot: string,
    private readonly observer: RunnerHostIdentity,
    private readonly options: ExternalExecutionResolverOptions = {}
  ) {}

  /**
   * Resolve external ownership for the exact working file supplied by the caller.
   * The lock is read twice so the returned inspection proves one stable acquisition.
   */
  async resolve(workingFilePath: string): Promise<ExternalExecutionResolution> {
    const address =
      WorkflowPaths.parseWorkingFileAddressFromPath(workingFilePath);
    const decision: ExternalExecutionDecisionLog = {
      event: "external-execution-resolution",
      workflowKey: address?.workflowKey,
      runRef: address?.runRef,
      lockLiveness: EXTERNAL_EXECUTION_DECISION_STATES.NOT_INSPECTED,
      externalWatchEligible: false,
      watchAction: EXTERNAL_EXECUTION_WATCH_ACTIONS.REJECTED,
    };

    if (!address) {
      return this.finish(
        decision,
        this.notExternal(EXTERNAL_EXECUTION_REASONS.UNREADABLE_WORKING_FILE)
      );
    }

    let workingFile: WorkingFile;
    try {
      const rawWorkingFile = await (
        this.options.readWorkingFile ?? readWorkingFile
      )(workingFilePath);
      if (!isWorkingFile(rawWorkingFile)) {
        return this.finish(
          decision,
          this.notExternal(EXTERNAL_EXECUTION_REASONS.UNREADABLE_WORKING_FILE)
        );
      }
      workingFile = rawWorkingFile;
    } catch {
      return this.finish(
        decision,
        this.notExternal(EXTERNAL_EXECUTION_REASONS.UNREADABLE_WORKING_FILE)
      );
    }

    const persistedExecutionState = workingFile._runtime?.executionState;
    if (persistedExecutionState === undefined) {
      return this.finish(
        {
          ...decision,
          lockLiveness: EXTERNAL_EXECUTION_DECISION_STATES.NOT_INSPECTED,
        },
        this.notExternal(EXTERNAL_EXECUTION_REASONS.TERMINAL_RUN)
      );
    }
    if (!isExecutionState(persistedExecutionState)) {
      return this.finish(
        decision,
        this.notExternal(EXTERNAL_EXECUTION_REASONS.UNREADABLE_WORKING_FILE)
      );
    }

    decision.persistedExecutionState = persistedExecutionState;
    if (!ACTIVE_EXECUTION_STATES.has(persistedExecutionState)) {
      return this.finish(
        decision,
        this.notExternal(EXTERNAL_EXECUTION_REASONS.TERMINAL_RUN)
      );
    }

    const firstInspection = await this.inspectLock(address.workflowKey);
    if (!isExternalOwnedLock(firstInspection)) {
      return this.finish(
        decision,
        this.notExternal(getNotExternalReason(firstInspection)),
        firstInspection
      );
    }

    if (!sameAddress(firstInspection.lock, address)) {
      return this.finish(
        decision,
        this.notExternal(EXTERNAL_EXECUTION_REASONS.RUN_REF_MISMATCH),
        firstInspection
      );
    }

    const secondInspection = await this.inspectLock(address.workflowKey);
    if (!isExternalOwnedLock(secondInspection)) {
      return this.finish(
        decision,
        this.notExternal(getNotExternalReason(secondInspection)),
        secondInspection
      );
    }

    if (firstInspection.lock.ownerToken !== secondInspection.lock.ownerToken) {
      return this.finish(
        decision,
        this.notExternal(EXTERNAL_EXECUTION_REASONS.NO_ACTIVE_LOCK),
        secondInspection
      );
    }

    if (!sameAddress(secondInspection.lock, address)) {
      return this.finish(
        decision,
        this.notExternal(EXTERNAL_EXECUTION_REASONS.RUN_REF_MISMATCH),
        secondInspection
      );
    }

    const resolution: ExternalExecutionResolution = {
      kind: EXTERNAL_EXECUTION_RESOLUTION_KINDS.EXTERNAL_ACTIVE_RUN,
      workingFile,
      inspection: secondInspection,
    };
    decision.externalWatchEligible = true;
    decision.watchAction = EXTERNAL_EXECUTION_WATCH_ACTIONS.ELIGIBLE;
    return this.finish(decision, resolution, secondInspection);
  }

  private async inspectLock(
    workflowKey: WorkflowKey
  ): Promise<WorkflowLockInspection> {
    try {
      return await (
        this.options.inspectLock ?? readWorkflowLockOwnershipInspection
      )(this.workspaceRoot, workflowKey, this.observer, this.options);
    } catch {
      return { liveness: WORKFLOW_LOCK_LIVENESS.ABSENT };
    }
  }

  private notExternal(reason: NotExternalReason): ExternalExecutionResolution {
    return {
      kind: EXTERNAL_EXECUTION_RESOLUTION_KINDS.NOT_EXTERNAL,
      reason,
    };
  }

  private finish(
    decision: ExternalExecutionDecisionLog,
    resolution: ExternalExecutionResolution,
    inspection?: WorkflowLockInspection
  ): ExternalExecutionResolution {
    const enrichedDecision = addInspectionDetails(
      decision,
      inspection,
      this.observer
    );
    if (resolution.kind === "not-external") {
      enrichedDecision.reason = resolution.reason;
    } else {
      enrichedDecision.reason =
        EXTERNAL_EXECUTION_RESOLUTION_KINDS.EXTERNAL_ACTIVE_RUN;
    }
    this.options.onDecision?.(enrichedDecision);
    if (!this.options.onDecision) {
      // This module is also used by the Node-only MCP/CLI boundaries, where
      // importing the VS Code-backed Log utility would make resolution fail.
      // Node-only diagnostic fallback.
      /* eslint-disable no-console -- console is the CLI/MCP sink. */
      const log =
        enrichedDecision.locality === WORKFLOW_LOCK_LOCALITIES.INDETERMINATE
          ? console.warn
          : console.debug;
      log("External execution resolution", enrichedDecision);
      /* eslint-enable no-console */
    }
    return resolution;
  }
}

/** Convenience function for callers that do not need to retain a resolver object. */
export function resolveExternalExecution(
  workingFilePath: string,
  workspaceRoot: string,
  observer: RunnerHostIdentity,
  options: ExternalExecutionResolverOptions = {}
): Promise<ExternalExecutionResolution> {
  return new ExternalExecutionResolver(
    workspaceRoot,
    observer,
    options
  ).resolve(workingFilePath);
}

async function readWorkingFile(workingFilePath: string): Promise<unknown> {
  const content = await fs.readFile(workingFilePath, "utf8");
  return JSON.parse(content) as unknown;
}

function isWorkingFile(value: unknown): value is WorkingFile {
  if (!isRecord(value)) {
    return false;
  }
  if (
    typeof value.startedAt !== "number" ||
    !Number.isFinite(value.startedAt) ||
    !Array.isArray(value.steps) ||
    !value.steps.every(isRecord)
  ) {
    return false;
  }
  if (
    value.definitionRevision !== undefined &&
    (typeof value.definitionRevision !== "number" ||
      !Number.isInteger(value.definitionRevision) ||
      value.definitionRevision < 1)
  ) {
    return false;
  }
  if (value.finalStep !== undefined && !isRecord(value.finalStep)) {
    return false;
  }
  if (value._runtime !== undefined && !isRecord(value._runtime)) {
    return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExecutionState(value: unknown): value is ExecutionState {
  return Object.values(EXECUTION_STATES).includes(value as ExecutionState);
}

function sameAddress(
  lock: WorkflowRunnerLock,
  address: { workflowKey: WorkflowKey; runRef?: string }
): boolean {
  return (
    lock.workflowKey === address.workflowKey && lock.runRef === address.runRef
  );
}

function getNotExternalReason(
  inspection: WorkflowLockInspection
): NotExternalReason {
  if (inspection.liveness !== WORKFLOW_LOCK_LIVENESS.ACTIVE) {
    return EXTERNAL_EXECUTION_REASONS.NO_ACTIVE_LOCK;
  }
  if (inspection.locality === WORKFLOW_LOCK_LOCALITIES.SELF) {
    return EXTERNAL_EXECUTION_REASONS.SELF_OWNED;
  }
  if (inspection.locality === WORKFLOW_LOCK_LOCALITIES.INDETERMINATE) {
    return EXTERNAL_EXECUTION_REASONS.INDETERMINATE_OWNER;
  }
  return EXTERNAL_EXECUTION_REASONS.NO_ACTIVE_LOCK;
}

function addInspectionDetails(
  decision: ExternalExecutionDecisionLog,
  inspection: WorkflowLockInspection | undefined,
  observer: RunnerHostIdentity
): ExternalExecutionDecisionLog {
  if (!inspection) {
    return decision;
  }
  if (inspection.liveness === WORKFLOW_LOCK_LIVENESS.ABSENT) {
    return { ...decision, lockLiveness: inspection.liveness };
  }
  return {
    ...decision,
    lockLiveness: inspection.liveness,
    lockRunner: inspection.lock.runner,
    observerHostId: shortenHostId(observer.hostInstanceId),
    lockHostId: shortenHostId(inspection.lock.hostInstanceId),
    pidRelationship:
      inspection.lock.pid === observer.pid ? "same" : "different",
    ...(inspection.liveness === WORKFLOW_LOCK_LIVENESS.ACTIVE
      ? {
          hostIdsMatch:
            inspection.lock.hostInstanceId !== undefined &&
            inspection.lock.hostInstanceId === observer.hostInstanceId,
          pidsMatch: inspection.lock.pid === observer.pid,
          locality: inspection.locality,
        }
      : {}),
  };
}

function shortenHostId(hostInstanceId: string | undefined): string | undefined {
  if (!hostInstanceId) return undefined;
  return hostInstanceId.length <= 8
    ? hostInstanceId
    : `${hostInstanceId.slice(0, 8)}…`;
}
