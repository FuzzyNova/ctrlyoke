import * as fs from "fs/promises";
import { WorkingFileManager } from "../WorkingFileManager";
import { RunContinuationService } from "./RunContinuationService";
import { OutputHistoryManager } from "./OutputHistoryManager";
import { WorkflowLineageRepository } from "./WorkflowLineageRepository";
import type {
  RunnerHostIdentity,
  QueueState,
  RunRef,
  WorkflowKey,
  WorkflowRunAddress,
  WorkflowStep,
  WorkflowViewAddress,
  WorkingFile,
} from "../../types/CtrlYokeTypes";
import {
  EXECUTION_STATES,
  type HarnessId,
  USER_FEEDBACK_SEVERITY,
  WORKFLOW_LOCK_LIVENESS,
  WORKFLOW_LOCK_LOCALITIES,
  WORKFLOW_VIEW_ADDRESS_KIND,
  WORKTREE_EDIT_KINDS,
} from "../../types/DashboardConstants";
import type { DefinitionRollbackInvalidation } from "./RunViewPublisher";
import {
  notifyUserFeedback,
  type UserFeedbackSink,
} from "../UserFeedbackSink";
import { buildDefinitionSnapshot } from "../WorkflowStepSanitizer";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { getErrorMessage } from "../../utils/ErrorUtils";
import { Log } from "../../utils/Log";
import { readWorkflowLockOwnershipInspection } from "../../utils/WorkflowLockInspector";
import { getPtyProcessManager } from "../harness/PtyProcessManager";
import { isExecutionOwnerState } from "./WorkflowInstanceRegistry";

export interface RunLifecycleRegistryPort {
  getInstances(): Map<string, RunLifecycleInstancePort>;
  getRetiredInstances(): Map<string, RunLifecycleInstancePort>;
  getViewAddressRegistry(): Map<string, WorkflowViewAddress | null>;
  getViewMessageSinks(): Map<string, (message: unknown) => void>;
  getLineageExecutionOwners(): Map<WorkflowKey, { instanceId: string; promoted: boolean }>;
  getInstanceForClient(clientId: string): RunLifecycleInstancePort;
  setViewedWorkflowId(clientId: string, workflowId: string | null): void;
}

export interface RunLifecycleInstancePort {
  readonly id: string;
  getQueueState(): QueueState;
  getExecutionRunRef(): RunRef | undefined;
  ownsRunnerLock(): boolean;
  beginPendingRewind(
    workflowKey: WorkflowKey,
    runRef: RunRef,
    fromStepIndex: number,
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number
  ): Promise<{ definitionRevision: number; descriptorRevision: number }>;
  closeRetainedTerminalsForFreshRun(): Promise<void>;
  executeSeededRun(
    seeded: {
      workingFilePath: string;
      sourceRunRef: RunRef;
      runRef: RunRef;
      runId: number;
      runDir: string;
      stagingRunDir: string;
      stagingWorkingFilePath: string;
      allocation: import("./WorkflowLineageRepository").AllocatedRun;
      startedAt: number;
    },
    workflowKey: WorkflowKey,
    harnessOverride?: HarnessId,
    onPrepared?: () => Promise<void>
  ): Promise<void>;
  executeContinuationAtRun(
    workflowKey: WorkflowKey,
    runRef: RunRef,
    expectedDefinitionRevision: number,
    onPrepared?: () => Promise<void>
  ): Promise<void>;
  executeLoadedPromptFile(
    modeOverride?: HarnessId,
    continueFromCurrent?: boolean,
    preinitializedHistoryFilePath?: string,
    prePromotedFreshStart?: boolean,
    onPrepared?: () => Promise<void>
  ): Promise<void>;
}

export interface RunLifecycleViewPort {
  getViewAddress(clientId: string): WorkflowViewAddress | null;
  loadRunViewForClient(
    address: WorkflowViewAddress,
    send: (message: unknown) => void,
    clientId: string
  ): Promise<void>;
  publishRunRevisionsToViewers(
    workflowKey: WorkflowKey,
    runRef: RunRef
  ): Promise<void>;
  invalidateRunViews(
    workflowKey: WorkflowKey,
    runRef: RunRef,
    definitionRollback?: DefinitionRollbackInvalidation
  ): Promise<void>;
  pushRunSummariesRefreshIfNotAlreadyViewing(
    workflowKey: WorkflowKey,
    send: (message: unknown) => void,
    refreshedClientIds: string[],
    clientId: string
  ): Promise<void>;
}

