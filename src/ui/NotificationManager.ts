import * as vscode from "vscode";
import { configService } from "../config/CtrlYokeConfigService";
import type { WorkflowOrchestrator } from "../core/WorkflowOrchestrator";
import type {
  WorkflowStep,
  WorkflowSummary,
  CoordinationScopeSnapshot,
} from "../types/CtrlYokeTypes";
import type { DashboardClient } from "./DashboardBroadcastHub";
import {
  NOTIFICATION_SEVERITY,
  type StepStatus,
} from "../types/DashboardConstants";
import {
  buildPromptCompletionNotification,
  buildTestNotificationEvent,
  buildWorkflowCompletionNotification,
  isWorkflowCompletionTransition,
  type CtrlYokeNotificationEvent,
} from "../core/notifications/NotificationEventFactory";
import { CompletionNotificationTracker } from "./notifications/CompletionNotificationTracker";
import {
  showErrorMessage,
  showInformationMessage,
  showWarningMessage,
} from "../platform/VsCodeMessages";

/**
 * NotificationManager
 *
 * Observes workflow summary and step-status updates via DashboardBroadcastHub
 * and emits VS Code toast notifications using the structured notification
 * builders shared with the hosted browser server.
 */
export class NotificationManager implements DashboardClient {
  private readonly completionTracker = new CompletionNotificationTracker();

  constructor(private readonly getOrchestrator: () => WorkflowOrchestrator) {}

  notifyWorkflowAdded(summary: WorkflowSummary): void {
    this.completionTracker.workflowAdded(summary);
  }

  notifyWorkflowDismissed(workflowId: string): void {
    this.completionTracker.workflowDismissed(workflowId);
  }

  notifyWorkflowSummaryUpdated(summary: WorkflowSummary): void {
    const previousSummary = this.completionTracker.summaryUpdated(summary);

    if (!isWorkflowCompletionTransition(previousSummary, summary)) {
      return;
    }

    const event = buildWorkflowCompletionNotification({
      summary,
      settings: configService.getAll().notifications,
    });
    this.showNotification(event);
  }

  notifyActiveWorkflowChanged(_workflowId: string): void {}
  notifyCoordinationScopeUpdated(_scope: CoordinationScopeSnapshot): void {}
  notifyCliWatchOutput(): void {}
  notifyCliPromptsExtended(): void {}
  notifyHarnessAvailability(): void {}
  postMessage(): void {}
  updateExecutionState(): void {}
  updateExecutionCompleted(): void {}

  sendTestNotification(): void {
    this.showNotification(buildTestNotificationEvent());
  }

  updateStepStatus(
    stepIndex: number,
    status: {
      state: string;
      duration?: number;
      message?: string;
      endConditionResult?: unknown;
    },
    _details?: Record<string, unknown>,
    workflowId?: string
  ): void {
    if (!workflowId) {
      return;
    }

    const summary = this.completionTracker.stepStatusChanged(
      workflowId,
      status.state
    );
    if (!summary) {
      return;
    }

    const steps = this.getWorkflowSteps(workflowId);
    const event = buildPromptCompletionNotification({
      summary,
      steps,
      stepIndex,
      stepStatus: {
        state: status.state as StepStatus,
        duration: status.duration,
        message: status.message,
      },
      settings: configService.getAll().notifications,
    });
    this.showNotification(event);
  }

  private getWorkflowSteps(workflowId: string): WorkflowStep[] | undefined {
    const workflow = this.getOrchestrator().getWorkflow(workflowId);
    return workflow?.getQueueState().steps;
  }

  notifyNotificationEvent(event: CtrlYokeNotificationEvent): void {
    this.showNotification(event);
  }

  private showNotification(event: CtrlYokeNotificationEvent | undefined): void {
    if (!event) {
      return;
    }

    const settings = configService.getAll().notifications;
    if (!settings.vscode.enabled) {
      return;
    }

    if (settings.onlyWhenWindowUnfocused && vscode.window.state.focused) {
      return;
    }

    if (!this.completionTracker.markShown(event.id)) {
      return;
    }

    if (event.severity === NOTIFICATION_SEVERITY.ERROR) {
      void showErrorMessage(
        event.title,
        { detail: event.body },
        "Open Dashboard",
        "View Output",
        "Dismiss"
      ).then((action) => {
        if (action === "Open Dashboard") {
          void vscode.commands.executeCommand("ctrlyoke.openPanel");
        } else if (action === "View Output") {
          void vscode.commands.executeCommand("ctrlyoke.showOutputPanel");
        }
      });
      return;
    }

    if (event.severity === NOTIFICATION_SEVERITY.WARNING) {
      void showWarningMessage(
        event.title,
        { detail: event.body },
        "Open Dashboard",
        "View Output",
        "Dismiss"
      ).then((action) => {
        if (action === "Open Dashboard") {
          void vscode.commands.executeCommand("ctrlyoke.openPanel");
        } else if (action === "View Output") {
          void vscode.commands.executeCommand("ctrlyoke.showOutputPanel");
        }
      });
      return;
    }

    void showInformationMessage(
      event.title,
      { detail: event.body },
      "Open Dashboard",
      "Dismiss"
    ).then((action) => {
      if (action === "Open Dashboard") {
        void vscode.commands.executeCommand("ctrlyoke.openPanel");
      }
    });
  }
}
