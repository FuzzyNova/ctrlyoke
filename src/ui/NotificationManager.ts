import * as vscode from "vscode";
import { configService } from "../config/FlightPathConfigService";
import type { WorkflowOrchestrator } from "../flightpath/WorkflowOrchestrator";
import type { WorkflowStep, WorkflowSummary } from "../types/FlightPathTypes";
import type { DashboardClient } from "./DashboardBroadcastHub";
import {
  COMPLETION_NOTIFICATION_SEVERITY,
  type StepStatus,
} from "../types/DashboardConstants";
import {
  buildPromptCompletionNotification,
  buildTestNotificationEvent,
  buildWorkflowCompletionNotification,
  isWorkflowCompletionTransition,
  type FlightPathNotificationEvent,
} from "./notifications/CompletionNotificationFactory";
import { Log } from "../utils/Log";

/**
 * NotificationManager
 *
 * Observes workflow summary and step-status updates via DashboardBroadcastHub
 * and emits VS Code toast notifications using the structured notification
 * builders shared with the hosted browser server.
 */
export class NotificationManager implements DashboardClient {
  private readonly notifiedKeys = new Set<string>();
  private readonly workflowSummaries = new Map<string, WorkflowSummary>();

  constructor(private readonly getOrchestrator: () => WorkflowOrchestrator) {}

  notifyWorkflowAdded(summary: WorkflowSummary): void {
    this.workflowSummaries.set(summary.id, summary);
  }

  notifyWorkflowDismissed(workflowId: string): void {
    this.workflowSummaries.delete(workflowId);
    for (const key of [...this.notifiedKeys]) {
      if (key.startsWith(`${workflowId}:`)) {
        this.notifiedKeys.delete(key);
      }
    }
  }

  notifyWorkflowSummaryUpdated(summary: WorkflowSummary): void {
    const previousSummary = this.workflowSummaries.get(summary.id);
    this.workflowSummaries.set(summary.id, { ...summary });

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
  notifyCliWatchOutput(): void {}
  notifyCliPromptsExtended(): void {}
  notifyHarnessAvailability(): void {}
  postMessage(): void {}
  notifyStartupComplete(): void {}
  updateExecutionState(): void {}
  updateExecutionCompleted(): void {}

  async loadOutputHistoryForWorkflow(): Promise<void> {}

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

    const summary = this.workflowSummaries.get(workflowId);
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

  notifyNotificationEvent(event: FlightPathNotificationEvent): void {
    this.showNotification(event);
  }

  private showNotification(
    event: FlightPathNotificationEvent | undefined
  ): void {
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

    if (this.notifiedKeys.has(event.id)) {
      return;
    }
    this.notifiedKeys.add(event.id);

    Log.debug(
      `[NotificationManager] showing VS Code notification ${event.id} ${event.title}`
    );

    if (event.severity === COMPLETION_NOTIFICATION_SEVERITY.ERROR) {
      void vscode.window
        .showErrorMessage(
          event.title,
          { detail: event.body },
          "Open Dashboard",
          "View Output",
          "Dismiss"
        )
        .then((action) => {
          if (action === "Open Dashboard") {
            void vscode.commands.executeCommand("flightpath.openPanel");
          } else if (action === "View Output") {
            void vscode.commands.executeCommand("flightpath.showOutputPanel");
          }
        });
      return;
    }

    if (event.severity === COMPLETION_NOTIFICATION_SEVERITY.WARNING) {
      void vscode.window
        .showWarningMessage(
          event.title,
          { detail: event.body },
          "Open Dashboard",
          "View Output",
          "Dismiss"
        )
        .then((action) => {
          if (action === "Open Dashboard") {
            void vscode.commands.executeCommand("flightpath.openPanel");
          } else if (action === "View Output") {
            void vscode.commands.executeCommand("flightpath.showOutputPanel");
          }
        });
      return;
    }

    void vscode.window
      .showInformationMessage(
        event.title,
        { detail: event.body },
        "Open Dashboard",
        "Dismiss"
      )
      .then((action) => {
        if (action === "Open Dashboard") {
          void vscode.commands.executeCommand("flightpath.openPanel");
        }
      });
  }
}