export interface RunLifecycleServiceHost {
  readonly registry: RunLifecycleRegistryPort;
  readonly views: RunLifecycleViewPort;
  readonly panelClientId: string;
  readonly getWorkspaceRoot: () => string | undefined;
  readonly getLineageRepository: () => WorkflowLineageRepository;
  readonly getRunnerHostIdentity: () => RunnerHostIdentity;
  readonly getUserFeedbackSink: () => UserFeedbackSink;
  readonly getInstanceForClient: (clientId: string) => RunLifecycleInstancePort;
  readonly getStoredPanelSend: () => ((message: unknown) => void) | undefined;
  readonly assertNoPendingWorkflowExternalRoots: (clientId: string) => Promise<void>;
  readonly buildWorkflowInstance: () => RunLifecycleInstancePort;
  readonly replayWorkflowStateTo: (
    workflowId: string,
    send: (message: unknown) => void,
    clientId: string
  ) => Promise<void>;
  readonly getExternalExecutionRunRef: (
    workflowKey: WorkflowKey
  ) => RunRef | undefined;
}

export type SetStartPositionResult =
  | {
      kind: "seeded";
      runRef: RunRef;
      definitionRevision: number;
      descriptorRevision: number;
    }
  | {
      kind: typeof WORKTREE_EDIT_KINDS.REWIND;
      definitionRevision: number;
      descriptorRevision: number;
    };

export type DiscardContinuationResult =
  | { discarded: false; hasSuffixEdits: true }
  | {
      discarded: true;
      hasSuffixEdits: boolean;
      definitionRevision: number;
      descriptorRevision: number;
    };

export interface ExplicitContinuationValidation {
  workspaceRoot: string;
  activeInstance: RunLifecycleInstancePort | undefined;
  allowInterruptedRun: boolean;
  pendingRewindOnThisRun: boolean;
}

/** Owns addressed run identity decisions and run lifecycle actions. */
export class RunLifecycleService {
  constructor(private readonly host: RunLifecycleServiceHost) {}

  async setStartPositionAtRun(
    address: { workflowKey: WorkflowKey; runRef: RunRef },
    toIndex: number,
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number,
    clientId: string = this.host.panelClientId,
    options: { invalidateViews?: boolean } = {}
  ): Promise<SetStartPositionResult> {
    if (!Number.isInteger(toIndex) || toIndex < 0) {
      throw new Error("Start position must be a non-negative integer");
    }
    this.assertViewedRunAddress(address, clientId, "Set start position");
    const workspaceRoot = this.requireWorkspaceRoot();
    const activeForLineage = this.findActiveInstanceForLineage(
      address.workflowKey
    );
    if (
      activeForLineage &&
      activeForLineage.getExecutionRunRef() !== address.runRef
    ) {
      throw new Error("Another run in this workflow lineage is executing");
    }

    if (toIndex === 0) {
      if (activeForLineage) {
        throw new Error(
          "Cannot seed a new run while this workflow lineage is executing"
        );
      }
      const seeded = await WorkingFileManager.seedNewRun(
        workspaceRoot,
        address.workflowKey,
        address.runRef,
        {},
        this.host.getLineageRepository(),
        {
          definitionRevision: expectedDefinitionRevision,
          descriptorRevision: expectedDescriptorRevision,
        }
      );
      const seededAddress: Extract<WorkflowViewAddress, { kind: "run" }> = {
        workflowKey: address.workflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: seeded.runRef,
      };
      if (options.invalidateViews !== false) {
        await this.switchClientToRunAddress(seededAddress, clientId);
        await this.host.views.invalidateRunViews(
          address.workflowKey,
          address.runRef
        );
      }
      return {
        kind: "seeded",
        runRef: seeded.runRef,
        definitionRevision: 1,
        descriptorRevision: seeded.allocation.reservationDescriptorRevision,
      };
    }

    const targetPath = WorkflowPaths.runFilePath(
      workspaceRoot,
      address.workflowKey,
      address.runRef
    );
    const target = JSON.parse(
      await fs.readFile(targetPath, "utf8")
    ) as WorkingFile;
    if (toIndex >= (target.steps?.length ?? 0)) {
      throw new Error(
        "Start position must leave at least one suffix step to run"
      );
    }
    const targetState =
      target._runtime?.executionState ?? EXECUTION_STATES.IDLE;
    if (
      targetState === EXECUTION_STATES.RUNNING ||
      targetState === EXECUTION_STATES.PAUSING ||
      targetState === EXECUTION_STATES.CANCELLING
    ) {
      throw new Error(
        `Cannot set start position while in state ${targetState}`
      );
    }
    if (targetState === EXECUTION_STATES.PAUSED && !activeForLineage) {
      throw new Error(
        "Cannot rewind a paused run without its live execution owner"
      );
    }

    const loadedTarget = this.findResidentInstanceForRun(
      address.workflowKey,
      address.runRef
    );
    const result = loadedTarget
      ? await loadedTarget.beginPendingRewind(
          address.workflowKey,
          address.runRef,
          toIndex,
          expectedDefinitionRevision,
          expectedDescriptorRevision
        )
      : await WorkingFileManager.beginPendingRewind(
          workspaceRoot,
          address.workflowKey,
          address.runRef,
          toIndex,
          expectedDefinitionRevision,
          expectedDescriptorRevision,
          this.host.getLineageRepository()
        );
    await this.commitPendingRewindRevision(
      address.workflowKey,
      address.runRef,
      result.definitionRevision,
      JSON.parse(await fs.readFile(targetPath, "utf8")) as WorkingFile
    );
    if (options.invalidateViews !== false) {
      // Revision publication must precede view invalidation. The view load can
      // trigger another addressed action as soon as it reaches the client.
      await this.host.views.publishRunRevisionsToViewers(
        address.workflowKey,
        address.runRef
      );
      await this.host.views.invalidateRunViews(
        address.workflowKey,
        address.runRef
      );
    }
    return { kind: WORKTREE_EDIT_KINDS.REWIND, ...result };
  }

