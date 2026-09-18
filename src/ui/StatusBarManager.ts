import * as vscode from "vscode";
import { QueueState, EXECUTION_STATES } from "../types/CtrlYokeTypes";
import { HarnessStatus } from "../core/HarnessIntegration";
import type { HarnessDetailedStatus, StatusBarSink } from "../core/HostPorts";
import { VSCODE_CONTEXT_KEYS } from "../types/DashboardConstants";
import {
  LICENSE_SOURCES,
  LICENSE_TIERS,
  type Entitlement,
  type LicenseService,
} from "../license/LicenseService";

interface StatusBarView {
  text: string;
  tooltip: string;
  backgroundColor: vscode.ThemeColor | undefined;
}

/**
 * A single VS Code status bar item for ctrlyoke. Renders the traversal state
 * (idle / ready / run progress) together with the current license tier, so the
 * two previous displays — the compass status and the license key indicator —
 * live in one place instead of on opposite sides of the window.
 */
export class StatusBarManager implements vscode.Disposable, StatusBarSink {
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly entitlementSubscription: vscode.Disposable | undefined;
  private readonly showLicense: boolean;
  private entitlement: Entitlement = createDefaultEntitlement();
  private baseView: StatusBarView = {
    text: "$(compass) ctrlyoke",
    tooltip: "ctrlyoke - Click to open",
    backgroundColor: undefined,
  };

  constructor(
    context: vscode.ExtensionContext,
    licenseService?: LicenseService
  ) {
    this.showLicense = licenseService !== undefined;
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.command = "ctrlyoke.openPanel";

    if (licenseService) {
      // LicenseService fails open; keep the default Free tier if the host
      // cannot read the credential store during startup.
      this.entitlementSubscription = licenseService.onDidChangeEntitlement(
        (entitlement) => {
          this.entitlement = entitlement;
          this.render();
        }
      );
      void licenseService
        .getEntitlement()
        .then((entitlement) => {
          this.entitlement = entitlement;
          this.render();
        })
        .catch(() => {
          // Keep the default Free tier.
        });
    }

    this.updateStatusBar();
    context.subscriptions.push(this.statusBarItem);
    context.subscriptions.push(this);
  }

  /**
   * Update status bar based on queue state and optional Copilot status
   */
  updateStatusBar(
    state?: QueueState,
    copilotStatus?: HarnessDetailedStatus
  ): void {
    let text = "$(compass) ctrlyoke";
    let tooltip = "ctrlyoke - Click to open";
    let backgroundColor: vscode.ThemeColor | undefined;

    if (state) {
      const progress = this.calculateProgress(state);

      switch (state.status) {
        case EXECUTION_STATES.RUNNING:
          text = `$(compass-dot) ctrlyoke ${progress.current}/${progress.total}`;
          tooltip = `ctrlyoke - Running (${progress.percentage}% complete)`;
          backgroundColor = new vscode.ThemeColor(
            "statusBarItem.prominentBackground"
          );
          break;

        case EXECUTION_STATES.PAUSING:
          text = `$(debug-pause) ctrlyoke ${progress.current}/${progress.total}`;
          tooltip = "ctrlyoke - Pausing after the current step";
          backgroundColor = new vscode.ThemeColor(
            "statusBarItem.warningBackground"
          );
          break;

        case EXECUTION_STATES.PAUSED:
          text = `$(debug-pause) ctrlyoke ${progress.current}/${progress.total}`;
          tooltip = "ctrlyoke - Paused (click to resume)";
          backgroundColor = new vscode.ThemeColor(
            "statusBarItem.warningBackground"
          );
          break;

        case EXECUTION_STATES.COMPLETED:
          text = `$(check) ctrlyoke Complete`;
          tooltip = "ctrlyoke - Workflow completed successfully";
          backgroundColor = new vscode.ThemeColor(
            "statusBarItem.prominentBackground"
          );

          // Auto-hide success message after 5 seconds
          setTimeout(() => {
            this.updateStatusBar();
          }, 5000);
          break;

        case EXECUTION_STATES.ERROR:
          text = `$(error) ctrlyoke Error`;
          tooltip = "ctrlyoke - Execution failed (click for details)";
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

    this.baseView = { text, tooltip, backgroundColor };
    this.render();
  }

  setHasQueuedStepsContext(hasQueuedSteps: boolean): void {
    void vscode.commands.executeCommand(
      "setContext",
      VSCODE_CONTEXT_KEYS.HAS_QUEUED_STEPS,
      hasQueuedSteps
    );
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
          text: "$(compass) ctrlyoke - Initializing...",
          tooltip: "ctrlyoke - Checking Copilot availability...",
        };
      case HarnessStatus.Waiting:
        return {
          text: `$(compass) ctrlyoke - Waiting for Copilot (${copilotStatus.pollingAttempts}/${copilotStatus.maxPollingAttempts})`,
          tooltip: "ctrlyoke - Waiting for GitHub Copilot to activate...",
        };
      case HarnessStatus.Ready:
        return {
          text: "$(compass-active) ctrlyoke - Ready",
          tooltip:
            "ctrlyoke - Ready to execute workflows with Copilot automation",
        };
      case HarnessStatus.Unavailable:
        return {
          text: "$(warning) ctrlyoke - Setup Required",
          tooltip:
            "ctrlyoke - Copilot automation unavailable. Click to retry detection.",
        };
      default:
        return {
          text: "$(compass) ctrlyoke",
          tooltip: "ctrlyoke - Click to open",
        };
    }
  }

