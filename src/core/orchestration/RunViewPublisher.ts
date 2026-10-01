import * as fs from "fs";
import {
  type RunRef,
  type WorkflowKey,
  type WorkflowViewAddress,
  type WorkingFile,
  type WorkflowSummary,
} from "../../types/CtrlYokeTypes";
import {
  MESSAGE_TYPES,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "../../types/DashboardConstants";
import type {
  ActiveTerminalWorkflowRef,
  RunSummariesLoadedMessage,
  RunViewLoadedMessage,
  WorkflowViewIdentityMessage,
} from "../../types/WebviewMessageTypes";
import { Log } from "../../utils/Log";
import { noteMemoryActivity } from "../../utils/MemoryDiagnostics";
import { getErrorMessage } from "../../utils/ErrorUtils";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { capToolOutputHistory } from "../../utils/ToolOutputPayload";
import { OutputHistoryManager } from "./OutputHistoryManager";
import type {
  WorkflowOutputHistory,
  WorkspaceSnapshot,
} from "../../types/OutputHistoryTypes";
import { PostMessageDashboardSink } from "../../ui/PostMessageDashboardSink";
import { WorkflowTaggedSink } from "../WorkflowTaggedSink";
import type { IDashboardSink } from "../../types/IDashboardSink";
import {
  getLineageLastModifiedAt,
  stripLegacyWorkingFileLineageMetadata,
} from "../../utils/WorkingFileMetadata";
import type { RunLifecycleViewPort } from "./RunLifecycleService";

export interface DefinitionRollbackInvalidation {
  fromRevision: number;
  restoredRevision: number;
  descriptorRevision: number;
}

export interface StepColorInvalidation {
  kind: "stepColor";
  index: number;
}

/** The instance/view state consumed by the addressed-view read path. */
export interface RunViewPublisherRegistryPort {
  getViewAddressRegistry(): Map<string, WorkflowViewAddress | null>;
  getViewMessageSinks(): Map<string, (message: unknown) => void>;
  getLineageBindingClients(): Set<string>;
  getViewedWorkflowId(clientId: string): string | null;
  setViewedWorkflowId(clientId: string, workflowId: string | null): void;
  findInstanceForLineage(
    workflowKey: WorkflowKey
  ): RunViewPublisherInstance | undefined;
  findInstance(workflowId: string): RunViewPublisherInstance | undefined;
}

export interface RunViewPublisherInstance {
  readonly id: string;
  getSummary(): WorkflowSummary;
  replayBufferedOutputTo(sink: IDashboardSink): void;
  getActiveStepIndices(): number[];
  getRunViewLiveState(): RunViewLoadedMessage["liveState"];
}

export interface RunViewPublisherExternalRunWatchPort {
  hasSession(workflowId: string): boolean;
  getEntry(workflowId: string): { summary: WorkflowSummary } | undefined;
}

export interface RunViewPublisherHost {
  readonly workspaceRoot: string | undefined;
  readonly lineageRepository: RunViewPublisherLineageRepository;
  readonly registry: RunViewPublisherRegistryPort;
  readonly externalRunWatch: RunViewPublisherExternalRunWatchPort;
  readonly loadFreshInstanceAndReplay: (
    filePath: string,
    clientId: string,
    send: (message: unknown) => void,
    options?: { skipReplay?: boolean }
  ) => Promise<void>;
  readonly findExecutionRunRef: (
    workflowKey: WorkflowKey
  ) => RunRef | undefined;
  readonly getActiveTerminalWorkflowRefs: () => ActiveTerminalWorkflowRef[];
  readonly replayTerminalSessionsTo: (
    workflowId: string,
    send: (message: unknown) => void,
    clientId: string
  ) => void;
}

export interface RunViewPublisherLineageRepository {
  readDescriptor(
    workspaceRoot: string,
    workflowKey: WorkflowKey
  ): Promise<{
    revision: number;
    lastModifiedAt: number;
    workflowName: string;
    isSystemGenerated?: boolean;
  }>;
}

interface AddressedRunView {
  workingFile: WorkingFile;
  history: RunViewLoadedMessage["history"];
  runSummaries: RunViewLoadedMessage["runSummaries"];
  workflowProperties: RunViewLoadedMessage["workflowProperties"];
  descriptorRevision: number;
  workflowName: string;
  isSystemGenerated: boolean;
}

export function sameViewAddress(
  a: WorkflowViewAddress | null | undefined,
  b: WorkflowViewAddress | null | undefined
): boolean {
  if (!a || !b) return false;
  if (a.workflowKey !== b.workflowKey || a.kind !== b.kind) return false;
  return (
    a.kind !== WORKFLOW_VIEW_ADDRESS_KIND.RUN ||
    (b.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN && a.runRef === b.runRef)
  );
}

function describeViewAddress(address: WorkflowViewAddress | null): string {
  if (!address) return "none";
  return `${address.workflowKey}/${address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN ? address.runRef : "draft"}`;
}

/** Keep the snapshot index in run-view messages; full file bodies are fetched per consumer. */
function stripSnapshotContents(
  history: WorkflowOutputHistory | null
): WorkflowOutputHistory | null {
  if (!history) return history;
  const stripSnapshot = (snapshot: WorkspaceSnapshot | undefined) => {
    if (!snapshot) return snapshot;
    return {
      ...snapshot,
      changedFiles: snapshot.changedFiles.map((change) => {
        const hasCapturedContent =
          change.beforeContent !== undefined ||
          change.contentToRestore !== undefined;
        if (!hasCapturedContent) return change;
        const {
          beforeContent: _beforeContent,
          contentToRestore: _contentToRestore,
          ...indexEntry
        } = change;
        return { ...indexEntry, contentAvailableOnDemand: true };
      }),
    };
  };
  const stripOutputs = (outputs: WorkflowOutputHistory["promptOutputs"]) =>
    Object.fromEntries(
      Object.entries(outputs).map(([index, output]) => [
        index,
        {
          ...output,
          workspaceSnapshot: stripSnapshot(output.workspaceSnapshot),
        },
      ])
    );
  return {
    ...history,
    promptOutputs: stripOutputs(history.promptOutputs),
    ...(history.finalStepOutputs
      ? { finalStepOutputs: stripOutputs(history.finalStepOutputs) }
      : {}),
  };
}

/** Owns addressed run-view reads, fan-out, identity publication, and refreshes. */
export class RunViewPublisher implements RunLifecycleViewPort {
  constructor(private readonly host: RunViewPublisherHost) {}

  getViewAddress(clientId: string): WorkflowViewAddress | null {
    return this.host.registry.getViewAddressRegistry().get(clientId) ?? null;
  }

  getViewFilePath(clientId: string): string | null {
    const address = this.getViewAddress(clientId);
    if (!address || !this.host.workspaceRoot) return null;
    return this.resolveAddressFilePath(this.host.workspaceRoot, address);
  }

  private resolveAddressFilePath(
    workspaceRoot: string,
    address: WorkflowViewAddress
  ): string {
    return address.kind === WORKFLOW_VIEW_ADDRESS_KIND.DRAFT
      ? WorkflowPaths.draftFilePath(workspaceRoot, address.workflowKey)
      : WorkflowPaths.runFilePath(
          workspaceRoot,
          address.workflowKey,
          address.runRef
        );
  }

  private resolveAddressDirectory(
    workspaceRoot: string,
    address: WorkflowViewAddress
  ): string {
    return address.kind === WORKFLOW_VIEW_ADDRESS_KIND.DRAFT
      ? WorkflowPaths.draftDir(workspaceRoot, address.workflowKey)
      : WorkflowPaths.runDir(
          workspaceRoot,
          address.workflowKey,
          address.runRef
        );
  }

  async getViewIdentity(
    clientId: string
  ): Promise<WorkflowViewIdentityMessage | null> {
    const address = this.getViewAddress(clientId);
    return address ? this.buildViewIdentityForAddress(address) : null;
  }

  private async buildViewIdentityForAddress(
    address: WorkflowViewAddress
  ): Promise<WorkflowViewIdentityMessage | null> {
    const workspaceRoot = this.host.workspaceRoot;
    if (!workspaceRoot) return null;
    try {
      const [content, descriptor] = await Promise.all([
        fs.promises.readFile(
          this.resolveAddressFilePath(workspaceRoot, address),
          "utf8"
        ),
        this.host.lineageRepository.readDescriptor(
          workspaceRoot,
          address.workflowKey
        ),
      ]);
      return {
        type: MESSAGE_TYPES.WORKFLOW_VIEW_IDENTITY,
        address,
        runDirectory: this.resolveAddressDirectory(workspaceRoot, address),
        definitionRevision:
          (JSON.parse(content) as WorkingFile).definitionRevision ?? 1,
        descriptorRevision: descriptor.revision,
        isSystemGenerated: descriptor.isSystemGenerated ?? false,
      };
    } catch (error) {
      Log.warn(
        `[WorkflowOrchestrator] Could not resolve view identity for ${describeViewAddress(address)}: ${getErrorMessage(error)}`
      );
      return null;
    }
  }

  async publishRunRevisionsToViewers(
    workflowKey: WorkflowKey,
    runRef: RunRef
  ): Promise<void> {
    const address: WorkflowViewAddress = {
      workflowKey,
      kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
      runRef,
    };
    const sends: Array<(message: unknown) => void> = [];
    for (const [
      clientId,
      viewed,
    ] of this.host.registry.getViewAddressRegistry()) {
      if (!sameViewAddress(viewed, address)) continue;
      const send = this.host.registry.getViewMessageSinks().get(clientId);
      if (send) sends.push(send);
    }
    if (sends.length === 0) return;
    const identity = await this.buildViewIdentityForAddress(address);
    if (!identity) return;
    for (const send of sends) send(identity);
  }

  async publishViewIdentityToViewers(
    clientId: string
  ): Promise<WorkflowViewIdentityMessage | null> {
    const identity = await this.getViewIdentity(clientId);
    if (!identity) return null;
    for (const [otherId, send] of this.host.registry.getViewMessageSinks()) {
      if (
        otherId !== clientId &&
        sameViewAddress(this.getViewAddress(otherId), identity.address)
      ) {
        send(identity);
      }
    }
    return identity;
  }

  async bindClientToAddressedLineage(
    address: WorkflowViewAddress,
    send: (message: unknown) => void,
    clientId: string
  ): Promise<string | null> {
    const binding = this.host.registry.getLineageBindingClients();
    if (binding.has(clientId)) return null;

    const boundId = this.host.registry.getViewedWorkflowId(clientId);
    const resident = this.host.externalRunWatch.hasSession(address.workflowKey)
      ? address.workflowKey
      : this.host.registry.findInstanceForLineage(address.workflowKey)?.id;
    if (boundId === resident) return null;

    binding.add(clientId);
    try {
      if (resident) {
        this.host.registry.setViewedWorkflowId(clientId, resident);
        return resident;
      }
      const workspaceRoot = this.requireWorkspaceRoot();
      await this.host.loadFreshInstanceAndReplay(
        this.resolveAddressFilePath(workspaceRoot, address),
        clientId,
        send,
        { skipReplay: true }
      );
      return this.host.registry.getViewedWorkflowId(clientId);
    } finally {
      binding.delete(clientId);
    }
  }

  async loadRunViewForClient(
    address: WorkflowViewAddress,
    send: (message: unknown) => void,
    clientId: string,
    requestId?: string,
    definitionRollback?: DefinitionRollbackInvalidation,
    announceReplayBoundary = false,
    skipTerminalReplay = false
  ): Promise<void> {
    const workspaceRoot = this.requireWorkspaceRoot();
    // This must remain first: binding is lineage-scoped and controls terminals,
    // live-message filtering, prompt execution, and every edit.
    const boundWorkflowId = await this.bindClientToAddressedLineage(
      address,
      send,
      clientId
    );
    const view = await this.readAddressedRunView(
      workspaceRoot,
      address,
      `request=${requestId ?? "none"}`
    );
    this.deliverRunView(
      address,
      view,
      send,
      clientId,
      boundWorkflowId,
      requestId,
      definitionRollback,
      announceReplayBoundary,
      skipTerminalReplay
    );
  }

  async publishRunViewToClients(
    address: WorkflowViewAddress,
    targets: ReadonlyArray<{
      clientId: string;
      send: (message: unknown) => void;
    }>,
    definitionRollback?: DefinitionRollbackInvalidation
  ): Promise<void> {
    if (targets.length === 0) return;
    const workspaceRoot = this.requireWorkspaceRoot();
    const boundWorkflowIds = new Map<string, string | null>();
    for (const target of targets) {
      boundWorkflowIds.set(
        target.clientId,
        await this.bindClientToAddressedLineage(
          address,
          target.send,
          target.clientId
        )
      );
    }
    const view = await this.readAddressedRunView(
      workspaceRoot,
      address,
      `clients=${targets.length}`
    );
    for (const target of targets) {
      this.deliverRunView(
        address,
        view,
        target.send,
        target.clientId,
        boundWorkflowIds.get(target.clientId) ?? null,
        undefined,
        definitionRollback
      );
    }
  }

  private async readAddressedRunView(
    workspaceRoot: string,
    address: WorkflowViewAddress,
    logContext: string
  ): Promise<AddressedRunView> {
    const startTime = Date.now();
    const addressLabel = `${address.workflowKey}/${address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN ? address.runRef : "draft"}`;
    const logPrefix = `[readAddressedRunView] ${logContext} address=${addressLabel}`;
    const filePath = this.resolveAddressFilePath(workspaceRoot, address);
    const content = await fs.promises.readFile(filePath, "utf-8");
    const workingFile = stripLegacyWorkingFileLineageMetadata(
      JSON.parse(content) as WorkingFile
    );
    Log.debug(`${logPrefix} definition read at ${Date.now() - startTime}ms`);

    const historyManager = new OutputHistoryManager(workspaceRoot);
    const [history, runSummaries, descriptor] = await Promise.all([
      address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN
        ? historyManager.loadHistory(
            historyManager.getHistoryFilePath(
              address.workflowKey,
              address.runRef
            )
          )
        : Promise.resolve(null),
      historyManager.getRunSummaries(address.workflowKey),
      this.host.lineageRepository.readDescriptor(
        workspaceRoot,
        address.workflowKey
      ),
    ]);
    Log.debug(
      `${logPrefix} summaries/descriptor/history read at ${Date.now() - startTime}ms`
    );

    const { prompt, steps, finalStep, ...workflowProperties } = workingFile;
    void prompt;
    void steps;
    void finalStep;
    return {
      workingFile,
      history: stripSnapshotContents(history),
      runSummaries,
      workflowProperties,
      descriptorRevision: descriptor.revision,
      workflowName: descriptor.workflowName,
      isSystemGenerated: descriptor.isSystemGenerated ?? false,
    };
  }

  private deliverRunView(
    address: WorkflowViewAddress,
    view: AddressedRunView,
    send: (message: unknown) => void,
    clientId: string,
    boundWorkflowId: string | null,
    requestId?: string,
    definitionRollback?: DefinitionRollbackInvalidation,
    announceReplayBoundary = false,
    skipTerminalReplay = false
  ): void {
    const { workingFile } = view;
    const executionRunRef = this.host.findExecutionRunRef(address.workflowKey);
    const workspaceRoot = this.host.workspaceRoot;
    this.host.registry.getViewAddressRegistry().set(clientId, address);
    this.host.registry.getViewMessageSinks().set(clientId, send);

    // Only a live view can hold in-memory output the timeline read above could
    // have missed: the run that is actually executing, or a draft, which has no
    // persisted timeline of its own. Every other addressed run is *fully*
    // described by the history snapshot, so replaying the bound instance's
    // buffer there re-sends an earlier execution's output on top of it. This
    // must be evaluated independently of `boundWorkflowId` — that is non-null on
    // every lineage switch, so folding the check into the `??` fallback below
    // left it unreachable in exactly the case that matters.
    const isLiveAddress =
      address.kind === WORKFLOW_VIEW_ADDRESS_KIND.DRAFT ||
      (address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN &&
        address.runRef === executionRunRef);
    const runtimeWorkflowId =
      boundWorkflowId ??
      (isLiveAddress ? this.host.registry.getViewedWorkflowId(clientId) : null);
    const boundInstance = runtimeWorkflowId
      ? this.host.registry.findInstance(runtimeWorkflowId)
      : undefined;

    const snapshot: RunViewLoadedMessage = {
      type: MESSAGE_TYPES.RUN_VIEW_LOADED,
      requestId,
      address,
      ...(workspaceRoot
        ? { runDirectory: this.resolveAddressDirectory(workspaceRoot, address) }
        : {}),
      workingFile,
      workflowName: view.workflowName,
      // Only the addressed snapshot is projected. Persisted history and the
      // live buffer replay below remain complete for extension consumers.
      history: view.history ? capToolOutputHistory(view.history) : null,
      runSummaries: view.runSummaries,
      workflowProperties: view.workflowProperties,
      executionRunRef,
      // Never persisted (see WorkflowInstance.getActiveStepIndices), so this
      // is the only place a switch to a running workflow's addressed view can
      // learn which step(s) are actually executing right now — without it,
      // the client falls back to `[]` and terminal-deletion gating on the
      // just-switched-to workflow can't tell a live step's terminal from an
      // idle one.
      ...(boundInstance
        ? { activeStepIndices: boundInstance.getActiveStepIndices() }
        : {}),
      ...(boundInstance && isLiveAddress
        ? { liveState: boundInstance.getRunViewLiveState() }
        : {}),
      pendingRewind: workingFile._runtime?.pendingRewind,
      descriptorRevision: view.descriptorRevision,
      isSystemGenerated: view.isSystemGenerated,
      ...(definitionRollback &&
      (workingFile.definitionRevision ?? 1) ===
        definitionRollback.restoredRevision &&
      view.descriptorRevision === definitionRollback.descriptorRevision
        ? {
            definitionRollback: {
              fromRevision: definitionRollback.fromRevision,
            },
          }
        : {}),
    };

    const announcedWorkflowId =
      boundWorkflowId ??
      (announceReplayBoundary
        ? this.host.registry.getViewedWorkflowId(clientId)
        : null);
    if (announcedWorkflowId) {
      const announcedInstance =
        this.host.registry.findInstance(announcedWorkflowId);
      send({
        type: MESSAGE_TYPES.ACTIVE_TERMINAL_WORKFLOWS,
        workflows: this.host.getActiveTerminalWorkflowRefs(),
      });
      send({
        type: MESSAGE_TYPES.ACTIVE_WORKFLOW_CHANGED,
        workflowId: announcedWorkflowId,
        workingFilePath:
          announcedInstance?.getSummary().workingFilePath ??
          this.host.externalRunWatch.getEntry(announcedWorkflowId)?.summary
            .workingFilePath ??
          null,
        requestId,
      });
    }

    send(snapshot);
    noteMemoryActivity(
      `runView ${address.workflowKey}/${address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN ? address.runRef : "draft"} client=${clientId.slice(0, 12)} historyEntries=${view.history?.orderedEntries?.length ?? 0}`
    );
    Log.debug(
      `[deliverRunView] client=${clientId.slice(0, 12)} address=${address.workflowKey}/${address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN ? address.runRef : "draft"} snapshot sent`
    );
    if (runtimeWorkflowId && isLiveAddress) {
      boundInstance?.replayBufferedOutputTo(
        new WorkflowTaggedSink(
          new PostMessageDashboardSink(send),
          runtimeWorkflowId
        )
      );
    }
    if (boundWorkflowId && !skipTerminalReplay) {
      this.host.replayTerminalSessionsTo(boundWorkflowId, send, clientId);
    }
  }

  async loadRunSummariesForClient(
    workflowKey: WorkflowKey,
    send: (message: unknown) => void,
    requestId: string
  ): Promise<void> {
    const workspaceRoot = this.requireWorkspaceRoot();
    const historyManager = new OutputHistoryManager(workspaceRoot);
    const [runSummaries, descriptor] = await Promise.all([
      historyManager.getRunSummaries(workflowKey),
      this.host.lineageRepository.readDescriptor(workspaceRoot, workflowKey),
    ]);
    const snapshot: RunSummariesLoadedMessage = {
      type: MESSAGE_TYPES.RUN_SUMMARIES_LOADED,
      requestId,
      workflowKey,
      descriptorRevision: descriptor.revision,
      lastModifiedAt: await getLineageLastModifiedAt(
        workspaceRoot,
        workflowKey,
        descriptor.lastModifiedAt
      ),
      runSummaries,
      executionRunRef: this.host.findExecutionRunRef(workflowKey),
    };
    send(snapshot);
  }

  async invalidateRunViewProperties(
    workflowKey: WorkflowKey,
    runRef: RunRef
  ): Promise<void> {
    const targets = [
      ...this.host.registry.getViewAddressRegistry().entries(),
    ].filter(
      ([, address]) =>
        address?.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN &&
        address.workflowKey === workflowKey &&
        address.runRef === runRef
    );
    if (targets.length === 0 || !this.host.workspaceRoot) return;
    let workingFile: WorkingFile;
    try {
      const filePath = this.resolveAddressFilePath(this.host.workspaceRoot, {
        workflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef,
      });
      workingFile = JSON.parse(
        await fs.promises.readFile(filePath, "utf-8")
      ) as WorkingFile;
    } catch (error) {
      Log.warn(
        `[WorkflowOrchestrator] Failed to read run file for properties invalidation: ${getErrorMessage(error)}`
      );
      return;
    }
    const { prompt, steps, finalStep, ...workflowProperties } = workingFile;
    void prompt;
    void steps;
    void finalStep;
    for (const [clientId] of targets) {
      this.host.registry.getViewMessageSinks().get(clientId)?.({
        type: MESSAGE_TYPES.WORKFLOW_PROPERTIES_UPDATE,
        workflowProperties,
      });
    }
  }

  async invalidateRunViewStepColor(
    workflowKey: WorkflowKey,
    runRef: RunRef,
    index: number
  ): Promise<void> {
    const targets = [
      ...this.host.registry.getViewAddressRegistry().entries(),
    ].filter(
      ([, address]) =>
        address?.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN &&
        address.workflowKey === workflowKey &&
        address.runRef === runRef
    );
    if (targets.length === 0 || !this.host.workspaceRoot) return;
    try {
      const filePath = this.resolveAddressFilePath(this.host.workspaceRoot, {
        workflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef,
      });
      const workingFile = JSON.parse(
        await fs.promises.readFile(filePath, "utf-8")
      ) as WorkingFile;
      const color = workingFile.steps?.[index]?.color ?? null;
      const definitionRevision = workingFile.definitionRevision;
      for (const [clientId] of targets) {
        this.host.registry.getViewMessageSinks().get(clientId)?.({
          type: MESSAGE_TYPES.STEP_COLOR_UPDATED,
          index,
          color,
          ...(definitionRevision !== undefined ? { definitionRevision } : {}),
        });
      }
    } catch (error) {
      Log.warn(
        `[WorkflowOrchestrator] Failed to read run file for step color invalidation: ${getErrorMessage(error)}`
      );
    }
  }

  async invalidateRunViews(
    workflowKey: WorkflowKey,
    runRef: RunRef,
    definitionRollback?: DefinitionRollbackInvalidation
  ): Promise<void> {
    await this.invalidateViewsForAddress(
      { workflowKey, kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN, runRef },
      definitionRollback
    );
  }

  /**
   * The draft counterpart of `invalidateRunViews`. A draft-addressed write has
   * no RunRef to invalidate, but its viewers hold the same kind of snapshot and
   * go just as stale: "set start position" on a never-run lineage rewrites the
   * draft's step runtime and current index in place, and without this every
   * client — the acting one included — keeps rendering the pre-write statuses.
   */
  async invalidateDraftViews(workflowKey: WorkflowKey): Promise<void> {
    await this.invalidateViewsForAddress({
      workflowKey,
      kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
    });
  }

  private async invalidateViewsForAddress(
    address: WorkflowViewAddress,
    definitionRollback?: DefinitionRollbackInvalidation
  ): Promise<void> {
    const targets: Array<{
      clientId: string;
      send: (message: unknown) => void;
    }> = [];
    for (const [
      clientId,
      viewed,
    ] of this.host.registry.getViewAddressRegistry()) {
      if (!sameViewAddress(viewed, address)) continue;
      const send = this.host.registry.getViewMessageSinks().get(clientId);
      if (send) targets.push({ clientId, send });
    }
    try {
      await this.publishRunViewToClients(address, targets, definitionRollback);
    } catch (error) {
      Log.warn(
        `[WorkflowOrchestrator] Failed to invalidate ${describeViewAddress(address)} view for ${targets.length} client(s): ${getErrorMessage(error)}`
      );
    }
  }

  async pushRunSummariesRefreshIfNotAlreadyViewing(
    workflowKey: WorkflowKey,
    send: (message: unknown) => void,
    refreshedClientIds: string[],
    clientId: string
  ): Promise<void> {
    if (refreshedClientIds.includes(clientId)) return;
    await this.loadRunSummariesForClient(
      workflowKey,
      send,
      `delete-refresh-${Date.now()}`
    );
  }

  private requireWorkspaceRoot(): string {
    if (!this.host.workspaceRoot) {
      throw new Error("No workspace folder is open");
    }
    return this.host.workspaceRoot;
  }
}
