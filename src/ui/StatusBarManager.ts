import * as vscode from "vscode";
import { QueueState, EXECUTION_STATES } from "../types/FlightPathTypes";
import { HarnessStatus } from "../flightpath/HarnessIntegration";

/**
 * Detailed status from harness integration
 */
export interface HarnessDetailedStatus {
  initializationStatus: HarnessStatus;
  isReady: boolean;
  message: string;
  pollingAttempts?: number;
  maxPollingAttempts?: number;
}

export class StatusBarManager {
  private statusBarItem: vscode.StatusBarItem;

  constructor(context: vscode.ExtensionContext) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBarItem.command = "flightpath.openPanel";
    this.updateStatusBar();
    context.subscriptions.push(this.statusBarItem);
  }

  /**
   * Update status bar based on queue state and optional Copilot status
   */
  updateStatusBar(
    state?: QueueState,
    copilotStatus?: HarnessDetailedStatus
  ): void {
    let text = "$(compass) FlightPath";
    let tooltip = "FlightPath - Click to open";
    let backgroundColor: vscode.ThemeColor | undefined;

    if (state) {
      const progress = this.calculateProgress(state);

      switch (state.status) {
        case EXECUTION_STATES.RUNNING:
          text = `$(compass-dot) FlightPath ${progress.current}/${progress.total}`;
          tooltip = `FlightPath - Running (${progress.percentage}% complete)`;
          backgroundColor = new vscode.ThemeColor(
            "statusBarItem.prominentBackground"
          );
          break;

        case EXECUTION_STATES.PAUSED:
          text = `$(debug-pause) FlightPath ${progress.current}/${progress.total}`;
          tooltip = "FlightPath - Paused (click to resume)";
          backgroundColor = new vscode.ThemeColor(
            "statusBarItem.warningBackground"
          );
          break;

        case EXECUTION_STATES.COMPLETED:
          text = `$(check) FlightPath Complete`;
          tooltip = "FlightPath - Workflow completed successfully";
          backgroundColor = new vscode.ThemeColor(
            "statusBarItem.prominentBackground"
          );

          // Auto-hide success message after 5 seconds
          setTimeout(() => {
            this.updateStatusBar();
          }, 5000);
          break;

        case EXECUTION_STATES.ERROR:
          text = `$(error) FlightPath Error`;
          tooltip = "FlightPath - Execution failed (click for details)";
          backgroundColor = new vscode.ThemeColor(
            "statusBarItem.errorBackground"
          );
          break;

        case EXECUTION_STATES.IDLE:
        default:
          // When idle, show harness initialization status if provided
          if (copilotStatus) {
            const copilotDisplay = this.getHarnessStatusDisplay(copilotStatus);
            text = copilotDisplay.text;
            tooltip = copilotDisplay.tooltip;
          }
          break;
      }
    } else if (copilotStatus) {
      // No queue state but have harness status - show harness status
      const copilotDisplay = this.getHarnessStatusDisplay(copilotStatus);
      text = copilotDisplay.text;
      tooltip = copilotDisplay.tooltip;
    }

    this.statusBarItem.text = text;
    this.statusBarItem.tooltip = tooltip;
    this.statusBarItem.backgroundColor = backgroundColor;
    this.statusBarItem.show();
  }

  /**
   * Get display text and tooltip for harness initialization status
   */
  private getHarnessStatusDisplay(copilotStatus: HarnessDetailedStatus): {
    text: string;
    tooltip: string;
  } {
    switch (copilotStatus.initializationStatus) {
      case HarnessStatus.Initializing:
        return {
          text: "$(compass) FlightPath - Initializing...",
          tooltip: "FlightPath - Checking Copilot availability...",
        };
      case HarnessStatus.Waiting:
        return {
          text: `$(compass) FlightPath - Waiting for Copilot (${copilotStatus.pollingAttempts}/${copilotStatus.maxPollingAttempts})`,
          tooltip: "FlightPath - Waiting for GitHub Copilot to activate...",
        };
      case HarnessStatus.Ready:
        return {
          text: "$(compass-active) FlightPath - Ready",
          tooltip:
            "FlightPath - Ready to execute workflows with Copilot automation",
        };
      case HarnessStatus.Unavailable:
        return {
          text: "$(warning) FlightPath - Setup Required",
          tooltip:
            "FlightPath - Copilot automation unavailable. Click to retry detection.",
        };
      default:
        return {
          text: "$(compass) FlightPath",
          tooltip: "FlightPath - Click to open",
        };
    }
  }

  /**
   * Hide status bar item
   */
  hide(): void {
    this.statusBarItem.hide();
  }

  /**
   * Show status bar item
   */
  show(): void {
    this.statusBarItem.show();
  }

  /**
   * Calculate progress from queue state
   */
  private calculateProgress(state: QueueState): {
    current: number;
    total: number;
    percentage: number;
  } {
    const total = state.prompts.length;
    const current = state.currentIndex;
    const percentage = total > 0 ? Math.round((current / total) * 100) : 0;

    return { current, total, percentage };
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    this.statusBarItem.dispose();
  }
}