  /**
   * Calculate progress from queue state
   */
  private calculateProgress(state: QueueState): {
    current: number;
    total: number;
    percentage: number;
  } {
    const total = state.steps.length;
    const current = state.currentIndex;
    const percentage = total > 0 ? Math.round((current / total) * 100) : 0;

    return { current, total, percentage };
  }

  /**
   * Re-apply the base traversal view combined with the current license tier.
   */
  private render(): void {
    if (this.showLicense) {
      this.statusBarItem.text = `${this.baseView.text} ${this.getLicenseText()}`;
      this.statusBarItem.tooltip = `${this.baseView.tooltip}\n\n${this.getLicenseTooltip()}`;
    } else {
      this.statusBarItem.text = this.baseView.text;
      this.statusBarItem.tooltip = this.baseView.tooltip;
    }
    this.statusBarItem.backgroundColor = this.baseView.backgroundColor;
    this.statusBarItem.show();
  }

  private getLicenseText(): string {
    const tierLabel =
      this.entitlement.tier === LICENSE_TIERS.PRO
        ? this.entitlement.isEnterprise
          ? "Enterprise"
          : "Pro"
        : "Free";
    return `$(key) ${tierLabel}`;
  }

  private getLicenseTooltip(): string {
    if (this.entitlement.tier === LICENSE_TIERS.PRO) {
      const tierName = this.entitlement.isEnterprise ? "Enterprise" : "Pro";
      return `ctrlyoke ${tierName} license — ${formatEntitlementDetails(
        this.entitlement
      )}`;
    }
    return "ctrlyoke Free tier";
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    this.entitlementSubscription?.dispose();
    this.statusBarItem.dispose();
  }
}

function createDefaultEntitlement(): Entitlement {
  return {
    tier: LICENSE_TIERS.FREE,
    features: new Set<string>(),
    expiresAt: null,
  };
}

function formatEntitlementDetails(entitlement: Entitlement): string {
  const expiry = entitlement.expiresAt
    ? `expires ${new Date(entitlement.expiresAt).toLocaleDateString()}`
    : "no expiry";
  const source =
    entitlement.source === LICENSE_SOURCES.OFFLINE_FILE
      ? "offline license file"
      : "online activation";
  return `${expiry}, ${source}`;
}
