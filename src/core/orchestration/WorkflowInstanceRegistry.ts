import * as path from "path";
import { HarnessCapabilityRegistry } from "../HarnessCapabilityRegistry";
import { HarnessIntegration } from "../HarnessIntegration";
import { IntegrationFactory } from "../IntegrationFactory";
import { WorkflowInstance } from "../WorkflowInstance";
import type { PlatformAdapter } from "../../platform/PlatformAdapter";
import type {
  QueueState,
  PromptFile,
  RunnerHostIdentity,
  WorkflowKey,
  WorkflowViewAddress,
} from "../../types/CtrlYokeTypes";
import { workflowDisplayStep } from "../../types/CtrlYokeTypes";
import {
  EXECUTION_STATES,
  TERMINAL_SESSION_STATUS,
  WORKFLOW_VIEW_ADDRESS_KIND,
  type HarnessId,
} from "../../types/DashboardConstants";
import type { IDashboardSink } from "../../types/IDashboardSink";
import type { ActiveTerminalWorkflowRef } from "../../types/WebviewMessageTypes";
import type { HarnessUsageSnapshot } from "../../types/UsageTypes";
import type { UserFeedbackSink } from "../UserFeedbackSink";
import type { UserInteractionPort } from "../../ui/UserInteractionPort";
import { getPtyProcessManager } from "../harness/PtyProcessManager";
import { Log } from "../../utils/Log";
import type { RunViewPublisherRegistryPort } from "./RunViewPublisher";
import type { RunLifecycleRegistryPort } from "./RunLifecycleService";

export interface LineageExecutionClaim {
  instanceId: string;
  promoted: boolean;
}

export function isExecutionOwnerState(status: QueueState["status"]): boolean {
  return (
    status === EXECUTION_STATES.RUNNING ||
    status === EXECUTION_STATES.PAUSING ||
    status === EXECUTION_STATES.PAUSED ||
    status === EXECUTION_STATES.CANCELLING
  );
}

export function isSpentExecutionOwnerState(
  status: QueueState["status"]
): boolean {
  return (
    status === EXECUTION_STATES.COMPLETED ||
    status === EXECUTION_STATES.ERROR ||
    status === EXECUTION_STATES.STOPPED
  );
}

export function lineageAddressOf(
  state: QueueState | undefined
): WorkflowViewAddress | null {
  if (!state?.workflowKey) return null;
  return state.runRef
    ? {
        workflowKey: state.workflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: state.runRef,
      }
    : {
        workflowKey: state.workflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      };
}

export interface WorkflowInstanceRegistryBuildPort {
  readonly platform: PlatformAdapter;
  readonly dashboardSink: IDashboardSink;
  readonly dashboardBroadcast: WorkflowInstanceRegistryBroadcastPort;
  readonly integrationFactory: IntegrationFactory;
  readonly resolveDetectorIntegration: (
    harnessOverride?: HarnessId
  ) => HarnessIntegration;
  readonly propagateWorkflowNameToIntegrations: (
    name: string | undefined
  ) => void;
  readonly updateStatusBar: () => void;
  readonly currentWorkspaceFolderPath: string | undefined;
  readonly compatibilityRegistry: HarnessCapabilityRegistry;
  readonly userFeedbackSink: UserFeedbackSink;
  readonly getHarnessUsageSnapshots: () => HarnessUsageSnapshot[];
  readonly refreshHarnessUsage: (harnessId: HarnessId) => Promise<void>;
  readonly approveSecretGrantsForWorkflow: (
    workflow: PromptFile,
    workspaceRoot: string
  ) => Promise<void>;
  readonly runnerHostIdentity: RunnerHostIdentity;
}

export interface WorkflowInstanceRegistryBroadcastPort {
  readonly notifyWorkflowAdded: (
    summary: ReturnType<WorkflowInstance["getSummary"]>
  ) => void;
  readonly notifyWorkflowSummaryUpdated: (
    summary: ReturnType<WorkflowInstance["getSummary"]>
  ) => void;
  readonly notifyWorkflowDismissed: (workflowId: string) => void;
}

