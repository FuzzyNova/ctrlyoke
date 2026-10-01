import { DashboardBroadcastHub } from "../../ui/DashboardBroadcastHub";
import { CompositeUserFeedbackSink } from "../../core/CompositeUserFeedbackSink";
import { HarnessCapabilityRegistry } from "../../core/HarnessCapabilityRegistry";
import {
  MockHarnessIntegration,
  MockIntegrationFactory,
  MockPlatform,
} from "./mockHarness";
import { RUNNER_IDS } from "../../types/DashboardConstants";
import type { WorkflowInstance } from "../../core/WorkflowInstance";
import type { WorkflowInstanceRegistryHost } from "../../core/orchestration/WorkflowInstanceRegistry";
import type { HarnessIntegration } from "../../core/HarnessIntegration";
import type {
  HarnessId,
  QueueState,
  RunnerHostIdentity,
  WorkflowSummary,
  WorkflowViewAddress,
} from "../../types/CtrlYokeTypes";
import type { ActiveTerminalWorkflowRef } from "../../types/WebviewMessageTypes";
import type { HarnessUsageSnapshot } from "../../types/UsageTypes";

/**
 * A fully-wired {@link WorkflowInstanceRegistryHost} for registry tests.
 *
 * The registry requires a host, by design: an optional host meant every
 * orchestrator call site needed a `hasHost()` fallback, which duplicated the
 * instance-construction wiring. Tests that only exercise viewer/address
 * bookkeeping still need the build-port members present, so they come from the
 * shared mocks rather than from casts.
 */
export class TestWorkflowInstanceRegistryHost implements WorkflowInstanceRegistryHost {
  readonly platform = new MockPlatform();
  readonly dashboardBroadcast = new DashboardBroadcastHub();
  readonly dashboardSink = this.dashboardBroadcast;
  readonly integrationFactory = new MockIntegrationFactory(this.platform);
  readonly compatibilityRegistry = new HarnessCapabilityRegistry();
  readonly userFeedbackSink = new CompositeUserFeedbackSink([]);
  readonly currentWorkspaceFolderPath: string | undefined = undefined;
  readonly panelClientId = "panel";
  readonly runnerHostIdentity: RunnerHostIdentity = {
    runner: RUNNER_IDS.VSCODE,
    hostInstanceId: "test-host",
    pid: process.pid,
  };

  /** Records the calls a test may want to assert on. */
  readonly fired: (QueueState | undefined)[] = [];
  readonly synced: WorkflowInstance[] = [];
  readonly observed: WorkflowSummary[] = [];
  readonly acknowledged: {
    workflowId: string | null;
    address: WorkflowViewAddress | null;
  }[] = [];

  resolveDetectorIntegration(_harnessOverride?: HarnessId): HarnessIntegration {
    return new MockHarnessIntegration(undefined, false);
  }
  propagateWorkflowNameToIntegrations(_name: string | undefined): void {}
  updateStatusBar(): void {}
  getStoredPanelSend(): ((message: unknown) => void) | undefined {
    return undefined;
  }
  async replayWorkflowStateTo(
    _workflowId: string,
    _send: (message: unknown) => void,
    _clientId: string
  ): Promise<void> {}
  async approvePendingWorkflowExternalRootsForClient(): Promise<string[]> {
    return [];
  }
  emitWorkflowExternalRootsApprovalState(): void {}
  async saveState(): Promise<void> {}
  ensureCoordinationWatchSession(_executionRoot: string): void {}
  getActiveWorkflowId(): string | null {
    return null;
  }
  fireActiveQueueStateChanged(state: QueueState | undefined): void {
    this.fired.push(state);
  }
  getActiveQueueState(): QueueState | undefined {
    return undefined;
  }
  getActiveTerminalWorkflowRefs(): ActiveTerminalWorkflowRef[] {
    return [];
  }
  getHarnessUsageSnapshots(): HarnessUsageSnapshot[] {
    return [];
  }
  async refreshHarnessUsage(_harnessId: HarnessId): Promise<void> {}
  async approveSecretGrantsForWorkflow(): Promise<void> {}
  syncExecutingRunViews(instance: WorkflowInstance): void {
    this.synced.push(instance);
  }
  observeWorkflowActivity(summary: WorkflowSummary): void {
    this.observed.push(summary);
  }
  acknowledgeWorkflowView(
    workflowId: string | null,
    address: WorkflowViewAddress | null
  ): void {
    this.acknowledged.push({ workflowId, address });
  }
}
