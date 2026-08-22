import * as vscode from "vscode";
import type { SecretGrantsTrustStore } from "../config/SecretGrantsTrustStore";
import { secretGrantsTrustStore } from "../config/SecretGrantsTrustStore";
import { ExternalRootsTrustStore } from "../config/ExternalRootsTrustStore";
import type { PromptFile } from "../types/CtrlYokeTypes";
import { getWorkflowSecretGrants } from "../utils/SecretResolver";

/**
 * One-time batch approval for a workspace's requested workflow secret grants.
 * Shows a single scrollable, reviewable picker listing every grant that has no
 * recorded decision yet for this workspace identity. Each item defaults checked
 * ("Allow"); unchecking an item before confirming records a "deny" for it
 * instead. Dismissing the picker (Escape) records no decision at all, so the
 * user is asked again next time. Requires VS Code Workspace Trust first.
 */
export async function promptBatchApprovalForPendingWorkspaceSecretGrants(
  workflow: PromptFile,
  workspaceRoot: string,
  store: SecretGrantsTrustStore = secretGrantsTrustStore
): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    return;
  }

  const workspaceIdentity =
    ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot);
  const pendingNames = store.getPendingGrants(
    workspaceIdentity,
    getWorkflowSecretGrants(workflow)
  );
  if (pendingNames.length === 0) {
    return;
  }

  const picks = pendingNames.map((name) => ({ label: name, picked: true }));
  const selection = await vscode.window.showQuickPick(picks, {
    canPickMany: true,
    ignoreFocusOut: true,
    title: `ctrlyoke: this workflow requests ${pendingNames.length} secret grant(s)`,
    placeHolder:
      "Uncheck a grant to keep it blocked, then press Enter to confirm — Escape asks again next time",
  });

  if (selection === undefined) {
    return;
  }

  const approvedNames = selection.map((item) => item.label);
  const deniedNames = pendingNames.filter(
    (name) => !approvedNames.includes(name)
  );

  if (approvedNames.length > 0) {
    await store.setDecisions(workspaceIdentity, approvedNames, "allow");
  }
  if (deniedNames.length > 0) {
    await store.setDecisions(workspaceIdentity, deniedNames, "deny");
  }

  vscode.window.showInformationMessage(
    `ctrlyoke: approved ${approvedNames.length} secret grant(s)` +
      (deniedNames.length > 0 ? `, kept ${deniedNames.length} blocked.` : ".")
  );
}
