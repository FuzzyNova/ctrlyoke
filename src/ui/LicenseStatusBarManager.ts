import * as vscode from "vscode";
import { VSCODE_COMMANDS } from "../types/DashboardConstants";
import {
  LICENSE_SOURCES,
  LICENSE_TIERS,
  type Entitlement,
  type LicenseService,
} from "../license/LicenseService";

/** Keeps the extension-host license status visible without requiring a restart. */
export class LicenseStatusBarManager implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly entitlementSubscription: vscode.Disposable;
  private disposed = false;

  constructor(
    context: vscode.ExtensionContext,
    licenseService: LicenseService
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.command = VSCODE_COMMANDS.MANAGE_LICENSE;
    this.entitlementSubscription = licenseService.onDidChangeEntitlement(
      (entitlement) => this.update(entitlement)
    );
    this.update({
      tier: LICENSE_TIERS.FREE,
      features: new Set<string>(),
      expiresAt: null,
    });
    context.subscriptions.push(this);

    void licenseService
      .getEntitlement()
      .then((entitlement) => {
        if (!this.disposed) {
          this.update(entitlement);
        }
      })
      .catch(() => {
        // LicenseService fails open; keep the initial Free indicator if the
        // host cannot read the credential store during startup.
      });
  }

  update(entitlement: Entitlement): void {
    const isPro = entitlement.tier === LICENSE_TIERS.PRO;
    const tierLabel = isPro ? "Pro" : "Free";
    this.statusBarItem.text = `$(key) ${tierLabel}`;
    this.statusBarItem.tooltip = isPro
      ? `ctrlyoke ${tierLabel} license — ${formatEntitlementDetails(entitlement)}`
      : "ctrlyoke Free — click to manage your license";
    this.statusBarItem.show();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.entitlementSubscription.dispose();
    this.statusBarItem.dispose();
  }
}

function formatEntitlementDetails(entitlement: Entitlement): string {
  const expiry = entitlement.expiresAt
    ? `expires ${new Date(entitlement.expiresAt).toLocaleDateString()}`
    : "no expiry";
  const source =
    entitlement.source === LICENSE_SOURCES.OFFLINE_FILE
      ? "offline license file"
      : "online activation";
  return `${expiry}, ${source}. Click to manage.`;
}
