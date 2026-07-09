import * as vscode from "vscode";
import { getErrorMessage } from "../utils/ErrorUtils";
import {
  FINAL_STEP_PHASES,
  MESSAGE_TYPES,
  PANEL_CLIENT_ID,
} from "../types/DashboardConstants";
import { OutputHistoryManager } from "../core/orchestration/OutputHistoryManager";
import type { WorkflowOrchestrator } from "../core/WorkflowOrchestrator";
import type { PostMessageFn } from "./WebviewSettingsSync";
import type {
  UndoFileInstruction,
  UndoPromptChangesMessage,
  RedoPromptChangesMessage,
  UndoWorkflowChangesMessage,
  RedoWorkflowChangesMessage,
  UndoRecord,
  UndoResult,
} from "../types/WebviewMessageTypes";
import type { OutputExecutionTarget } from "../types/OutputHistoryTypes";
import { WorkspaceSnapshotService } from "../utils/WorkspaceSnapshotService";
import { getVsCodeNamedWorkspaceRoots } from "../platform/VsCodeWorkspaceRoot";

type SnapshotEntry = {
  target: OutputExecutionTarget;
  files: UndoFileInstruction[];
};

/**
 * UndoRedoCoordinator
 *
 * Handles workspace snapshot undo/redo for prompt- and workflow-level file
 * changes: restoring files via WorkspaceSnapshotService, persisting undo
 * records to output history, and notifying the webview of results.
 */
export class UndoRedoCoordinator {
  constructor(
    private readonly getOrchestrator: () => WorkflowOrchestrator | undefined
  ) {}

  async handleUndoPromptChanges(
    message: UndoPromptChangesMessage,
    postMessage: PostMessageFn,
    clientId: string = PANEL_CLIENT_ID
  ): Promise<void> {
    const { requestId, target, files, workspacePath } = message.data;
    const result = await this.applyUndoEntries(
      [{ target, files }],
      workspacePath,
      postMessage,
      clientId,
      { emitUndoRecordWithoutHistory: true }
    );
    this.emitUndoPromptResult(postMessage, requestId, target, result);
    this.showUndoRestoreStatus(result);
  }

  async handleRedoPromptChanges(
    message: RedoPromptChangesMessage,
    postMessage: PostMessageFn,
    clientId: string = PANEL_CLIENT_ID
  ): Promise<void> {
    const { requestId, target, files, workspacePath } = message.data;
    const result = await this.applyRedoEntries(
      [{ target, files }],
      workspacePath,
      postMessage,
      clientId
    );
    this.emitUndoPromptResult(postMessage, requestId, target, result);
    this.showRedoRestoreStatus(result);
  }

  async handleUndoWorkflowChanges(
    message: UndoWorkflowChangesMessage,
    postMessage: PostMessageFn,
    clientId: string = PANEL_CLIENT_ID
  ): Promise<void> {
    const { requestId, workspacePath, entries } = message.data;
    const firstTarget = entries[0]?.target ?? {
      kind: FINAL_STEP_PHASES.QUEUE,
      stepIndex: 0,
    };
    const result = await this.applyUndoEntries(
      entries,
      workspacePath,
      postMessage,
      clientId,
      { emitUndoRecordWithoutHistory: false }
    );
    this.emitUndoPromptResult(postMessage, requestId, firstTarget, result);
    this.showUndoRestoreStatus(result);
  }

  async handleRedoWorkflowChanges(
    message: RedoWorkflowChangesMessage,
    postMessage: PostMessageFn,
    clientId: string = PANEL_CLIENT_ID
  ): Promise<void> {
    const { requestId, workspacePath, entries } = message.data;
    const firstTarget = entries[0]?.target ?? {
      kind: FINAL_STEP_PHASES.QUEUE,
      stepIndex: 0,
    };
    const result = await this.applyRedoEntries(
      entries,
      workspacePath,
      postMessage,
      clientId
    );
    this.emitUndoPromptResult(postMessage, requestId, firstTarget, result);
    this.showRedoRestoreStatus(result);
  }

  private async applyUndoEntries(
    entries: SnapshotEntry[],
    workspacePath: string,
    postMessage: PostMessageFn,
    clientId: string,
    options: { emitUndoRecordWithoutHistory: boolean }
  ): Promise<UndoResult> {
    return this.applySnapshotEntries(
      entries,
      workspacePath,
      async (entry, result) => {
        await this.recordUndoApplied(
          entry.target,
          result,
          postMessage,
          clientId,
          options.emitUndoRecordWithoutHistory
        );
      }
    );
  }

  private async applyRedoEntries(
    entries: SnapshotEntry[],
    workspacePath: string,
    postMessage: PostMessageFn,
    clientId: string
  ): Promise<UndoResult> {
    return this.applySnapshotEntries(entries, workspacePath, async (entry) => {
      await this.recordRedoApplied(entry.target, postMessage, clientId);
    });
  }

  private async applySnapshotEntries(
    entries: SnapshotEntry[],
    workspacePath: string,
    afterRestore: (entry: SnapshotEntry, result: UndoResult) => Promise<void>
  ): Promise<UndoResult> {
    const snapshotService = new WorkspaceSnapshotService();
    // Named roots let undo resolve folder-name-prefixed paths (multi-root) back
    // to the correct repo; empty in single-root, where resolution is unchanged.
    const namedRoots = getVsCodeNamedWorkspaceRoots();
    const restoredFiles: string[] = [];
    const failedFiles: Array<{ path: string; error: string }> = [];
    const redoInstructions: UndoFileInstruction[] = [];

    for (const entry of entries) {
      if (entry.files.length === 0) continue;
      try {
        const result = await snapshotService.undoFiles(
          entry.files,
          workspacePath,
          namedRoots
        );
        restoredFiles.push(...result.restoredFiles);
        failedFiles.push(...result.failedFiles);
        redoInstructions.push(...result.redoInstructions);
        if (result.restoredFiles.length > 0) {
          await afterRestore(entry, result);
        }
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        failedFiles.push(
          ...this.createFailedUndoFiles(entry.files, errorMessage)
        );
      }
    }

    return { restoredFiles, failedFiles, redoInstructions };
  }

