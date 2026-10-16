import * as vscode from "vscode";
import { HarnessStatus } from "../core/HarnessIntegration";
import {
  EMPTY_WORKFLOW_ACTIVITY,
  type DefaultHarnessStatus,
  type LiveWorkflowActivity,
  type StatusBarSink,
  type WorkflowActivityEntry,
  type WorkflowActivitySummary,
} from "../core/HostPorts";
import {
  DEFAULT_WORKFLOW_NAME,
  VSCODE_COMMANDS,
  getHarnessDisplayName,
  VSCODE_CONTEXT_KEYS,
} from "../types/DashboardConstants";
import {
  LICENSE_SOURCES,
  LICENSE_TIERS,
  type Entitlement,
  type LicenseService,
} from "../license/LicenseService";

/**
 * The only background colors VS Code honors on a status bar item; any other
 * theme color (e.g. `statusBarItem.prominentBackground`) is silently ignored.
 */
export const STATUS_BAR_BACKGROUNDS = {
  ERROR: "statusBarItem.errorBackground",
  WARNING: "statusBarItem.warningBackground",
} as const;

type StatusBarBackground =
  (typeof STATUS_BAR_BACKGROUNDS)[keyof typeof STATUS_BAR_BACKGROUNDS];

export interface StatusBarView {
  text: string;
  tooltip: string;
  background: StatusBarBackground | undefined;
  command: string;
}

const PRODUCT_LABEL = "ctrlyoke";

/**
 * Describe the status bar for the session's workflow activity. Severity picks
 * the icon and color: an unseen failure, then a paused workflow, then running
 * work, then a just-completed run, then harness readiness when nothing is live.
 */
export function buildStatusBarView(
  activity: WorkflowActivitySummary,
  harnessStatus?: DefaultHarnessStatus
): StatusBarView {
  const { running, paused, unseenFailures, recentCompletion } = activity;
  const failureCount = unseenFailures.length;
  const liveCount = running.length + paused.length;

  if (failureCount === 0 && liveCount === 0) {
    if (recentCompletion) {
      return {
        text: `$(check) ${PRODUCT_LABEL} Complete`,
        tooltip: `${PRODUCT_LABEL} - ${displayName(recentCompletion)} completed successfully`,
        background: undefined,
        command: VSCODE_COMMANDS.OPEN_PANEL,
      };
    }
    return { ...getHarnessStatusDisplay(harnessStatus), background: undefined };
  }

  const tooltipLines = [
    ...unseenFailures.map((entry) => `Failed: ${displayName(entry)}`),
    ...paused.map((entry) => `Paused: ${describeLive(entry)}`),
    ...running.map((entry) => `Running: ${describeLive(entry)}`),
  ];

  if (failureCount > 0) {
    return {
      text: `$(error) ${PRODUCT_LABEL} ${joinCounts(failureCount, paused.length, running.length)}`,
      tooltip: [
        PRODUCT_LABEL,
        ...tooltipLines,
        "",
        failureCount === 1
          ? "Click to open the failed run"
          : "Click to open the oldest failed run",
      ].join("\n"),
      background: STATUS_BAR_BACKGROUNDS.ERROR,
      command: VSCODE_COMMANDS.OPEN_UNSEEN_FAILED_RUN,
    };
  }

  const icon = paused.length > 0 ? "$(debug-pause)" : "$(compass-dot)";
  const onlyLive = liveCount === 1 ? (paused[0] ?? running[0]) : undefined;
  return {
    text: onlyLive
      ? `${icon} ${PRODUCT_LABEL} ${onlyLive.progressLabel}`
      : `${icon} ${PRODUCT_LABEL} ${joinCounts(0, paused.length, running.length)}`,
    tooltip: [PRODUCT_LABEL, ...tooltipLines, "", "Click to open"].join("\n"),
    background: paused.length > 0 ? STATUS_BAR_BACKGROUNDS.WARNING : undefined,
    command: VSCODE_COMMANDS.OPEN_PANEL,
  };
}

