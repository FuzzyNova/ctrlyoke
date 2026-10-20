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
 * The logo glyph package.json contributes under `contributes.icons`, built by
 * `scripts/generate-icon-font.mjs`.
 */
export const PRODUCT_ICON_ID = "ctrlyoke-logo";
const PRODUCT_ICON = `$(${PRODUCT_ICON_ID})`;

/**
 * Describe the status bar for the session's workflow activity. Severity picks
 * the icon and color: an unseen failure, then a paused workflow, then running
 * work, then a just-completed run, then harness readiness when nothing is live.
 * Running work and readiness both show the logo; the text tells them apart.
 * `label` names the product in the item's text (e.g. "ctrlyoke Pro"); the
 * tooltip always says plain "ctrlyoke".
 */
export function buildStatusBarView(
  activity: WorkflowActivitySummary,
  harnessStatus?: DefaultHarnessStatus,
  label: string = PRODUCT_LABEL
): StatusBarView {
  const { running, paused, unseenFailures, recentCompletion } = activity;
  const failureCount = unseenFailures.length;
  const liveCount = running.length + paused.length;

  if (failureCount === 0 && liveCount === 0) {
    if (recentCompletion) {
      return {
        text: `$(check) ${label} Complete`,
        tooltip: `${PRODUCT_LABEL} - ${displayName(recentCompletion)} completed successfully`,
        background: undefined,
        command: VSCODE_COMMANDS.OPEN_PANEL,
      };
    }
    return {
      ...getHarnessStatusDisplay(harnessStatus, label),
      background: undefined,
    };
  }

  const tooltipLines = [
    ...unseenFailures.map((entry) => `Failed: ${displayName(entry)}`),
    ...paused.map((entry) => `Paused: ${describeLive(entry)}`),
    ...running.map((entry) => `Running: ${describeLive(entry)}`),
  ];

  if (failureCount > 0) {
    return {
      text: `$(error) ${label} ${joinCounts(failureCount, paused.length, running.length)}`,
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

  const icon = paused.length > 0 ? "$(debug-pause)" : PRODUCT_ICON;
  const onlyLive = liveCount === 1 ? (paused[0] ?? running[0]) : undefined;
  return {
    text: onlyLive
      ? `${icon} ${label} ${onlyLive.progressLabel}`
      : `${icon} ${label} ${joinCounts(0, paused.length, running.length)}`,
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
  harnessStatus: DefaultHarnessStatus | undefined,
  label: string
): Omit<StatusBarView, "background"> {
  const openPanel = VSCODE_COMMANDS.OPEN_PANEL;
  if (!harnessStatus) {
    return {
      text: `${PRODUCT_ICON} ${label}`,
      tooltip: `${PRODUCT_LABEL} - Click to open`,
      command: openPanel,
    };
  }
  const harnessName = getHarnessDisplayName(harnessStatus.harnessId);
  switch (harnessStatus.initializationStatus) {
    case HarnessStatus.Initializing:
      return {
        text: `${PRODUCT_ICON} ${label} - Initializing...`,
        tooltip: `${PRODUCT_LABEL} - Checking ${harnessName} availability...`,
        command: openPanel,
      };
    case HarnessStatus.Ready:
      return {
        text: `${PRODUCT_ICON} ${label} - Ready`,
        tooltip: `${PRODUCT_LABEL} - Ready to run workflows with ${harnessName}`,
        command: openPanel,
      };
    case HarnessStatus.Unavailable:
      return {
        text: `$(warning) ${label} - Setup Required`,
        tooltip: `${PRODUCT_LABEL} - ${harnessName} was not found. Install it and sign in, then click to check again.`,
        command: VSCODE_COMMANDS.RETRY_HARNESS_DETECTION,
      };
  }
}

/**
 * A single VS Code status bar item for ctrlyoke. Renders the session's
 * workflow activity (see {@link buildStatusBarView}) with the current license
 * tier folded into the product name ("ctrlyoke Pro", "ctrlyoke Free").
 */
export class StatusBarManager implements vscode.Disposable, StatusBarSink {
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly entitlementSubscription: vscode.Disposable | undefined;
  private readonly showLicense: boolean;
  private entitlement: Entitlement = createDefaultEntitlement();
  private activity: WorkflowActivitySummary = EMPTY_WORKFLOW_ACTIVITY;
  private harnessStatus: DefaultHarnessStatus | undefined;

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
    this.activity = activity;
    this.harnessStatus = harnessStatus;
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
   * Rebuild the activity view, naming the product with the current license
   * tier when a license service is present.
   */
  private render(): void {
    const tierName = getTierName(this.entitlement);
    const view = buildStatusBarView(
      this.activity,
      this.harnessStatus,
      this.showLicense ? `${PRODUCT_LABEL} ${tierName}` : PRODUCT_LABEL
    );
    this.statusBarItem.text = view.text;
    this.statusBarItem.tooltip = this.showLicense
      ? `${view.tooltip}\n\n${this.getLicenseTooltip(tierName)}`
      : view.tooltip;
    this.statusBarItem.backgroundColor = view.background
      ? new vscode.ThemeColor(view.background)
      : undefined;
    this.statusBarItem.command = view.command;
    this.statusBarItem.show();
  }

  private getLicenseTooltip(tierName: string): string {
    if (this.entitlement.tier === LICENSE_TIERS.PRO) {
      return `${PRODUCT_LABEL} ${tierName} license — ${formatEntitlementDetails(
        this.entitlement
      )}`;
    }
    return `${PRODUCT_LABEL} ${tierName} tier`;
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

function getTierName(entitlement: Entitlement): string {
  if (entitlement.tier !== LICENSE_TIERS.PRO) {
    return "Free";
  }
  return entitlement.isEnterprise ? "Enterprise" : "Pro";
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
