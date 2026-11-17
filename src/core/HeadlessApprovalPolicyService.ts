import { randomUUID } from "crypto";
import {
  APPROVAL_DECISIONS,
  HEADLESS_APPROVAL_DEFAULT_TIMEOUT_SEC,
  HEADLESS_APPROVAL_DENIAL_MESSAGE,
  HEADLESS_APPROVAL_NO_DASHBOARD_MESSAGE,
  HEADLESS_APPROVAL_PUBLISH_FAILURE_MESSAGE,
  HEADLESS_APPROVAL_POLICIES,
  HEADLESS_APPROVAL_MIN_TIMEOUT_MS,
  HEADLESS_APPROVAL_MAX_TIMEOUT_MS,
  HEADLESS_APPROVAL_SESSION_CLOSED_MESSAGE,
  HEADLESS_APPROVAL_TIMEOUT_MESSAGE,
  MESSAGE_TYPES,
  type ApprovalDecision,
  type HeadlessApprovalPolicy,
} from "../types/DashboardConstants";
import type {
  HeadlessApprovalRequestContext,
  HeadlessApprovalResolution,
} from "../types/WorkflowContextTypes";
import type { HeadlessApprovalRequestMessage } from "../types/WebviewMessageTypes";
import { getErrorMessage } from "../utils/ErrorUtils";
import { Log } from "../utils/Log";

interface PendingApproval {
  message: HeadlessApprovalRequestMessage;
  settle: (resolution: HeadlessApprovalResolution) => void;
}

const MAX_DENY_MESSAGE_LENGTH = 1000;

/** Host-side approval policy and pending-request registry for one workflow. */
export class HeadlessApprovalPolicyService {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(
    private readonly publish: (
      message: HeadlessApprovalRequestMessage
    ) => boolean
  ) {}

  static clampTimeoutMs(
    requestedTimeoutMs: number,
    maxTimeoutMs: number = HEADLESS_APPROVAL_MAX_TIMEOUT_MS
  ): number {
    const safeMaximum = Math.max(
      HEADLESS_APPROVAL_MIN_TIMEOUT_MS,
      Math.min(
        Number.isFinite(maxTimeoutMs)
          ? maxTimeoutMs
          : HEADLESS_APPROVAL_MAX_TIMEOUT_MS,
        HEADLESS_APPROVAL_MAX_TIMEOUT_MS
      )
    );
    const requested = Number.isFinite(requestedTimeoutMs)
      ? Math.round(requestedTimeoutMs)
      : HEADLESS_APPROVAL_DEFAULT_TIMEOUT_SEC * 1000;
    return Math.max(
      HEADLESS_APPROVAL_MIN_TIMEOUT_MS,
      Math.min(requested, safeMaximum)
    );
  }

  requestApproval(
    policy: HeadlessApprovalPolicy,
    request: HeadlessApprovalRequestContext,
    signal: AbortSignal
  ): Promise<HeadlessApprovalResolution> {
    if (policy !== HEADLESS_APPROVAL_POLICIES.ASK) {
      return Promise.resolve({
        decision: APPROVAL_DECISIONS.DENY,
        message: HEADLESS_APPROVAL_DENIAL_MESSAGE,
      });
    }

    if (signal.aborted) {
      return Promise.resolve(this.sessionClosedResolution());
    }

    const approvalId = randomUUID();
    const timeoutMs = HeadlessApprovalPolicyService.clampTimeoutMs(
      request.timeoutMs
    );
    const message: HeadlessApprovalRequestMessage = {
      type: MESSAGE_TYPES.HEADLESS_APPROVAL_REQUEST_CHANGED,
      approvalId,
      requestId: request.requestId,
      workflowId: request.workflowId,
      controlSessionId: request.controlSessionId,
      stepIndex: request.stepIndex,
      harnessId: request.harnessId,
      toolName: request.toolName,
      inputSummary: request.inputSummary,
      deadline: Date.now() + timeoutMs,
      isPending: true,
    };

    return new Promise<HeadlessApprovalResolution>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => {
        settle(this.sessionClosedResolution());
      };
      const settle = (
        resolution: HeadlessApprovalResolution,
        publishRemoval = true
      ): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.pending.delete(approvalId);
        if (publishRemoval) {
          this.publishRemoval(message);
        }
        resolve(resolution);
      };

      this.pending.set(approvalId, { message, settle });
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(
        () =>
          settle({
            decision: APPROVAL_DECISIONS.DENY,
            message: HEADLESS_APPROVAL_TIMEOUT_MESSAGE,
          }),
        timeoutMs
      );

      try {
        if (!this.publish(message)) {
          settle(
            {
              decision: APPROVAL_DECISIONS.DENY,
              message: HEADLESS_APPROVAL_NO_DASHBOARD_MESSAGE,
            },
            false
          );
        }
      } catch (error) {
        Log.warn(
          `[HeadlessApprovalPolicyService] Could not publish approval request: ${getErrorMessage(error)}`
        );
        settle(
          {
            decision: APPROVAL_DECISIONS.DENY,
            message: HEADLESS_APPROVAL_PUBLISH_FAILURE_MESSAGE,
          },
          false
        );
      }
    });
  }

  respond(
    controlSessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
    message?: string
  ): boolean {
    if (
      decision !== APPROVAL_DECISIONS.ALLOW_ONCE &&
      decision !== APPROVAL_DECISIONS.DENY
    ) {
      return false;
    }
    const pending = this.pending.get(approvalId);
    if (!pending || pending.message.controlSessionId !== controlSessionId) {
      return false;
    }
    const denyMessage =
      decision === APPROVAL_DECISIONS.DENY
        ? message?.trim().slice(0, MAX_DENY_MESSAGE_LENGTH) || undefined
        : undefined;
    pending.settle({
      decision,
      ...(denyMessage ? { message: denyMessage } : {}),
    });
    return true;
  }

  getPendingRequests(): HeadlessApprovalRequestMessage[] {
    return Array.from(this.pending.values(), ({ message }) => ({
      ...message,
    }));
  }

  replayPendingRequests(
    send: (message: HeadlessApprovalRequestMessage) => void
  ): void {
    for (const { message } of this.pending.values()) {
      send({ ...message });
    }
  }

  dispose(): void {
    for (const { settle } of this.pending.values()) {
      settle(this.sessionClosedResolution());
    }
  }

  private publishRemoval(message: HeadlessApprovalRequestMessage): void {
    try {
      this.publish({ ...message, isPending: false });
    } catch (error) {
      Log.warn(
        `[HeadlessApprovalPolicyService] Could not publish approval removal: ${getErrorMessage(error)}`
      );
    }
  }

  private sessionClosedResolution(): HeadlessApprovalResolution {
    return {
      decision: APPROVAL_DECISIONS.DENY,
      message: HEADLESS_APPROVAL_SESSION_CLOSED_MESSAGE,
    };
  }
}