function joinCounts(failed: number, paused: number, running: number): string {
  return [
    failed > 0 ? `${failed} failed` : undefined,
    paused > 0 ? `${paused} paused` : undefined,
    running > 0 ? `${running} running` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
}

function displayName(entry: WorkflowActivityEntry): string {
  return entry.workflowName || DEFAULT_WORKFLOW_NAME;
}

function describeLive(entry: LiveWorkflowActivity): string {
  return `${displayName(entry)} (${entry.progressLabel})`;
}

function getHarnessStatusDisplay(
  harnessStatus: DefaultHarnessStatus | undefined
): Omit<StatusBarView, "background"> {
  const openPanel = VSCODE_COMMANDS.OPEN_PANEL;
  if (!harnessStatus) {
    return {
      text: `$(compass) ${PRODUCT_LABEL}`,
      tooltip: `${PRODUCT_LABEL} - Click to open`,
      command: openPanel,
    };
  }
  const harnessName = getHarnessDisplayName(harnessStatus.harnessId);
  switch (harnessStatus.initializationStatus) {
    case HarnessStatus.Initializing:
      return {
        text: `$(compass) ${PRODUCT_LABEL} - Initializing...`,
        tooltip: `${PRODUCT_LABEL} - Checking ${harnessName} availability...`,
        command: openPanel,
      };
    case HarnessStatus.Ready:
      return {
        text: `$(compass-active) ${PRODUCT_LABEL} - Ready`,
        tooltip: `${PRODUCT_LABEL} - Ready to run workflows with ${harnessName}`,
        command: openPanel,
      };
    case HarnessStatus.Unavailable:
      return {
        text: `$(warning) ${PRODUCT_LABEL} - Setup Required`,
        tooltip: `${PRODUCT_LABEL} - ${harnessName} was not found. Install it and sign in, then click to check again.`,
        command: VSCODE_COMMANDS.RETRY_HARNESS_DETECTION,
      };
  }
}

/**
 * A single VS Code status bar item for ctrlyoke. Renders the session's
 * workflow activity (see {@link buildStatusBarView}) together with the current
 * license tier, so the two previous displays — the compass status and the
 * license key indicator — live in one place.
 */
export class StatusBarManager implements vscode.Disposable, StatusBarSink {
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly entitlementSubscription: vscode.Disposable | undefined;
  private readonly showLicense: boolean;
  private entitlement: Entitlement = createDefaultEntitlement();
  private baseView: StatusBarView = buildStatusBarView(EMPTY_WORKFLOW_ACTIVITY);

  constructor(
    context: Pick<vscode.ExtensionContext, "subscriptions">,
    licenseService?: LicenseService
  ) {
    this.showLicense = licenseService !== undefined;
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );

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

    this.render();
    context.subscriptions.push(this.statusBarItem);
    context.subscriptions.push(this);
  }

  updateStatusBar(
    activity: WorkflowActivitySummary,
    harnessStatus?: DefaultHarnessStatus
  ): void {
    this.baseView = buildStatusBarView(activity, harnessStatus);
    this.render();
  }

  setHasQueuedStepsContext(hasQueuedSteps: boolean): void {
    void vscode.commands.executeCommand(
      "setContext",
      VSCODE_CONTEXT_KEYS.HAS_QUEUED_STEPS,
      hasQueuedSteps
    );
  }

  setHarnessDetectedContext(detected: boolean): void {
    void vscode.commands.executeCommand(
      "setContext",
      VSCODE_CONTEXT_KEYS.HARNESS_DETECTED,
      detected
    );
  }

  /**
   * Re-apply the base activity view combined with the current license tier.
   */
  private render(): void {
    if (this.showLicense) {
      this.statusBarItem.text = `${this.baseView.text} ${this.getLicenseText()}`;
      this.statusBarItem.tooltip = `${this.baseView.tooltip}\n\n${this.getLicenseTooltip()}`;
    } else {
      this.statusBarItem.text = this.baseView.text;
      this.statusBarItem.tooltip = this.baseView.tooltip;
    }
    this.statusBarItem.backgroundColor = this.baseView.background
      ? new vscode.ThemeColor(this.baseView.background)
      : undefined;
    this.statusBarItem.command = this.baseView.command;
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
