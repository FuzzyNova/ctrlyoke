import * as vscode from "vscode";
import * as fs from "fs";
import { getErrorMessage } from "../utils/ErrorUtils";
import {
  MESSAGE_TYPES,
  type HarnessFileType,
} from "../types/DashboardConstants";
import { HarnessFileManager } from "../utils/HarnessFileManager";
import type {
  ManagedFile,
  ManagedTargetDirectory,
  RequestHarnessFilesMessage,
  ExportToHarnessMessage,
  ImportToCtrlYokeMessage,
  DeleteFromHarnessMessage,
  SyncAllToHarnessMessage,
  DeleteAllFromHarnessMessage,
  OpenHarnessDirMessage,
} from "../types/WebviewMessageTypes";
import type { WebviewClientContext } from "./WebviewClientContext";

/**
 * Agent/skill file-manager message handlers (the dashboard's "Agents & Skills"
 * settings section): enumerate every on-disk location, copy files into or out of
 * a harness directory, and reveal a target directory in the OS file explorer.
 *
 * These handlers need nothing from `WebviewMessageRouter` beyond the workspace
 * root and "which client am I" (supplied per call as a
 * {@link WebviewClientContext}). The dispatch table itself stays in the router;
 * entries there are thin delegations to this service.
 */
export class HarnessFileMessageService {
  constructor(private readonly getWorkspaceRoot: () => string) {}

  /**
   * Every mutating file op shares one shape: run the op, then re-enumerate and
   * hand the client a fresh view of the world. `targetDirectories` is a pure
   * function of (workspaceRoot, fileType) rather than of what is on disk, but it
   * ships alongside `files` on every success so a client that somehow missed the
   * initial `HARNESS_FILES_RESULT` still gets one.
   */
  private async runFileOp(
    ctx: WebviewClientContext,
    fileType: HarnessFileType,
    op: (workspaceRoot: string) => Promise<void>
  ): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();
    try {
      await op(workspaceRoot);
      ctx.emit({
        type: MESSAGE_TYPES.HARNESS_FILE_OP_RESULT,
        success: true,
        ...(await this.resolveFileView(workspaceRoot, fileType)),
      });
    } catch (error) {
      ctx.emit({
        type: MESSAGE_TYPES.HARNESS_FILE_OP_RESULT,
        success: false,
        error: getErrorMessage(error),
      });
    }
  }

  private async resolveFileView(
    workspaceRoot: string,
    fileType: HarnessFileType
  ): Promise<{
    files: ManagedFile[];
    targetDirectories: ManagedTargetDirectory[];
  }> {
    return {
      files: await HarnessFileManager.resolveAllLocations(
        workspaceRoot,
        fileType
      ),
      targetDirectories: HarnessFileManager.resolveTargetDirectories(
        workspaceRoot,
        fileType
      ),
    };
  }

  async handleRequestHarnessFiles(
    ctx: WebviewClientContext,
    message: RequestHarnessFilesMessage
  ): Promise<void> {
    ctx.emit({
      type: MESSAGE_TYPES.HARNESS_FILES_RESULT,
      ...(await this.resolveFileView(
        this.getWorkspaceRoot(),
        message.fileType
      )),
    });
  }

  async handleExportToHarness(
    ctx: WebviewClientContext,
    message: ExportToHarnessMessage
  ): Promise<void> {
    await this.runFileOp(ctx, message.fileType, (workspaceRoot) =>
      HarnessFileManager.exportToHarness(
        message.sourcePath,
        message.harnessId,
        workspaceRoot,
        message.fileType,
        message.overwrite ?? false,
        message.scope ?? "workspace"
      )
    );
  }

  async handleImportToCtrlYoke(
    ctx: WebviewClientContext,
    message: ImportToCtrlYokeMessage
  ): Promise<void> {
    await this.runFileOp(ctx, message.fileType, (workspaceRoot) =>
      HarnessFileManager.importToCtrlYoke(
        message.sourcePath,
        workspaceRoot,
        message.fileType,
        message.overwrite ?? false
      )
    );
  }

  async handleDeleteFromHarness(
    ctx: WebviewClientContext,
    message: DeleteFromHarnessMessage
  ): Promise<void> {
    await this.runFileOp(ctx, message.fileType, (workspaceRoot) =>
      HarnessFileManager.deleteFromHarness(
        message.name,
        message.harnessId,
        workspaceRoot,
        message.fileType,
        message.scope ?? "workspace"
      )
    );
  }

  async handleSyncAllToHarness(
    ctx: WebviewClientContext,
    message: SyncAllToHarnessMessage
  ): Promise<void> {
    await this.runFileOp(ctx, message.fileType, async (workspaceRoot) => {
      for (const { sourcePath } of message.files ?? []) {
        await HarnessFileManager.exportToHarness(
          sourcePath,
          message.targetHarnessId,
          workspaceRoot,
          message.fileType,
          true,
          message.scope ?? "workspace"
        );
      }
    });
  }

  async handleDeleteAllFromHarness(
    ctx: WebviewClientContext,
    message: DeleteAllFromHarnessMessage
  ): Promise<void> {
    await this.runFileOp(ctx, message.fileType, (workspaceRoot) =>
      HarnessFileManager.deleteAllFromHarness(
        message.harnessId,
        workspaceRoot,
        message.fileType,
        message.scope ?? "workspace"
      )
    );
  }

  async handleOpenHarnessDir(
    ctx: WebviewClientContext,
    message: OpenHarnessDirMessage
  ): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();
    try {
      const dirPath = HarnessFileManager.getTargetDir(
        message.harnessId,
        workspaceRoot,
        message.fileType,
        message.scope ?? "workspace"
      );
      if (!fs.existsSync(dirPath)) {
        throw new Error(
          `The ${message.scope ?? "workspace"} ${message.fileType} folder does not exist yet: ${dirPath}`
        );
      }

      await vscode.commands.executeCommand(
        "revealFileInOS",
        vscode.Uri.file(dirPath)
      );
      ctx.emit({
        type: MESSAGE_TYPES.OPEN_HARNESS_DIR_RESULT,
        success: true,
      });
    } catch (error) {
      ctx.emit({
        type: MESSAGE_TYPES.OPEN_HARNESS_DIR_RESULT,
        success: false,
        error: getErrorMessage(error),
      });
    }
  }
}