/** Narrow host services used by the instance registry and its lifecycle listener. */
export interface WorkflowInstanceRegistryHost extends WorkflowInstanceRegistryBuildPort {
  readonly panelClientId: string;
  readonly getStoredPanelSend: () => ((message: unknown) => void) | undefined;
  readonly replayWorkflowStateTo: (
    workflowId: string,
    send: (message: unknown) => void,
    clientId: string
  ) => Promise<void>;
  readonly approvePendingWorkflowExternalRootsForClient: (
    clientId: string,
    send?: (message: unknown) => void,
    port?: UserInteractionPort,
    promptUser?: boolean
  ) => Promise<string[]>;
  readonly emitWorkflowExternalRootsApprovalState: (
    clientId: string,
    workflowId: string,
    pendingRoots: string[],
    send: (message: unknown) => void
  ) => void;
  readonly saveState: () => Promise<void>;
  readonly ensureCoordinationWatchSession: (executionRoot: string) => void;
  readonly getActiveWorkflowId: () => string | null;
  readonly fireActiveQueueStateChanged: (state: QueueState | undefined) => void;
  readonly getActiveQueueState: () => QueueState | undefined;
  readonly getActiveTerminalWorkflowRefs: () => ActiveTerminalWorkflowRef[];
  readonly syncExecutingRunViews: (instance: WorkflowInstance) => void;
}