  private createFailedUndoFiles(
    files: UndoFileInstruction[],
    error: string
  ): Array<{ path: string; error: string }> {
    return files.map((file) => ({ path: file.path, error }));
  }

  private emitUndoPromptResult(
    postMessage: PostMessageFn,
    requestId: string,
    target: OutputExecutionTarget,
    result: Pick<UndoResult, "restoredFiles" | "failedFiles">
  ): void {
    postMessage({
      type: MESSAGE_TYPES.UNDO_PROMPT_RESULT,
      data: {
        requestId,
        target,
        restoredFiles: result.restoredFiles,
        failedFiles: result.failedFiles,
      },
    });
  }

  private showUndoRestoreStatus(
    result: Pick<UndoResult, "restoredFiles" | "failedFiles">
  ): void {
    if (result.failedFiles.length === 0 && result.restoredFiles.length > 0) {
      vscode.window.showInformationMessage(
        `Undo complete: restored ${result.restoredFiles.length} file${result.restoredFiles.length !== 1 ? "s" : ""}.`
      );
    } else if (result.restoredFiles.length > 0) {
      vscode.window.showWarningMessage(
        `Undo partially complete: ${result.restoredFiles.length} restored, ${result.failedFiles.length} failed.`
      );
    } else if (result.failedFiles.length > 0) {
      vscode.window.showErrorMessage(
        `Undo failed: ${result.failedFiles[0]?.error ?? "unknown error"}`
      );
    }
  }

  private showRedoRestoreStatus(
    result: Pick<UndoResult, "restoredFiles" | "failedFiles">
  ): void {
    if (result.restoredFiles.length > 0) {
      vscode.window.showInformationMessage(
        `Redo complete: re-applied ${result.restoredFiles.length} file change${result.restoredFiles.length !== 1 ? "s" : ""}.`
      );
    } else {
      vscode.window.showErrorMessage(
        `Redo failed: ${result.failedFiles[0]?.error ?? "unknown error"}`
      );
    }
  }

  private async recordUndoApplied(
    target: OutputExecutionTarget,
    result: UndoResult,
    postMessage: PostMessageFn,
    clientId: string,
    emitWithoutHistory: boolean
  ): Promise<void> {
    const undoRecord: UndoRecord = {
      appliedAt: Date.now(),
      restoredFiles: result.restoredFiles,
      redoInstructions: result.redoInstructions,
    };
    const historyFilePath = await this.resolveHistoryFilePath(clientId);
    const outputHistoryManager =
      this.getOrchestrator()?.getOutputHistoryManager();
    if (historyFilePath && outputHistoryManager) {
      await outputHistoryManager.saveUndoRecord(
        historyFilePath,
        target,
        undoRecord
      );
      this.emitUndoRecordUpdated(postMessage, target, undoRecord);
      return;
    }

    if (emitWithoutHistory) {
      this.emitUndoRecordUpdated(postMessage, target, undoRecord);
    }
  }

  private async recordRedoApplied(
    target: OutputExecutionTarget,
    postMessage: PostMessageFn,
    clientId: string
  ): Promise<void> {
    const historyFilePath = await this.resolveHistoryFilePath(clientId);
    const outputHistoryManager =
      this.getOrchestrator()?.getOutputHistoryManager();
    if (!historyFilePath || !outputHistoryManager) {
      return;
    }

    const redoneAt = Date.now();
    await outputHistoryManager.markUndoRecordRedone(
      historyFilePath,
      target,
      redoneAt
    );
    const history = await outputHistoryManager.loadHistory(historyFilePath);
    const stepOutput = (
      target.kind === FINAL_STEP_PHASES.QUEUE
        ? history.promptOutputs[target.stepIndex]
        : history.finalStepOutputs?.[target.loopIndex]
    ) as { undoRecord?: UndoRecord } | undefined;
    if (stepOutput?.undoRecord) {
      this.emitUndoRecordUpdated(postMessage, target, stepOutput.undoRecord);
    }
  }

  private emitUndoRecordUpdated(
    postMessage: PostMessageFn,
    target: OutputExecutionTarget,
    undoRecord: UndoRecord
  ): void {
    postMessage({
      type: MESSAGE_TYPES.UNDO_RECORD_UPDATED,
      target,
      undoRecord,
    });
  }

  /**
   * Resolve the current history file path for the active workflow.
   * Returns empty string if unavailable.
   */
  private async resolveHistoryFilePath(clientId: string): Promise<string> {
    try {
      const orchestrator = this.getOrchestrator();
      if (!orchestrator) return "";
      const outputHistoryManager = orchestrator.getOutputHistoryManager();
      const workingFilePath =
        orchestrator.getQueueState(clientId).workingFilePath ?? "";
      if (!workingFilePath) return "";
      const workflowId =
        OutputHistoryManager.extractWorkflowId(workingFilePath);
      return await outputHistoryManager.getLatestHistoryFilePath(workflowId);
    } catch {
      return "";
    }
  }
}
