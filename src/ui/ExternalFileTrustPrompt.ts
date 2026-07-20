import * as vscode from "vscode";
import * as path from "path";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import {
  ExternalRootsTrustStore,
  externalRootsTrustStore,
} from "../config/ExternalRootsTrustStore";

/**
 * An already-resolved absolute path to open, plus enough shape to pick the
 * right VS Code open behavior. Shared between `WebviewMessageRouter`'s
 * dashboard "open file" flow and the editor `ctrlyoke.confirmExternalFileTrust`
 * command used by `PromptLinkProvider` for untrusted external references.
 */
export interface FileOpenTarget {
  path: string;
  isDirectory?: boolean;
  startLine?: number;
  endLine?: number;
}

/**
 * Open an already-trusted target the same way regardless of caller: reveal
 * directories in the Explorer, jump to a line selection when one is
 * requested, otherwise let VS Code pick the right editor/viewer for the file
 * type via the `vscode.open` command (so binary files like images/PDFs don't
 * fail with "File seems to be binary and cannot be opened as text").
 */
export async function openResolvedTarget(
  target: FileOpenTarget
): Promise<void> {
  const targetUri = vscode.Uri.file(target.path);

  if (target.isDirectory) {
    try {
      await vscode.commands.executeCommand("revealInExplorer", targetUri);
    } catch {
      await vscode.commands.executeCommand("revealFileInOS", targetUri);
    }
    return;
  }

  if (target.startLine) {
    const start = new vscode.Position(target.startLine - 1, 0);
    const end = target.endLine
      ? new vscode.Position(target.endLine - 1, Number.MAX_SAFE_INTEGER)
      : start;
    await vscode.window.showTextDocument(targetUri, {
      preview: false,
      selection: new vscode.Range(start, end),
    });
    return;
  }

  await vscode.commands.executeCommand("vscode.open", targetUri, {
    preview: false,
  });
}

/**
 * Show the "Trust Parent Folder" confirmation for a path outside every
 * trusted root, and persist an approval to user-scope
 * `permissions.allowedExternalFileRoots` if the user confirms. Returns
 * whether the path is now trusted. See
 * dev/backlog/ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md ("File Link Opening Flow").
 *
 * `ui.offerTrustForUntrustedFileLinks: false` does not widen trust — it only
 * suppresses this offer, leaving the path blocked outright.
 */
export async function confirmExternalFileTrust(
  candidatePath: string
): Promise<boolean> {
  if (!ConfigurationUtils.shouldOfferTrustForUntrustedFileLinks()) {
    vscode.window.showWarningMessage(
      `ctrlyoke blocked a file link outside the current workspace: ${candidatePath}`
    );
    return false;
  }

  const parentFolder = path.dirname(candidatePath);
  const choice = await vscode.window.showWarningMessage(
    `Trust "${parentFolder}" so ctrlyoke can read and open files under it?`,
    {
      modal: true,
      detail:
        `ctrlyoke blocked access to a file outside your workspace and outside ` +
        `any currently trusted external root:\n${candidatePath}`,
    },
    "Trust Parent Folder"
  );
  if (choice !== "Trust Parent Folder") {
    return false;
  }

  await ConfigurationUtils.addUserAllowedExternalFileRoot(parentFolder);
  return true;
}

/**
 * Confirm trust for `target.path`'s parent folder (see
 * {@link confirmExternalFileTrust}), then open it if approved. This is the
 * handler behind the shared `ctrlyoke.confirmExternalFileTrust` command.
 */
export async function confirmExternalFileTrustAndOpen(
  target: FileOpenTarget
): Promise<void> {
  const approved = await confirmExternalFileTrust(target.path);
  if (approved) {
    await openResolvedTarget(target);
  }
}

/**
 * One-time batch approval for a workspace's requested external file roots
 * (`permissions.allowedExternalFileRoots` at workspace scope). Shows a
 * single scrollable, reviewable picker — never one popup per root — listing
 * every root that has no recorded decision yet for this workspace identity.
 * Each item defaults checked ("Trust"); unchecking an item before confirming
 * records a "deny" for it instead. Dismissing the picker (Escape) records no
 * decision at all, so the user is asked again next time. Requires VS Code
 * Workspace Trust first — untrusted workspaces are skipped entirely and
 * retried once trust is granted (see the `onDidGrantWorkspaceTrust` listener
 * in `extension.ts`). See
 * dev/backlog/ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md ("Additional Decisions
 * (2026-07-13)").
 */
export async function promptBatchApprovalForPendingWorkspaceExternalRoots(
  workspaceRoot: string
): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    return;
  }

  const workspaceIdentity =
    ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot);
  const pendingRoots =
    ConfigurationUtils.getPendingWorkspaceExternalFileRoots(workspaceIdentity);
  if (pendingRoots.length === 0) {
    return;
  }

  const picks = pendingRoots.map((root) => ({ label: root, picked: true }));
  const selection = await vscode.window.showQuickPick(picks, {
    canPickMany: true,
    ignoreFocusOut: true,
    title: `ctrlyoke: this workspace requests ${pendingRoots.length} external file root(s)`,
    placeHolder:
      "Uncheck a folder to keep it blocked, then press Enter to confirm — Escape asks again next time",
  });

  if (selection === undefined) {
    return;
  }

  const approvedRoots = selection.map((item) => item.label);
  const deniedRoots = pendingRoots.filter(
    (root) => !approvedRoots.includes(root)
  );

  if (approvedRoots.length > 0) {
    await externalRootsTrustStore.setDecisions(
      workspaceIdentity,
      approvedRoots,
      "allow"
    );
  }
  if (deniedRoots.length > 0) {
    await externalRootsTrustStore.setDecisions(
      workspaceIdentity,
      deniedRoots,
      "deny"
    );
  }

  vscode.window.showInformationMessage(
    `ctrlyoke: approved ${approvedRoots.length} external file root(s)` +
      (deniedRoots.length > 0 ? `, kept ${deniedRoots.length} blocked.` : ".")
  );
}