/** Owns workflow instances, retirement, lineage binding, and client viewers. */
export class WorkflowInstanceRegistry
  implements RunViewPublisherRegistryPort, RunLifecycleRegistryPort
{
  private readonly instances = new Map<string, WorkflowInstance>();
  private readonly retiredInstances = new Map<string, WorkflowInstance>();
  private readonly viewerRegistry = new Map<string, string | null>();
  private readonly viewAddressRegistry = new Map<
    string,
    WorkflowViewAddress | null
  >();
  private readonly viewMessageSinks = new Map<
    string,
    (message: unknown) => void
  >();
  private readonly lineageBindingClients = new Set<string>();
  private readonly lineageExecutionOwners = new Map<
    WorkflowKey,
    LineageExecutionClaim
  >();
  private readonly externallyCreatedInstanceIds = new Set<string>();
  private readonly announcedExternalWorkflowIds = new Set<string>();

  constructor(private readonly host: WorkflowInstanceRegistryHost) {
    this.viewerRegistry.set(this.host.panelClientId, null);
  }

  private get panelClientId(): string {
    return this.host.panelClientId;
  }

  getInstances(): Map<string, WorkflowInstance> {
    return this.instances;
  }

  getRetiredInstances(): Map<string, WorkflowInstance> {
    return this.retiredInstances;
  }

  getViewerRegistry(): Map<string, string | null> {
    return this.viewerRegistry;
  }

  getViewAddressRegistry(): Map<string, WorkflowViewAddress | null> {
    return this.viewAddressRegistry;
  }

  getViewMessageSinks(): Map<string, (message: unknown) => void> {
    return this.viewMessageSinks;
  }

  getLineageBindingClients(): Set<string> {
    return this.lineageBindingClients;
  }

  getLineageExecutionOwners(): Map<WorkflowKey, LineageExecutionClaim> {
    return this.lineageExecutionOwners;
  }

  getExternallyCreatedInstanceIds(): Set<string> {
    return this.externallyCreatedInstanceIds;
  }

  getAnnouncedExternalWorkflowIds(): Set<string> {
    return this.announcedExternalWorkflowIds;
  }

  createExternalWorkflowInstance(): WorkflowInstance {
    const instance = this.buildWorkflowInstanceForHost();
    this.instances.set(instance.id, instance);
    this.externallyCreatedInstanceIds.add(instance.id);
    return instance;
  }

  async createWorkflow(
    filePath?: string
  ): Promise<WorkflowInstance | undefined> {
    const currentPanelId = this.getViewedWorkflowId(this.panelClientId);
    Log.debug(
      `[WorkflowOrchestrator] createWorkflow: filePath="${filePath ?? "(none)"}", currently viewed=${currentPanelId?.slice(0, 8) ?? "null"}, running=${this.instances.size}`
    );
    if (filePath) {
      const existing = [...this.instances.values()].find(
        (workflow) => workflow.filePath === filePath
      );
      if (existing) {
        const existingStatus = existing.getQueueState().status;
        if (
          existingStatus === EXECUTION_STATES.RUNNING ||
          existingStatus === EXECUTION_STATES.PAUSING ||
          existingStatus === EXECUTION_STATES.PAUSED
        ) {
          Log.info(
            `[WorkflowOrchestrator] createWorkflow: duplicate detected — existing inst:${existing.id.slice(0, 8)} is ${existingStatus}`
          );
          const panelSend = this.host.getStoredPanelSend() ?? (() => {});
          await this.host.replayWorkflowStateTo(
            existing.id,
            panelSend,
            this.host.panelClientId
          );
          return existing;
        }
      }
    }

    const retiredInstance = currentPanelId
      ? this.retiredInstances.get(currentPanelId)
      : null;
    const currentViewed = currentPanelId
      ? (this.instances.get(currentPanelId) ?? retiredInstance)
      : null;
    if (retiredInstance) {
      Log.debug(
        `[WorkflowOrchestrator] createWorkflow: disposing retired viewedInstance inst:${retiredInstance.id.slice(0, 8)}`
      );
      retiredInstance.dispose();
      this.retiredInstances.delete(currentPanelId!);
    } else if (currentViewed) {
      const viewedStatus = currentViewed.getQueueState().status;
      const isIdle =
        viewedStatus !== EXECUTION_STATES.RUNNING &&
        viewedStatus !== EXECUTION_STATES.PAUSING &&
        viewedStatus !== EXECUTION_STATES.PAUSED;
      if (isIdle) {
        Log.debug(
          `[WorkflowOrchestrator] createWorkflow: disposing idle viewedInstance inst:${currentViewed.id.slice(0, 8)}`
        );
        currentViewed.dispose();
        this.instances.delete(currentPanelId!);
      } else {
        Log.debug(
          `[WorkflowOrchestrator] createWorkflow: keeping running viewedInstance inst:${currentViewed.id.slice(0, 8)} in registry`
        );
      }
    }

    const instance = this.buildWorkflowInstanceForHost();
    this.setViewedWorkflowId(this.host.panelClientId, instance.id);
    this.instances.set(instance.id, instance);
    let pendingWorkflowExternalRoots: string[] = [];
    if (filePath) {
      await instance.loadPromptFile(filePath);
      pendingWorkflowExternalRoots =
        await this.host.approvePendingWorkflowExternalRootsForClient(
          this.host.panelClientId,
          undefined,
          undefined,
          false
        );
    }
    const panelSend = this.host.getStoredPanelSend();
    if (panelSend) {
      await this.host.replayWorkflowStateTo(
        instance.id,
        panelSend,
        this.host.panelClientId
      );
    }
    if (filePath && panelSend) {
      this.host.emitWorkflowExternalRootsApprovalState(
        this.host.panelClientId,
        instance.id,
        pendingWorkflowExternalRoots,
        panelSend
      );
    }
    return instance;
  }

  promoteInstanceToLive(instance: WorkflowInstance): boolean {
    this.instances.set(instance.id, instance);
    return this.retiredInstances.delete(instance.id);
  }

  retireWorkflow(workflowId: string): void {
    const instance = this.instances.get(workflowId);
    if (!instance) {
      Log.debug(
        `[WorkflowOrchestrator] retireWorkflow: inst:${workflowId.slice(0, 8)} not in registry (already retired?)`
      );
      return;
    }
    const isViewed = this.isWorkflowViewedByAnyClient(workflowId);
    const ptyManager = getPtyProcessManager();
    const activePtySessions = ptyManager
      ? ptyManager
          .getSessionsForWorkflow(workflowId)
          .filter(
            (session) => session.status === TERMINAL_SESSION_STATUS.RUNNING
          )
      : [];
    const hasActivePty = activePtySessions.length > 0;
    Log.debug(
      `[WorkflowOrchestrator] retireWorkflow: inst:${workflowId.slice(0, 8)} name=\"${instance.getSummary().workflowName || "(empty)"}\" ` +
        `status=${instance.getQueueState().status}, isViewed=${isViewed}, hasActivePty=${hasActivePty}(${activePtySessions.length}), remaining=${this.instances.size - 1}`
    );
    this.instances.delete(workflowId);
    if (isViewed || hasActivePty) {
      this.retiredInstances.set(workflowId, instance);
    } else {
      instance.dispose();
      this.externallyCreatedInstanceIds.delete(workflowId);
      this.announcedExternalWorkflowIds.delete(workflowId);
    }
    this.host.dashboardBroadcast.notifyWorkflowDismissed(workflowId);
    void this.host.saveState();
  }

  getWorkflow(workflowId: string): WorkflowInstance | undefined {
    return this.findInstance(workflowId);
  }

  getAllWorkflows(): WorkflowInstance[] {
    return [...this.instances.values()];
  }

  getRunningWorkflows(): WorkflowInstance[] {
    return [...this.instances.values()].filter((workflow) => {
      const status = workflow.getQueueState().status;
      return (
        status === EXECUTION_STATES.RUNNING ||
        status === EXECUTION_STATES.PAUSING
      );
    });
  }

  getActiveWorkflow(): WorkflowInstance | undefined {
    const id = this.getViewedWorkflowId(this.panelClientId);
    return id
      ? (this.instances.get(id) ?? this.retiredInstances.get(id))
      : undefined;
  }

  getActiveWorkflowId(): string | null {
    return this.getViewedWorkflowId(this.panelClientId);
  }

  findInstance(workflowId: string): WorkflowInstance | undefined {
    return (
      this.instances.get(workflowId) ?? this.retiredInstances.get(workflowId)
    );
  }

  getActiveInstance(): WorkflowInstance {
    const id = this.getViewedWorkflowId(this.panelClientId);
    if (id) {
      const instance = this.findInstance(id);
      if (instance) return instance;
    }
    const instance = this.buildWorkflowInstanceForHost();
    this.instances.set(instance.id, instance);
    this.setViewedWorkflowId(this.panelClientId, instance.id);
    return instance;
  }

  getInstanceForClient(clientId: string): WorkflowInstance {
    if (!this.viewerRegistry.has(clientId)) {
      Log.warn(
        `[WorkflowOrchestrator] getInstanceForClient: unregistered clientId "${clientId}" — falling back to active instance. This is likely a bug.`
      );
    }
    return this.getBoundInstance(clientId) ?? this.getActiveInstance();
  }

  getBoundInstance(clientId: string): WorkflowInstance | null {
    const id = this.getViewedWorkflowId(clientId);
    return id ? (this.findInstance(id) ?? null) : null;
  }

  findInstanceForLineage(
    workflowKey: WorkflowKey
  ): WorkflowInstance | undefined {
    const matches = (instance: WorkflowInstance) =>
      instance.getQueueState().workflowKey === workflowKey;
    const live = [...this.instances.values()].filter(matches);
    const liveIds = new Set(live.map((instance) => instance.id));
    const retired = [...this.retiredInstances.values()].filter(
      (instance) => matches(instance) && !liveIds.has(instance.id)
    );
    const residents = [...live, ...retired];
    if (residents.length <= 1) return residents[0];
    const executing = residents.find((instance) =>
      isExecutionOwnerState(instance.getQueueState().status)
    );
    if (executing) return executing;
    const claim = this.lineageExecutionOwners.get(workflowKey);
    const prepared = residents.find((instance) => {
      if (!claim || instance.id !== claim.instanceId) return false;
      if (!claim.promoted) return true;
      return !isSpentExecutionOwnerState(instance.getQueueState().status);
    });
    if (prepared) return prepared;
    if (live.length > 0) return live[0];
    const activeTerminalOwnerIds = new Set(
      this.host
        .getActiveTerminalWorkflowRefs()
        .filter((ref) => ref.workflowKey === workflowKey)
        .map((ref) => ref.workflowId)
    );
    return (
      retired.find((instance) => activeTerminalOwnerIds.has(instance.id)) ??
      retired[0]
    );
  }

  registerNewInstance(clientId: string): WorkflowInstance {
    const instance = this.buildWorkflowInstanceForHost();
    this.instances.set(instance.id, instance);
    this.setViewedWorkflowId(clientId, instance.id);
    return instance;
  }

  getViewedWorkflowId(clientId: string): string | null {
    return this.viewerRegistry.get(clientId) ?? null;
  }

  setViewedWorkflowId(clientId: string, workflowId: string | null): void {
    const previous = this.viewerRegistry.get(clientId);
    this.viewerRegistry.set(clientId, workflowId);
    if (previous === workflowId) return;
    const adopted = workflowId ? this.findInstance(workflowId) : undefined;
    this.viewAddressRegistry.set(
      clientId,
      lineageAddressOf(adopted?.getQueueState())
    );
    const previousInRetired = previous
      ? this.retiredInstances.has(previous)
      : false;
    const previousStillViewed = previous
      ? this.isWorkflowViewedByAnyClient(previous)
      : false;
    Log.debug(
      `[setViewedWorkflowId] clientId=${clientId.slice(0, 12)} ` +
        `prev=inst:${previous?.slice(0, 8) ?? "null"}(retired=${previousInRetired},stillViewed=${previousStillViewed}) ` +
        `inst:${workflowId?.slice(0, 8) ?? "null"}`
    );
    if (clientId === this.panelClientId && this.host) {
      this.host.fireActiveQueueStateChanged(this.host.getActiveQueueState());
    }
  }

  isWorkflowViewedByAnyClient(workflowId: string): boolean {
    for (const viewed of this.viewerRegistry.values()) {
      if (viewed === workflowId) return true;
    }
    return false;
  }

  registerClient(clientId: string, send?: (message: unknown) => void): void {
    if (!this.viewerRegistry.has(clientId))
      this.viewerRegistry.set(clientId, null);
    if (!this.viewAddressRegistry.has(clientId)) {
      this.viewAddressRegistry.set(clientId, null);
    }
    if (send) this.viewMessageSinks.set(clientId, send);
  }

  unregisterClient(clientId: string): void {
    const workflowId = this.getViewedWorkflowId(clientId);
    const ptyManager = getPtyProcessManager();
    const ptyCount =
      workflowId && ptyManager
        ? ptyManager.getSessionsForWorkflow(workflowId).length
        : 0;
    Log.debug(
      `[unregisterClient] clientId=${clientId.slice(0, 12)} ` +
        `was viewing inst:${workflowId?.slice(0, 8) ?? "null"} ` +
        `(retired=${workflowId ? this.retiredInstances.has(workflowId) : false}, activePty=${ptyCount})`
    );
    this.viewerRegistry.delete(clientId);
    this.viewAddressRegistry.delete(clientId);
    this.viewMessageSinks.delete(clientId);
    if (!workflowId) return;
    if (
      this.retiredInstances.has(workflowId) &&
      !this.isWorkflowViewedByAnyClient(workflowId)
    ) {
      if (ptyCount > 0) {
        Log.debug(
          `[unregisterClient] keeping retired inst:${workflowId.slice(0, 8)} — ${ptyCount} active PTY session(s) still running`
        );
        return;
      }
      Log.debug(
        `[unregisterClient] disposing retired inst:${workflowId.slice(0, 8)} — no viewers, no active PTY sessions`
      );
      this.retiredInstances.get(workflowId)?.dispose();
      this.retiredInstances.delete(workflowId);
      return;
    }
    const instance = this.instances.get(workflowId);
    if (instance && !this.isWorkflowViewedByAnyClient(workflowId)) {
      const status = instance.getQueueState().status;
      const isIdle =
        status !== EXECUTION_STATES.RUNNING &&
        status !== EXECUTION_STATES.PAUSING &&
        status !== EXECUTION_STATES.PAUSED;
      if (isIdle) {
        instance.dispose();
        this.instances.delete(workflowId);
      }
    }
  }

  adoptInstanceLineageAddress(
    instance: WorkflowInstance,
    state: QueueState
  ): void {
    const address = lineageAddressOf(state);
    for (const [clientId, viewedInstanceId] of this.viewerRegistry) {
      if (viewedInstanceId !== instance.id) continue;
      if (
        address?.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN &&
        this.viewAddressRegistry.get(clientId)?.workflowKey ===
          address.workflowKey
      ) {
        continue;
      }
      this.viewAddressRegistry.set(clientId, address);
    }
  }

  buildWorkflowInstanceForHost(): WorkflowInstance {
    const host = this.host;
    const instance = new WorkflowInstance(
      host.platform,
      host.dashboardSink,
      host.integrationFactory,
      (harnessOverride?: HarnessId) =>
        host.resolveDetectorIntegration(harnessOverride),
      (name: string | undefined) =>
        host.propagateWorkflowNameToIntegrations(name),
      () => host.updateStatusBar(),
      host.currentWorkspaceFolderPath,
      true,
      true,
      host.compatibilityRegistry,
      host.userFeedbackSink,
      () => host.getHarnessUsageSnapshots(),
      (harnessId) => host.refreshHarnessUsage(harnessId),
      (workflow, workspaceRoot) =>
        host.approveSecretGrantsForWorkflow(workflow, workspaceRoot),
      host.runnerHostIdentity
    );
    Log.debug(
      `[WorkflowOrchestrator] buildWorkflowInstance: created inst:${instance.id.slice(0, 8)}`
    );
    let lastLineageIdentity = "";
    instance.promptQueue.onDidChangeState((state) => {
      host.ensureCoordinationWatchSession(instance.getExecutionRoot());
      if (host.getActiveWorkflowId() === instance.id) {
        host.fireActiveQueueStateChanged(state);
      }
      const summary = instance.getSummary();
      const inRegistry = this.instances.has(instance.id);
      const lineageIdentity = `${state.workflowKey ?? ""}|${state.runRef ?? ""}`;
      if (lineageIdentity !== lastLineageIdentity) {
        lastLineageIdentity = lineageIdentity;
        this.adoptInstanceLineageAddress(instance, state);
      }
      Log.debug(
        `[onDidChangeState] inst:${instance.id.slice(0, 8)} state=${state.status} name="${summary.workflowName || "(empty)"}" ` +
          `inRegistry=${inRegistry} registrySize=${this.instances.size} ` +
          `fp=${summary.filePath ? path.basename(summary.filePath) : "?"} step=${workflowDisplayStep(summary)}/${summary.totalSteps}`
      );
      if (state.workflowKey && isExecutionOwnerState(state.status)) {
        const claim = this.lineageExecutionOwners.get(state.workflowKey);
        if (claim && claim.instanceId === instance.id && !claim.promoted) {
          this.lineageExecutionOwners.set(state.workflowKey, {
            ...claim,
            promoted: true,
          });
        }
      }
      const isExternallyCreated = this.externallyCreatedInstanceIds.has(
        instance.id
      );
      const needsExternalAnnounce =
        isExternallyCreated &&
        !this.announcedExternalWorkflowIds.has(instance.id);
      if (
        (state.status === EXECUTION_STATES.RUNNING ||
          state.status === EXECUTION_STATES.PAUSING ||
          state.status === EXECUTION_STATES.PAUSED) &&
        (!inRegistry || needsExternalAnnounce)
      ) {
        if (needsExternalAnnounce) {
          this.announcedExternalWorkflowIds.add(instance.id);
        }
        const wasRetired = this.promoteInstanceToLive(instance);
        Log.debug(
          `[onDidChangeState] registered inst:${instance.id.slice(0, 8)} in running registry on ${state.status} ` +
            `name="${summary.workflowName || "(empty)"}" (total: ${this.instances.size})` +
            (wasRetired ? " — removed stale retiredInstances entry" : "")
        );
        host.dashboardBroadcast.notifyWorkflowAdded(summary);
        const panelViewedId = this.getViewedWorkflowId(host.panelClientId);
        if (!isExternallyCreated && panelViewedId !== instance.id) {
          const panelViewed = panelViewedId
            ? this.findInstance(panelViewedId)
            : null;
          const panelSummary = panelViewed?.getSummary();
          const panelViewedIsBlank =
            !panelViewed ||
            (!panelSummary?.workingFilePath &&
              (panelSummary?.totalSteps ?? 0) === 0);
          if (panelViewedIsBlank) {
            this.setViewedWorkflowId(host.panelClientId, instance.id);
            Log.debug(
              `[onDidChangeState] auto-switched panel viewerRegistry to running inst:${instance.id.slice(0, 8)} (panel had blank placeholder)`
            );
          }
        }
      }
      host.dashboardBroadcast.notifyWorkflowSummaryUpdated(summary);
      if (
        state.status === EXECUTION_STATES.RUNNING ||
        state.status === EXECUTION_STATES.ERROR ||
        state.status === EXECUTION_STATES.STOPPED ||
        state.status === EXECUTION_STATES.COMPLETED
      ) {
        host.syncExecutingRunViews(instance);
      }
      if (
        inRegistry &&
        (state.status === EXECUTION_STATES.COMPLETED ||
          state.status === EXECUTION_STATES.ERROR ||
          state.status === EXECUTION_STATES.STOPPED)
      ) {
        Log.debug(
          `[onDidChangeState] inst:${instance.id.slice(0, 8)} terminal state ${state.status} — retiring immediately`
        );
        this.retireWorkflow(instance.id);
      }
    });
    return instance;
  }
}
