import * as vscode from "vscode";
import * as path from "path";
import {
  EXECUTION_STATES,
  NOTIFICATION_EVENT_MODES,
  type ExecutionState,
} from "../types/DashboardConstants";
import { configService } from "../config/FlightPathConfigService";
import { Log } from "../utils/Log";
import type { WorkflowSummary } from "../types/FlightPathTypes";
import type { DashboardClient } from "./DashboardBroadcastHub";

/**
 * NotificationManager
 *
 * Listens to workflow state transitions via the DashboardBroadcastHub client
 * protocol and fires VS Code toast notifications when workflows reach terminal
 * states, subject to the user's notification settings.
 *
 * Registered as a DashboardBroadcastHub client by extension.ts after startup.
 */
export class NotificationManager implements DashboardClient {
  private readonly notifiedKeys = new Set<string>();
  private readonly workflowSummaries = new Map<string, WorkflowSummary>();

  // ── IDashboardProvider (no-ops — we only observe, never drive) ──────────

  notifyWorkflowAdded(summary: WorkflowSummary): void {
    this.workflowSummaries.set(summary.id, summary);
  }

  notifyWorkflowDismissed(workflowId: string): void {
    this.workflowSummaries.delete(workflowId);
    // Prune notification keys for this workflow to prevent unbounded growth
    for (const key of [...this.notifiedKeys]) {
      if (key.startsWith(`${workflowId}:`)) {
        this.notifiedKeys.delete(key);
      }
    }
  }

  notifyWorkflowSummaryUpdated(summary: WorkflowSummary): void {
    this.workflowSummaries.set(summary.id, { ...summary });
  }

  notifyActiveWorkflowChanged(_workflowId: string): void {}
  notifyCliWatchOutput(): void {}
  notifyCliPromptsExtended(): void {}
  notifyHarnessAvailability(): void {}
  postMessage(): void {}
  notifyStartupComplete(): void {}

  async loadOutputHistoryForWorkflow(): Promise<void> {}

  // ── IDashboardSink (only updateExecutionState matters here) ─────────────

  updateExecutionState(state: string, workflowId?: string): void {
    if (!workflowId) return;
    if (
      state !== EXECUTION_STATES.COMPLETED &&
      state !== EXECUTION_STATES.ERROR
    ) {
      return;
    }
    this.onWorkflowTerminal(workflowId, state as ExecutionState);
  }

  // ── Notification logic ────────────────────────────────────────────────────

  private onWorkflowTerminal(
    workflowId: string,
    state: ExecutionState
  ): void {
    const key = `${workflowId}:workflowComplete`;
    if (this.notifiedKeys.has(key)) return;
    this.notifiedKeys.add(key);

    const settings = configService.getAll().notifications;

    if (!settings.vscode.enabled) return;

    const mode = settings.events.workflowComplete;
    if (mode === NOTIFICATION_EVENT_MODES.NEVER) return;
    if (
      mode === NOTIFICATION_EVENT_MODES.FAILURES_ONLY &&
      state !== EXECUTION_STATES.ERROR
    ) {
      return;
    }

    if (settings.onlyWhenWindowUnfocused && vscode.window.state.focused) {
      return;
    }

    const summary = this.workflowSummaries.get(workflowId);
    this.showWorkflowNotification(state, summary, settings);
  }

  private showWorkflowNotification(
    state: ExecutionState,
    summary: WorkflowSummary | undefined,
    settings: ReturnType<typeof configService.getAll>["notifications"]
  ): void {
    const name =
      settings.includeWorkflowName && summary
        ? summary.workflowName ||
          (summary.filePath ? path.basename(summary.filePath) : undefined)
        : undefined;

    const stepInfo =
      summary && summary.totalSteps > 0
        ? `${summary.currentStep} of ${summary.totalSteps} prompts`
        : undefined;

    const duration = buildDuration(summary);

    if (state === EXECUTION_STATES.COMPLETED) {
      const detail = [name, stepInfo, duration].filter(Boolean).join(" — ");
      const title = "FlightPath — Workflow Complete";
      const body = detail || "Workflow completed successfully.";
      Log.debug(`[NotificationManager] Showing completion toast: ${body}`);
      vscode.window
        .showInformationMessage(title, { detail: body }, "Open Dashboard", "Dismiss")
        .then((action) => {
          if (action === "Open Dashboard") {
            vscode.commands.executeCommand("flightpath.openPanel");
          }
        });
    } else {
      const detail = [name, stepInfo ? `stopped at ${stepInfo}` : undefined]
        .filter(Boolean)
        .join(" — ");
      const title = "FlightPath — Workflow Failed";
      const body = detail || "Workflow failed.";
      Log.debug(`[NotificationManager] Showing failure toast: ${body}`);
      vscode.window
        .showErrorMessage(title, { detail: body }, "Open Dashboard", "View Output", "Dismiss")
        .then((action) => {
          if (action === "Open Dashboard") {
            vscode.commands.executeCommand("flightpath.openPanel");
          } else if (action === "View Output") {
            vscode.commands.executeCommand("flightpath.showOutputPanel");
          }
        });
    }
  }
}

function buildDuration(summary: WorkflowSummary | undefined): string | undefined {
  if (!summary?.startedAt) return undefined;
  const endMs = summary.completedAt ?? Date.now();
  const ms = endMs - summary.startedAt;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