  async seedAndExecuteAtRun(
    address: WorkflowRunAddress,
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number,
    clientId: string = this.host.panelClientId
  ): Promise<{ runRef: RunRef }> {
    await this.host.assertNoPendingWorkflowExternalRoots(clientId);
    this.assertViewedRunAddress(address, clientId, "Re-run");
    const workspaceRoot = this.requireWorkspaceRoot();
    if (this.findExecutionRunRef(address.workflowKey)) {
      throw new Error(
        "Cannot seed a new run while this workflow lineage is executing"
      );
    }
    const seeded = await WorkingFileManager.seedNewRun(
      workspaceRoot,
      address.workflowKey,
      address.runRef,
      {},
      this.host.getLineageRepository(),
      {
        definitionRevision: expectedDefinitionRevision,
        descriptorRevision: expectedDescriptorRevision,
      },
      EXECUTION_STATES.RUNNING
    );
    await this.closeLineageTerminalsForFreshRun(address.workflowKey);
    const instance = this.host.buildWorkflowInstance();
    getPtyProcessManager()?.setPendingController(instance.id, clientId);
    let prepared = false;
    let resolvePrepared!: () => void;
    let rejectPrepared!: (error: unknown) => void;
    const preparedPromise = new Promise<void>((resolve, reject) => {
      resolvePrepared = resolve;
      rejectPrepared = reject;
    });
    void instance
      .executeSeededRun(seeded, address.workflowKey, undefined, async () => {
        await this.switchClientToPreparedExecution(instance, clientId);
        prepared = true;
        resolvePrepared();
      })
      .catch((error) => {
        if (!prepared) rejectPrepared(error);
        Log.error(
          `[WorkflowOrchestrator] Failed to execute seeded run: ${getErrorMessage(error)}`
        );
      });
    await preparedPromise;
    return { runRef: seeded.runRef };
  }

  async switchClientToRunAddress(
    address: Extract<WorkflowViewAddress, { kind: "run" }>,
    clientId: string
  ): Promise<void> {
    const send =
      this.host.registry.getViewMessageSinks().get(clientId) ??
      (clientId === this.host.panelClientId
        ? this.host.getStoredPanelSend()
        : undefined);
    if (!send) {
      this.host.registry.getViewAddressRegistry().set(clientId, address);
      return;
    }
    try {
      await this.host.views.loadRunViewForClient(address, send, clientId);
    } catch (error) {
      Log.warn(
        `[WorkflowOrchestrator] Failed to switch ${clientId} to run ${address.runRef}: ${getErrorMessage(error)}`
      );
      this.host.registry.getViewAddressRegistry().set(clientId, address);
    }
  }

