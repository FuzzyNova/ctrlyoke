import * as path from "path";
import * as vscode from "vscode";
import {
  resolveWorkspaceRoot,
  type ResolverWorkspaceFolder,
} from "./WorkspaceRootResolver";

/** Native VS Code config namespace for bootstrap settings. */
const CONFIG_NAMESPACE = "flightpath";
/** Native setting key holding the directory that contains `.flightpath`. */
const WORKSPACE_DIRECTORY_SETTING = "workspaceDirectory";

/**
 * Gather the current window's resolver inputs from the live `vscode.workspace`
 * state and run {@link resolveWorkspaceRoot}.
 *
 * This is the single VS Code-side binding for the workspace root. Every
 * extension-host consumer that previously read
 * `vscode.workspace.workspaceFolders?.[0]?.uri.fsPath` must call this instead,
 * so the `.flightpath` location is computed in exactly one place and honors the
 * `.code-workspace` directory plus the `flightpath.workspaceDirectory` setting.
 */
export function getVsCodeWorkspaceRoot(): string {
  const setting = vscode.workspace
    .getConfiguration(CONFIG_NAMESPACE)
    .get<string>(WORKSPACE_DIRECTORY_SETTING, "");

  const workspaceFile = vscode.workspace.workspaceFile;
  // Only an on-disk (`file:`) workspace file yields a usable directory.
  // `undefined` (single folder) and `untitled:` (unsaved multi-root) fall
  // through to the workspace-folder branch inside the resolver.
  const workspaceFileDir =
    workspaceFile?.scheme === "file"
      ? path.dirname(workspaceFile.fsPath)
      : undefined;

  const workspaceFolders: ResolverWorkspaceFolder[] = (
    vscode.workspace.workspaceFolders ?? []
  ).map((folder) => ({ name: folder.name, fsPath: folder.uri.fsPath }));

  return resolveWorkspaceRoot({
    setting,
    workspaceFileDir,
    workspaceFolders,
  });
}

/**
 * Return a `vscode.WorkspaceFolder` whose `uri.fsPath` is the resolved
 * workspace root, or `undefined` when no folder is open.
 *
 * When the resolved root matches a real workspace folder, that folder is
 * returned as-is. Otherwise (the root is a `.code-workspace` directory or an
 * explicit `flightpath.workspaceDirectory` override that is not itself one of
 * the folders) a synthetic folder pointing at the resolved root is returned, so
 * every consumer that derives paths from `.uri.fsPath` stays in agreement with
 * {@link getVsCodeWorkspaceRoot}. Use this only where a `WorkspaceFolder`
 * object is genuinely required; otherwise prefer {@link getVsCodeWorkspaceRoot}.
 */
export function getVsCodeWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  const root = getVsCodeWorkspaceRoot();
  const match = folders.find((folder) => folder.uri.fsPath === root);
  if (match) {
    return match;
  }
  return {
    uri: vscode.Uri.file(root),
    name: path.basename(root),
    index: 0,
  };
}
