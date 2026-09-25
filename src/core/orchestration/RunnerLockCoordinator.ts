import type {
  QueueState,
  RunnerHostIdentity,
  WorkflowKey,
} from "../../types/CtrlYokeTypes";
import { WorkflowLockManager } from "../../utils/WorkflowLockManager";
import {
  deleteWorkflowStopRequest,
  readWorkflowStopRequest,
} from "../../utils/WorkflowStopRequest";
import { HEARTBEAT_INTERVAL_MS } from "../../utils/LockSafetyPrimitives";
import type { ExecutionLeaseHandle } from "./ExecutionRootLeaseManager";
import { Log } from "../../utils/Log";
import {
  CURRENT_SCHEMA_VERSIONS,
  PERSISTED_STORES,
} from "../../utils/PersistedSchemaGuard";

export interface RunnerLockCoordinatorPort {
  readonly id: string;
  readonly runnerHostIdentity: RunnerHostIdentity;
  readonly getQueueState: () => QueueState;
  readonly getWorkspaceRoot: () => string | undefined;
  readonly stop: () => Promise<void>;
  readonly getExecutionLease: () => ExecutionLeaseHandle | undefined;
}

/** Owns the per-lineage runner lock, heartbeat, and cross-process stop request. */
export class RunnerLockCoordinator {
  private currentLockOwnerToken: string | undefined;
  private stopRequestPollInterval: ReturnType<typeof setInterval> | undefined;
  private stopRequestPollInFlight = false;
  private heartbeatInterval: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly port: RunnerLockCoordinatorPort) {}

  ownsLock(): boolean {
    return this.currentLockOwnerToken !== undefined;
  }

  async ensureRunnerLock(workingFilePath?: string): Promise<void> {
    if (this.currentLockOwnerToken) return;
    const state = this.port.getQueueState();
    const lockWorkspaceRoot = this.port.getWorkspaceRoot();
    if (
      !workingFilePath ||
      !state.workflowKey ||
      !state.runRef ||
      !lockWorkspaceRoot
    ) {
      return;
    }
    const ownerToken = WorkflowLockManager.generateOwnerToken();
    await WorkflowLockManager.acquireLock(
      lockWorkspaceRoot,
      state.workflowKey,
      {
        schemaVersion: CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.RUNNER_LOCK],
        workflowKey: state.workflowKey,
        runRef: state.runRef,
        runner: this.port.runnerHostIdentity.runner,
        pid: this.port.runnerHostIdentity.pid,
        hostInstanceId: this.port.runnerHostIdentity.hostInstanceId,
        executionInstanceId: this.port.id,
        ownerToken,
        startedAt: Date.now(),
        lastHeartbeat: Date.now(),
      }
    );
    this.currentLockOwnerToken = ownerToken;
    this.startStopRequestPolling();
  }

  startStopRequestPolling(): void {
    this.stopStopRequestPolling();
    this.stopRequestPollInterval = setInterval(() => {
      void this.pollStopRequest();
    }, 1_000);
  }

  stopStopRequestPolling(): void {
    if (this.stopRequestPollInterval !== undefined) {
      clearInterval(this.stopRequestPollInterval);
      this.stopRequestPollInterval = undefined;
    }
  }

  async pollStopRequest(): Promise<void> {
    if (this.stopRequestPollInFlight) return;
    const state = this.port.getQueueState();
    const workspaceRoot = this.port.getWorkspaceRoot();
    const ownerToken = this.currentLockOwnerToken;
    if (!workspaceRoot || !state.workflowKey || !ownerToken) return;

    this.stopRequestPollInFlight = true;
    try {
      const request = await readWorkflowStopRequest(
        workspaceRoot,
        state.workflowKey,
        ownerToken
      );
      if (!request) return;

      Log.info(
        `[inst:${this.port.id.slice(0, 8)}] honoring stop request ${request.requestId}`
      );
      await this.port.stop();
      await deleteWorkflowStopRequest(
        workspaceRoot,
        state.workflowKey,
        ownerToken
      );
    } catch (error) {
      Log.warn(
        `[inst:${this.port.id.slice(0, 8)}] failed to honor stop request:`,
        error
      );
    } finally {
      this.stopRequestPollInFlight = false;
    }
  }

  async releaseRunnerLock(): Promise<void> {
    const state = this.port.getQueueState();
    const lockWorkspaceRoot = this.port.getWorkspaceRoot();
    const ownerToken = this.currentLockOwnerToken;
    if (!lockWorkspaceRoot || !state.workflowKey || !ownerToken) return;
    this.currentLockOwnerToken = undefined;
    this.stopStopRequestPolling();
    await WorkflowLockManager.releaseLock(
      lockWorkspaceRoot,
      state.workflowKey,
      ownerToken
    );
  }

  startHeartbeat(workspaceRoot: string, workflowKey: WorkflowKey): void {
    const ownerToken = this.currentLockOwnerToken;
    if (!ownerToken && !this.port.getExecutionLease()) {
      return;
    }
    this.heartbeatInterval = setInterval(() => {
      if (ownerToken) {
        WorkflowLockManager.updateHeartbeat(
          workspaceRoot,
          workflowKey,
          ownerToken
        ).catch(() => {});
      }
      this.port
        .getExecutionLease()
        ?.updateHeartbeat()
        .catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
  }

  stopHeartbeat(): void {
    if (this.heartbeatInterval !== undefined) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
  }
}