  async closeLineageTerminalsForFreshRun(
    workflowKey: WorkflowKey
  ): Promise<void> {
    const residents = new Set([
      ...this.host.registry.getInstances().values(),
      ...this.host.registry.getRetiredInstances().values(),
    ]);
    await Promise.all(
      [...residents]
        .filter(
          (instance) => instance.getQueueState().workflowKey === workflowKey
        )
        .map((instance) => instance.closeRetainedTerminalsForFreshRun())
    );
  }

  async switchClientToPreparedExecution(
    instance: RunLifecycleInstancePort,
    clientId: string
  ): Promise<void> {
    const instances = this.host.registry.getInstances();
    const retiredInstances = this.host.registry.getRetiredInstances();
    if (!instances.has(instance.id) && !retiredInstances.has(instance.id)) {
      retiredInstances.set(instance.id, instance);
    }
    const workflowKey = instance.getQueueState().workflowKey;
    if (workflowKey) {
      this.host.registry.getLineageExecutionOwners().set(workflowKey, {
        instanceId: instance.id,
        promoted: false,
      });
    }
    const send =
      this.host.registry.getViewMessageSinks().get(clientId) ??
      (clientId === this.host.panelClientId
        ? this.host.getStoredPanelSend()
        : undefined);
    if (!send) {
      this.host.registry.setViewedWorkflowId(clientId, instance.id);
      return;
    }
    await this.host.replayWorkflowStateTo(instance.id, send, clientId);
  }

  async executeDraftAtAddress(
    address: Extract<WorkflowViewAddress, { kind: "draft" }>,
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number,
    clientId: string = this.host.panelClientId
  ): Promise<void> {
    await this.host.assertNoPendingWorkflowExternalRoots(clientId);
    const viewed = this.host.views.getViewAddress(clientId);
    if (
      !viewed ||
      viewed.kind !== WORKFLOW_VIEW_ADDRESS_KIND.DRAFT ||
      viewed.workflowKey !== address.workflowKey
    ) {
      throw new Error("Run no longer targets this client's viewed draft");
    }
    const workspaceRoot = this.requireWorkspaceRoot();
    const descriptor = await this.host
      .getLineageRepository()
      .readDescriptor(workspaceRoot, address.workflowKey);
    if (descriptor.revision !== expectedDescriptorRevision) {
      throw new Error(
        `Descriptor revision conflict: expected ${expectedDescriptorRevision}, found ${descriptor.revision}`
      );
    }
    const draft = JSON.parse(
      await fs.readFile(
        WorkflowPaths.draftFilePath(workspaceRoot, address.workflowKey),
        "utf8"
      )
    ) as WorkingFile;
    if ((draft.definitionRevision ?? 1) !== expectedDefinitionRevision) {
      throw new Error("Definition revision conflict while running draft");
    }
    const instance = this.findInstanceForClient(clientId);
    let prepared = false;
    let resolvePrepared!: () => void;
    let rejectPrepared!: (error: unknown) => void;
    const preparedPromise = new Promise<void>((resolve, reject) => {
      resolvePrepared = resolve;
      rejectPrepared = reject;
    });
    void instance
      .executeLoadedPromptFile(undefined, false, "", false, async () => {
        const state = instance.getQueueState();
        if (state.workflowKey && state.runRef) {
          await this.switchClientToRunAddress(
            {
              workflowKey: state.workflowKey,
              kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
              runRef: state.runRef,
            },
            clientId
          );
        }
        prepared = true;
        resolvePrepared();
      })
      .catch((error) => {
        if (!prepared) rejectPrepared(error);
        Log.error(
          `[WorkflowOrchestrator] Failed to execute draft: ${getErrorMessage(error)}`
        );
      });
    await preparedPromise;
  }

