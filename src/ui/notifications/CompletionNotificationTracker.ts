import type { WorkflowSummary } from "../../types/CtrlYokeTypes";
import { EXECUTION_STATES, STEP_STATUS } from "../../types/DashboardConstants";
import { notificationIdentityPrefix } from "../../core/notifications/NotificationEventFactory";

/** Owns per-client completion notification history and workflow summaries. */
export class CompletionNotificationTracker {
  private readonly workflowSummaries = new Map<string, WorkflowSummary>();
  private readonly shownEventIds = new Set<string>();

  workflowAdded(summary: WorkflowSummary): void {
    this.workflowSummaries.set(summary.id, { ...summary });
  }

  workflowDismissed(workflowId: string): void {
    const summary = this.workflowSummaries.get(workflowId);
    if (summary) {
      this.clearShownEventIds(summary);
    }
    this.workflowSummaries.delete(workflowId);
  }

  summaryUpdated(summary: WorkflowSummary): WorkflowSummary | undefined {
    const previousSummary = this.workflowSummaries.get(summary.id);
    this.workflowSummaries.set(summary.id, { ...summary });

    if (
      summary.executionState === EXECUTION_STATES.RUNNING &&
      (previousSummary?.executionState === EXECUTION_STATES.COMPLETED ||
        previousSummary?.executionState === EXECUTION_STATES.ERROR)
    ) {
      this.clearShownEventIds(summary);
    }

    return previousSummary;
  }

  stepStatusChanged(
    workflowId: string,
    state: string
  ): WorkflowSummary | undefined {
    const summary = this.workflowSummaries.get(workflowId);
    if (summary && state === STEP_STATUS.RUNNING) {
      this.clearShownEventIds(summary);
    }
    return summary;
  }

  markShown(eventId: string): boolean {
    if (this.shownEventIds.has(eventId)) {
      return false;
    }
    this.shownEventIds.add(eventId);
    return true;
  }

  private clearShownEventIds(summary: WorkflowSummary): void {
    const prefix = notificationIdentityPrefix(summary);
    for (const eventId of this.shownEventIds) {
      if (eventId.startsWith(prefix)) {
        this.shownEventIds.delete(eventId);
      }
    }
  }
}
