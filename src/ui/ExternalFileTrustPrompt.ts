import * as vscode from "vscode";
import type { WorkspaceOpenTarget } from "../core/HostPorts";
import {
  confirmExternalFileTrust,
  type ExternalFileTrustContext,
} from "./ExternalRootsApproval";

/** VS Code extension of the host-neutral target with its native editor column. */
export type FileOpenTarget = WorkspaceOpenTarget;

/** Open a target using VS Code's native editor and Explorer behavior. */
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
  if (target.openAsText) {
    const document = await vscode.workspace.openTextDocument(targetUri);
    if (target.viewColumn === undefined) {
      await vscode.window.showTextDocument(document);
    } else {
      await vscode.window.showTextDocument(document, {
        viewColumn: target.viewColumn as vscode.ViewColumn,
        preview: false,
        preserveFocus: false,
      });
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

/** Ask the host-neutral trust flow, then open an approved target in VS Code. */
export async function confirmExternalFileTrustAndOpen(
  target: FileOpenTarget,
  context: ExternalFileTrustContext
): Promise<void> {
  const approved = await confirmExternalFileTrust(target.path, {
    ...context,
    workflowSourcePath: context.workflowSourcePath ?? target.workflowSourcePath,
  });
  if (approved) await openResolvedTarget(target);
}