  async startNewRunInsteadAtRun(
    address: WorkflowRunAddress,
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number,
    confirmEditedSuffix: boolean,
    clientId: string = this.host.panelClientId
  ): Promise<{ runRef: RunRef } | { hasSuffixEdits: true }> {
    this.assertViewedRunAddress(address, clientId, "Start new run instead");
    if (this.findExecutionRunRef(address.workflowKey)) {
      throw new Error(
        "Cannot seed a new run while this workflow lineage is executing"
      );
    }
    const discarded = await this.discardContinuationAtRun(
      address,
      expectedDefinitionRevision,
      expectedDescriptorRevision,
      confirmEditedSuffix,
      clientId,
      false
    );
    if (!discarded.discarded) return { hasSuffixEdits: true };
    return this.seedAndExecuteAtRun(
      address,
      discarded.definitionRevision,
      discarded.descriptorRevision,
      clientId
    );
  }

  static describeViewAddress(
    address: WorkflowViewAddress | null | undefined
  ): string {
    if (!address) return "(none)";
    return address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN
      ? `${address.workflowKey}/${address.runRef}`
      : `${address.workflowKey}/draft`;
  }

  private assertViewedRunAddress(
    address: WorkflowRunAddress,
    clientId: string,
    action: string
  ): void {
    const viewed = this.host.views.getViewAddress(clientId);
    if (
      !viewed ||
      viewed.kind !== WORKFLOW_VIEW_ADDRESS_KIND.RUN ||
      viewed.workflowKey !== address.workflowKey ||
      viewed.runRef !== address.runRef
    ) {
      throw new Error(
        `${action} no longer targets this client's viewed run ` +
          `(targeted: ${address.workflowKey}/${address.runRef}, ` +
          `viewing: ${RunLifecycleService.describeViewAddress(viewed)})`
      );
    }
  }

  async appendAndContinueAtRun(
    address: { workflowKey: WorkflowKey; runRef: RunRef },
    tail: WorkflowStep[],
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number,
    clientId: string = this.host.panelClientId
  ): Promise<{ definitionRevision: number; descriptorRevision: number }> {
    await this.host.assertNoPendingWorkflowExternalRoots(clientId);
    const {
      workspaceRoot,
      activeInstance,
      allowInterruptedRun,
      pendingRewindOnThisRun,
    } = await this.validateExplicitContinuationTarget(
      address,
      expectedDefinitionRevision,
      expectedDescriptorRevision,
      clientId
    );
    if (pendingRewindOnThisRun) {
      await WorkingFileManager.commitPendingRewind(
        workspaceRoot,
        address.workflowKey,
        address.runRef,
        expectedDefinitionRevision,
        expectedDescriptorRevision,
        this.host.getLineageRepository()
      );
    }
    const appended = await RunContinuationService.appendStepsToRun(
      workspaceRoot,
      address.workflowKey,
      address.runRef,
      tail,
      expectedDefinitionRevision,
      this.host.getLineageRepository(),
      allowInterruptedRun
    );
    const instance =
      activeInstance ??
      this.findResidentInstanceForRun(address.workflowKey, address.runRef) ??
      this.host.buildWorkflowInstance();
    getPtyProcessManager()?.setPendingController(instance.id, clientId);
    await instance.executeContinuationAtRun(
      address.workflowKey,
      address.runRef,
      appended.definitionRevision,
      () => this.switchClientToPreparedExecution(instance, clientId)
    );
    await this.host.views.invalidateRunViews(address.workflowKey, address.runRef);
    return {
      definitionRevision: appended.definitionRevision,
      descriptorRevision: appended.descriptorRevision,
    };
  }

  async continueAtRun(
    address: { workflowKey: WorkflowKey; runRef: RunRef },
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number,
    clientId: string = this.host.panelClientId
  ): Promise<void> {
    await this.host.assertNoPendingWorkflowExternalRoots(clientId);
    const { workspaceRoot, activeInstance, pendingRewindOnThisRun } =
      await this.validateExplicitContinuationTarget(
        address,
        expectedDefinitionRevision,
        expectedDescriptorRevision,
        clientId
      );
    if (pendingRewindOnThisRun) {
      await WorkingFileManager.commitPendingRewind(
        workspaceRoot,
        address.workflowKey,
        address.runRef,
        expectedDefinitionRevision,
        expectedDescriptorRevision,
        this.host.getLineageRepository()
      );
    }
    const instance =
      activeInstance ??
      this.findResidentInstanceForRun(address.workflowKey, address.runRef) ??
      this.host.buildWorkflowInstance();
    getPtyProcessManager()?.setPendingController(instance.id, clientId);
    await instance.executeContinuationAtRun(
      address.workflowKey,
      address.runRef,
      expectedDefinitionRevision,
      () => this.switchClientToPreparedExecution(instance, clientId)
    );
    await this.host.views.invalidateRunViews(address.workflowKey, address.runRef);
  }

