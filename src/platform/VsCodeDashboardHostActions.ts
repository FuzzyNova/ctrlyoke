import * as vscode from "vscode";
import * as path from "path";
import type {
  ActionResult,
  DashboardHostActions,
  ContentPreview,
  GitDiffRequest,
  PathSelectionRequest,
  WorkspaceOpenTarget,
} from "../core/HostPorts";
import { openResolvedTarget } from "../ui/ExternalFileTrustPrompt";
import {
  DASHBOARD_ACTION_RESULT_STATUSES,
  PATH_SELECTION_KINDS,
  PATH_SELECTION_TITLES,
  VSCODE_COMMANDS,
} from "../types/DashboardConstants";
import { findWorkflowFilesInWorkspace } from "../utils/WorkflowFileDiscovery";
import { getVsCodeWorkspaceRoot } from "./VsCodeWorkspaceRoot";

/** VS Code implementations of the dashboard's host-native actions. */
export class VsCodeDashboardHostActions implements DashboardHostActions {
  async openWorkspaceTarget(
    target: WorkspaceOpenTarget
  ): Promise<ActionResult> {
    try {
      await openResolvedTarget(target);
      return { status: DASHBOARD_ACTION_RESULT_STATUSES.OPENED };
    } catch (error) {
      return {
        status: DASHBOARD_ACTION_RESULT_STATUSES.FAILED,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  focusDashboard(): void {
    void vscode.commands.executeCommand("ctrlyoke.dashboard.focus");
  }

  async openContentPreview(content: ContentPreview): Promise<ActionResult> {
    try {
      const document = await vscode.workspace.openTextDocument(content);
      await vscode.window.showTextDocument(document, { preview: true });
      return { status: DASHBOARD_ACTION_RESULT_STATUSES.OPENED };
    } catch (error) {
      return this.failed(error);
    }
  }

  async selectWorkspacePath(
    request: PathSelectionRequest
  ): Promise<string | undefined> {
    if (
      request.title === PATH_SELECTION_TITLES.LOAD_WORKFLOW ||
      request.title === PATH_SELECTION_TITLES.APPEND_WORKFLOW
    ) {
      if (!vscode.workspace.workspaceFolders?.length) {
        await vscode.commands.executeCommand(
          VSCODE_COMMANDS.SELECT_PROMPT_FILE
        );
        return undefined;
      }
      const files = findWorkflowFilesInWorkspace(getVsCodeWorkspaceRoot());
      if (files.length === 0) {
        await vscode.commands.executeCommand(
          VSCODE_COMMANDS.SELECT_PROMPT_FILE
        );
        return undefined;
      }
      const selected = await vscode.window.showQuickPick(
        files.map((file) => ({
          label: file.relativePath,
          filePath: file.path,
        })),
        { placeHolder: request.title }
      );
      return selected?.filePath;
    }
    const pickerOptions = {
      title: request.title,
      filters: request.fileExtensions?.length
        ? {
            "ctrlyoke License": request.fileExtensions.filter(
              (extension) => extension !== "*"
            ),
            ...(request.fileExtensions.includes("*")
              ? { "All Files": ["*"] }
              : {}),
          }
        : undefined,
    };
    if (request.kind === PATH_SELECTION_KINDS.SAVE) {
      const selected = await vscode.window.showSaveDialog({
        ...pickerOptions,
        saveLabel: request.openLabel,
      });
      return selected?.fsPath;
    }
    const selected = await vscode.window.showOpenDialog({
      ...pickerOptions,
      canSelectFiles: request.kind === PATH_SELECTION_KINDS.FILE,
      canSelectFolders: request.kind === PATH_SELECTION_KINDS.FOLDER,
      canSelectMany: false,
      openLabel: request.openLabel,
    });
    return selected?.[0]?.fsPath;
  }

  async revealOutput(): Promise<void> {
    await vscode.commands.executeCommand("ctrlyoke.showOutputPanel");
  }

  async openFolderWindow(absolutePath: string): Promise<ActionResult> {
    if (!path.isAbsolute(absolutePath)) {
      return this.failed(new Error("The recorded folder path is unavailable."));
    }
    try {
      await vscode.commands.executeCommand(
        "vscode.openFolder",
        vscode.Uri.file(absolutePath),
        true
      );
      return { status: DASHBOARD_ACTION_RESULT_STATUSES.OPENED };
    } catch (error) {
      return this.failed(error);
    }
  }

  async openGitDiff(request: GitDiffRequest): Promise<ActionResult> {
    try {
      const command =
        request.kind === "worktree"
          ? VSCODE_COMMANDS.VIEW_WORKTREE_DIFF
          : "ctrlyoke.openGitChange";
      await vscode.commands.executeCommand(
        command,
        request.kind === "worktree"
          ? {
              sourceCheckoutRoot: request.sourceCheckoutRoot,
              baseCommit: request.baseCommit,
              branchName: request.branchName,
            }
          : { workspaceRoot: request.workspaceRoot, ref: request.ref }
      );
      return { status: DASHBOARD_ACTION_RESULT_STATUSES.OPENED };
    } catch (error) {
      return this.failed(error);
    }
  }

  async revealInOs(absolutePath: string): Promise<ActionResult> {
    try {
      await vscode.commands.executeCommand(
        "revealFileInOS",
        vscode.Uri.file(absolutePath)
      );
      return { status: DASHBOARD_ACTION_RESULT_STATUSES.OPENED };
    } catch (error) {
      return this.failed(error);
    }
  }

  async browseMcpGallery(): Promise<void> {
    await vscode.commands.executeCommand("workbench.mcp.browseServers");
  }

  async reloadHost(): Promise<void> {
    await vscode.commands.executeCommand(VSCODE_COMMANDS.RELOAD_WINDOW);
  }

  private failed(error: unknown): ActionResult {
    return {
      status: DASHBOARD_ACTION_RESULT_STATUSES.FAILED,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
