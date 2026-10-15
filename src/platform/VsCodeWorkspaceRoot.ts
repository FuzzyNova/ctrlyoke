import * as path from "path";
import * as vscode from "vscode";
import { pathsEqual } from "../utils/PathCasing";
import { URI_SCHEMES } from "../types/DashboardConstants";
import {
  resolveWorkspaceRoot,
  resolveTrustedWorkspaceRoots,
  resolveRequestedExternalWorkspaceRoot,
  type ResolverWorkspaceFolder,
  type WorkspaceRootResolverInput,
} from "./WorkspaceRootResolver";

/** Native VS Code config namespace for bootstrap settings. */
const CONFIG_NAMESPACE = "ctrlyoke";
/** Native setting key holding the directory that contains `.ctrlyoke`. */
const WORKSPACE_DIRECTORY_SETTING = "workspaceDirectory";

/**
 * Gather the current window's resolver inputs from the live `vscode.workspace`
 * state. Shared by every function in this module so they all agree on what
 * "the workspace" means.
 */
function gatherResolverInput(): WorkspaceRootResolverInput {
  const setting = vscode.workspace
    .getConfiguration(CONFIG_NAMESPACE)
    .get<string>(WORKSPACE_DIRECTORY_SETTING, "");

  const workspaceFile = vscode.workspace.workspaceFile;
  // Only an on-disk (`file:`) workspace file yields a usable directory.
  // `undefined` (single folder) and `untitled:` (unsaved multi-root) fall
  // through to the workspace-folder branch inside the resolver.
  const workspaceFileDir =
    workspaceFile?.scheme === URI_SCHEMES.FILE
      ? path.dirname(workspaceFile.fsPath)
      : undefined;

  const workspaceFolders: ResolverWorkspaceFolder[] = (
    vscode.workspace.workspaceFolders ?? []
  ).map((folder) => ({ name: folder.name, fsPath: folder.uri.fsPath }));

  return { setting, workspaceFileDir, workspaceFolders };
}

/**
 * Resolve the directory that contains the `.ctrlyoke` folder for the current
 * window by running {@link resolveWorkspaceRoot} against live `vscode.workspace`
 * state.
 *
 * This is the single VS Code-side binding for the workspace root. Every
 * extension-host consumer that previously read
 * `vscode.workspace.workspaceFolders?.[0]?.uri.fsPath` must call this instead,
 * so the `.ctrlyoke` location is computed in exactly one place and honors the
 * `.code-workspace` directory plus the `ctrlyoke.workspaceDirectory` setting.
 */
export function getVsCodeWorkspaceRoot(): string {
  return resolveWorkspaceRoot(gatherResolverInput());
}

/**
 * Resolve every directory that should be trusted as "inside the workspace"
 * for path-containment checks — the single {@link getVsCodeWorkspaceRoot} plus
 * every folder in `vscode.workspace.workspaceFolders`. Use this (not
 * `getVsCodeWorkspaceRoot` alone) anywhere a candidate path is checked against
 * "is this inside the workspace," so multi-root `.code-workspace` folders that
 * aren't descendants of the resolved `.ctrlyoke` root are still trusted.
 */
export function getVsCodeTrustedWorkspaceRoots(): string[] {
  return resolveTrustedWorkspaceRoots(gatherResolverInput());
}

/** Return the resolved state root when it needs external-root approval. */
export function getVsCodeRequestedExternalWorkspaceRoot(): string | undefined {
  return resolveRequestedExternalWorkspaceRoot(gatherResolverInput());
}

/** First open folder for services whose workspace root defines file access. */
export function getVsCodeFileAccessWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Returns true when more than one folder is open in the current VS Code
 * window (a multi-root `.code-workspace`). CLI code must never call this —
 * `CliAdapter` always represents a single root, so nothing calls it there.
 */
export function isMultiRootWorkspace(): boolean {
  return (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
}

/**
 * Every open workspace folder as a name/path pair, for folder-name-prefixed
 * relative ref resolution (`root2/src/index.ts`). Single-folder windows
 * return that one folder; no folder open returns `[]`.
 */
export function getVsCodeNamedWorkspaceRoots(): ResolverWorkspaceFolder[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
    name: folder.name,
    fsPath: folder.uri.fsPath,
  }));
}

/**
 * Return a `vscode.WorkspaceFolder` whose `uri.fsPath` is the resolved
 * workspace root, or `undefined` when no folder is open.
 *
 * When the resolved root matches a real workspace folder, that folder is
 * returned as-is. Otherwise (the root is a `.code-workspace` directory or an
 * explicit `ctrlyoke.workspaceDirectory` override that is not itself one of
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
  const match = folders.find((folder) => pathsEqual(folder.uri.fsPath, root));
  if (match) {
    return match;
  }
  return {
    uri: vscode.Uri.file(root),
    name: path.basename(root),
    index: 0,
  };
}