  async validateExplicitContinuationTarget(
    address: { workflowKey: WorkflowKey; runRef: RunRef },
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number,
    clientId: string
  ): Promise<ExplicitContinuationValidation> {
    this.assertViewedRunAddress(address, clientId, "Continuation");
    const workspaceRoot = this.requireWorkspaceRoot();
    const descriptor = await this.host
      .getLineageRepository()
      .readDescriptor(workspaceRoot, address.workflowKey);
    if (descriptor.revision !== expectedDescriptorRevision) {
      throw new Error(
        `Descriptor revision conflict: expected ${expectedDescriptorRevision}, found ${descriptor.revision}`
      );
    }
    const pendingRewindOnThisRun =
      descriptor.pendingEdit?.kind === WORKTREE_EDIT_KINDS.REWIND &&
      descriptor.pendingEdit.runRef === address.runRef;
    if (descriptor.pendingEdit && !pendingRewindOnThisRun) {
      throw new Error("This workflow has a draft or pending continuation");
    }

    const activeInstance = this.findActiveInstanceForLineage(
      address.workflowKey
    );
    if (
      activeInstance &&
      activeInstance.getExecutionRunRef() !== address.runRef
    ) {
      throw new Error("Another run in this workflow lineage is executing");
    }
    if (
      activeInstance &&
      activeInstance.getQueueState().status !== EXECUTION_STATES.PAUSED
    ) {
      throw new Error("Cannot continue while this run is actively executing");
    }

    const lockInspection = await readWorkflowLockOwnershipInspection(
      workspaceRoot,
      address.workflowKey,
      this.host.getRunnerHostIdentity(),
      {
        onIdentityDiagnostic: (diagnostic) =>
          Log.warn(
            `[WorkflowOrchestrator] continuation lock identity contradiction: ${JSON.stringify(diagnostic)}`
          ),
      }
    );
    const activeInspection =
      lockInspection.liveness === WORKFLOW_LOCK_LIVENESS.ACTIVE
        ? lockInspection
        : undefined;
    const activeLock = activeInspection?.lock;
    const lockNamesTarget = activeLock?.runRef === address.runRef;
    if (activeLock && !activeInstance) {
      if (activeInspection.locality === WORKFLOW_LOCK_LOCALITIES.SELF) {
        const retainedResident = lockNamesTarget
          ? this.findResidentInstanceForRun(address.workflowKey, address.runRef)
          : undefined;
        if (!retainedResident?.ownsRunnerLock()) {
          Log.error(
            `[WorkflowOrchestrator] self-owned but untracked execution for ${address.workflowKey}/${activeLock.runRef}`
          );
          throw new Error(
            "Self-owned execution is not tracked by this process; refusing continuation"
          );
        }
      } else if (
        activeInspection.locality === WORKFLOW_LOCK_LOCALITIES.INDETERMINATE
      ) {
        throw new Error(
          "Cannot continue while execution ownership is indeterminate"
        );
      } else {
        throw new Error(
          lockNamesTarget
            ? "The requested run is executing in another process"
            : "Another run in this workflow lineage is executing"
        );
      }
    }
    if (activeLock && !lockNamesTarget) {
      throw new Error("Another run in this workflow lineage is executing");
    }

    const target = JSON.parse(
      await fs.readFile(
        WorkflowPaths.runFilePath(
          workspaceRoot,
          address.workflowKey,
          address.runRef
        ),
        "utf8"
      )
    ) as WorkingFile;
    if ((target.definitionRevision ?? 1) !== expectedDefinitionRevision) {
      throw new Error(
        `Definition revision conflict: expected ${expectedDefinitionRevision}, found ${target.definitionRevision ?? 1}`
      );
    }
    const targetState =
      target._runtime?.executionState ?? EXECUTION_STATES.IDLE;
    const activeTarget =
      activeInstance?.getExecutionRunRef() === address.runRef;
    const interruptedRun =
      (targetState === EXECUTION_STATES.RUNNING ||
        targetState === EXECUTION_STATES.PAUSED) &&
      !activeTarget &&
      lockInspection.liveness !== WORKFLOW_LOCK_LIVENESS.ACTIVE;
    if (
      targetState === EXECUTION_STATES.PAUSING ||
      targetState === EXECUTION_STATES.CANCELLING ||
      ((targetState === EXECUTION_STATES.RUNNING ||
        targetState === EXECUTION_STATES.PAUSED) &&
        !activeTarget &&
        !interruptedRun)
    ) {
      throw new Error(`Cannot continue while run is in state ${targetState}`);
    }
    return {
      workspaceRoot,
      activeInstance,
      allowInterruptedRun: interruptedRun,
      pendingRewindOnThisRun,
    };
  }

