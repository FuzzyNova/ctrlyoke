import * as vscode from "vscode";
import { isMultiRootWorkspace } from "../platform/VsCodeWorkspaceRoot";
import { normalizeReferencePath } from "./ContextReferenceBuilder";

export function toWorkspaceRelativeReferencePath(
  uri: vscode.Uri
): string | null {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    return null;
  }

  return normalizeReferencePath(
    vscode.workspace.asRelativePath(uri, isMultiRootWorkspace())
  );
}