  async discardContinuationAtRun(
    address: { workflowKey: WorkflowKey; runRef: RunRef },
    expectedDefinitionRevision: number,
    expectedDescriptorRevision: number,
    confirmEditedSuffix: boolean = false,
    clientId: string = this.host.panelClientId,
    invalidate: boolean = true
  ): Promise<DiscardContinuationResult> {
    this.assertViewedRunAddress(address, clientId, "Discard continuation");
    const workspaceRoot = this.requireWorkspaceRoot();
    const result = await WorkingFileManager.discardPendingRewind(
      workspaceRoot,
      address.workflowKey,
      address.runRef,
      expectedDefinitionRevision,
      expectedDescriptorRevision,
      confirmEditedSuffix,
      this.host.getLineageRepository()
    );
    if (!result.discarded) return result;
    if (invalidate) {
      await this.host.views.invalidateRunViews(
        address.workflowKey,
        address.runRef,
        {
          fromRevision: expectedDefinitionRevision,
          restoredRevision: result.definitionRevision,
          descriptorRevision: result.descriptorRevision,
        }
      );
    }
    return result;
  }

  async commitPendingRewindRevision(
    workflowKey: WorkflowKey,
    runRef: RunRef,
    definitionRevision: number,
    workingFile: WorkingFile
  ): Promise<void> {
    const workspaceRoot = this.requireWorkspaceRoot();
    await new OutputHistoryManager(workspaceRoot).commitDefinitionRevision(
      WorkflowPaths.manifestPath(workspaceRoot, workflowKey, runRef),
      {
        definitionRevision,
        definition: buildDefinitionSnapshot(
          workingFile.workflowName ?? "",
          workingFile.steps ?? [],
          workingFile._runtime?.pendingRewind?.fromStepIndex,
          workingFile.finalStep,
          workingFile.worktree,
          workingFile.parallelGroups
        ),
      }
    );
  }

  async deleteRunAtAddress(
    address: { workflowKey: WorkflowKey; runRef: RunRef },
    send: (message: unknown) => void,
    clientId: string = this.host.panelClientId
  ): Promise<void> {
    if (this.findExecutionRunRef(address.workflowKey) === address.runRef) {
      throw new Error("Cannot delete an executing run");
    }
    const workspaceRoot = this.requireWorkspaceRoot();
    const historyManager = new OutputHistoryManager(workspaceRoot);
    const deletedRunId = (
      await historyManager.getRunSummaries(address.workflowKey)
    ).find((summary) => summary.runRef === address.runRef)?.runId;
    await historyManager.deleteRunByRef(address.workflowKey, address.runRef);
    const remaining = await historyManager.getRunSummaries(address.workflowKey);
    const fallback: WorkflowViewAddress = remaining[0]
      ? {
          workflowKey: address.workflowKey,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          runRef: remaining[0].runRef,
        }
      : { workflowKey: address.workflowKey, kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT };
    const targets = [...this.host.registry.getViewAddressRegistry().entries()].filter(
      ([, candidate]) => candidate?.workflowKey === address.workflowKey
    );
    const displacedAViewer = targets.some(
      ([, currentAddress]) =>
        currentAddress?.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN &&
        currentAddress.runRef === address.runRef
    );
    await Promise.all(
      targets.map(async ([targetClientId, currentAddress]) => {
        const targetAddress =
          currentAddress?.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN &&
          currentAddress.runRef === address.runRef
            ? fallback
            : currentAddress;
        if (!targetAddress) return;
        const targetSend =
          targetClientId === clientId
            ? send
            : this.host.registry.getViewMessageSinks().get(targetClientId);
        if (!targetSend) return;
        await this.host.views.loadRunViewForClient(
          targetAddress,
          targetSend,
          targetClientId
        );
      })
    );
    if (displacedAViewer) {
      const fallbackLabel =
        fallback.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN
          ? `Run ${remaining[0].runId}`
          : "the draft";
      const message =
        deletedRunId !== undefined
          ? `Run ${deletedRunId} was deleted — you're now viewing ${fallbackLabel}.`
          : `That run was deleted — you're now viewing ${fallbackLabel}.`;
      this.notifyUserFeedback(message);
    }
    await this.host.views.pushRunSummariesRefreshIfNotAlreadyViewing(
      address.workflowKey,
      send,
      targets.map(([targetClientId]) => targetClientId),
      clientId
    );
  }

  async deleteAllRunsForLineage(
    workflowKey: WorkflowKey,
    send: (message: unknown) => void,
    clientId: string = this.host.panelClientId
  ): Promise<void> {
    const workspaceRoot = this.requireWorkspaceRoot();
    const historyManager = new OutputHistoryManager(workspaceRoot);
    const executionRunRef = this.findExecutionRunRef(workflowKey);
    const runRefs = await historyManager.getRunsForWorkflow(workflowKey);
    for (const runRef of runRefs) {
      if (runRef === executionRunRef) continue;
      try {
        await historyManager.deleteRunByRef(workflowKey, runRef);
      } catch (error) {
        Log.warn(
          `[WorkflowOrchestrator] deleteAllRunsForLineage: failed to delete ${workflowKey}/${runRef}:`,
          error
        );
      }
    }
    const remaining = await historyManager.getRunSummaries(workflowKey);
    const fallback: WorkflowViewAddress = remaining[0]
      ? {
          workflowKey,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          runRef: remaining[0].runRef,
        }
      : { workflowKey, kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT };
    const targets = [...this.host.registry.getViewAddressRegistry().entries()].filter(
      ([, candidate]) => candidate?.workflowKey === workflowKey
    );
    await Promise.all(
      targets.map(async ([targetClientId, currentAddress]) => {
        const targetAddress =
          currentAddress?.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN &&
          currentAddress.runRef !== executionRunRef
            ? fallback
            : currentAddress;
        if (!targetAddress) return;
        const targetSend =
          targetClientId === clientId
            ? send
            : this.host.registry.getViewMessageSinks().get(targetClientId);
        if (!targetSend) return;
        await this.host.views.loadRunViewForClient(
          targetAddress,
          targetSend,
          targetClientId
        );
      })
    );
    await this.host.views.pushRunSummariesRefreshIfNotAlreadyViewing(
      workflowKey,
      send,
      targets.map(([targetClientId]) => targetClientId),
      clientId
    );
  }

  findExecutionRunRef(workflowKey: WorkflowKey): RunRef | undefined {
    for (const instance of this.host.registry.getInstances().values()) {
      const state = instance.getQueueState();
      if (
        state.workflowKey === workflowKey &&
        isExecutionOwnerState(state.status)
      ) {
        return instance.getExecutionRunRef() ?? state.runRef;
      }
    }
    return this.host.getExternalExecutionRunRef(workflowKey);
  }

  findResidentInstanceForRun(
    workflowKey: WorkflowKey,
    runRef: RunRef
  ): RunLifecycleInstancePort | undefined {
    const matches = (instance: RunLifecycleInstancePort) => {
      const state = instance.getQueueState();
      return state.workflowKey === workflowKey && state.runRef === runRef;
    };
    return (
      [...this.host.registry.getInstances().values()].find(matches) ??
      [...this.host.registry.getRetiredInstances().values()].find(matches)
    );
  }

  private findActiveInstanceForLineage(
    workflowKey: WorkflowKey
  ): RunLifecycleInstancePort | undefined {
    return [...this.host.registry.getInstances().values()].find((instance) => {
      const state = instance.getQueueState();
      return (
        state.workflowKey === workflowKey && isExecutionOwnerState(state.status)
      );
    });
  }

  private findInstanceForClient(clientId: string): RunLifecycleInstancePort {
    return this.host.getInstanceForClient(clientId);
  }

  private requireWorkspaceRoot(): string {
    const workspaceRoot = this.host.getWorkspaceRoot();
    if (!workspaceRoot) throw new Error("No workspace folder is open");
    return workspaceRoot;
  }

  private notifyUserFeedback(message: string): void {
    notifyUserFeedback(
      this.host.getUserFeedbackSink(),
      USER_FEEDBACK_SEVERITY.INFO,
      message
    );
  }
}
