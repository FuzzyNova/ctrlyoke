import * as fs from "fs/promises";
import * as path from "path";
import { getErrorMessage } from "../utils/ErrorUtils";
import {
  FINAL_STEP_PHASES,
  MESSAGE_TYPES,
  PANEL_CLIENT_ID,
  WORKTREE_DIRECTORY_STATES,
  WORKTREE_LIFECYCLE_STATES,
  WORKTREE_MODES,
  UNDO_FILE_ACTIONS,
} from "../types/DashboardConstants";
import type { WorkflowOrchestrator } from "../core/WorkflowOrchestrator";
import type { PostMessageFn } from "./WebviewSettingsSync";
import type {
  RunRef,
  WorkflowKey,
  WorkingFile,
  WorkingFileWorktreeRuntime,
} from "../types/CtrlYokeTypes";
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
import {
  getVsCodeNamedWorkspaceRoots,
  getVsCodeWorkspaceRoot,
} from "../platform/VsCodeWorkspaceRoot";
import type { ResolverWorkspaceFolder } from "../platform/WorkspaceRootResolver";
import * as WorkflowPaths from "../utils/WorkflowPaths";
import {
  currentBranch,
  gitCommonDir,
  listWorktrees,
  repoToplevel,
} from "../utils/GitUtils";
import { isPathWithinDirectory } from "../utils/PathSecurity";
import { pathsEqual } from "../utils/PathCasing";

type SnapshotEntry = {
  target: OutputExecutionTarget;
  files: UndoFileInstruction[];
};

interface UndoExecutionWorkspace {
  executionRoot: string;
  namedWorkspaceRoots: ResolverWorkspaceFolder[];
}

interface CurrentWorkspaceRoots {
  executionRoot: string;
  namedWorkspaceRoots: ResolverWorkspaceFolder[];
}

/**
 * UndoRedoCoordinator
 *
 * Handles workspace snapshot undo/redo for prompt- and workflow-level file
 * changes: restoring files via WorkspaceSnapshotService, persisting undo
 * records to output history, and notifying the webview of results.
 */
export class UndoRedoCoordinator {
  constructor(
    private readonly getOrchestrator: () => WorkflowOrchestrator | undefined,
    private readonly getCurrentWorkspaceRoots: () => CurrentWorkspaceRoots = () => ({
      executionRoot: getVsCodeWorkspaceRoot(),
      namedWorkspaceRoots: getVsCodeNamedWorkspaceRoots(),
    })
  ) {}

  async handleUndoPromptChanges(
    message: UndoPromptChangesMessage,
    postMessage: PostMessageFn,
    _clientId: string = PANEL_CLIENT_ID
  ): Promise<void> {
    const { requestId, target, files, workflowKey, runRef } = message.data;
    const authoritativeFiles = await this.loadSnapshotRestoreContents(
      target,
      files,
      workflowKey,
      runRef
    );
    const result = await this.applyUndoEntries(
      [{ target, files: authoritativeFiles }],
      workflowKey,
      runRef,
      postMessage,
      { emitUndoRecordWithoutHistory: true }
    );
    this.emitUndoPromptResult(postMessage, requestId, target, result);
  }

  async handleRedoPromptChanges(
    message: RedoPromptChangesMessage,
    postMessage: PostMessageFn,
    _clientId: string = PANEL_CLIENT_ID
  ): Promise<void> {
    const { requestId, target, files, workflowKey, runRef } = message.data;
    const result = await this.applyRedoEntries(
      [{ target, files }],
      workflowKey,
      runRef,
      postMessage
    );
    this.emitUndoPromptResult(postMessage, requestId, target, result);
  }

  async handleUndoWorkflowChanges(
    message: UndoWorkflowChangesMessage,
    postMessage: PostMessageFn,
    _clientId: string = PANEL_CLIENT_ID
  ): Promise<void> {
    const { requestId, workflowKey, runRef, entries } = message.data;
    const authoritativeEntries = await Promise.all(
      entries.map(async (entry) => ({
        ...entry,
        files: await this.loadSnapshotRestoreContents(
          entry.target,
          entry.files,
          workflowKey,
          runRef
        ),
      }))
    );
    const firstTarget = entries[0]?.target ?? {
      kind: FINAL_STEP_PHASES.QUEUE,
      stepIndex: 0,
    };
    const result = await this.applyUndoEntries(
      authoritativeEntries,
      workflowKey,
      runRef,
      postMessage,
      { emitUndoRecordWithoutHistory: false }
    );
    this.emitUndoPromptResult(postMessage, requestId, firstTarget, result);
  }

  /** Restore-content undo bodies always come from the addressed run history. */
  private async loadSnapshotRestoreContents(
    target: OutputExecutionTarget,
    files: UndoFileInstruction[],
    workflowKey: WorkflowKey,
    runRef: RunRef
  ): Promise<UndoFileInstruction[]> {
    const orchestrator = this.getOrchestrator();
    return Promise.all(
      files.map(async (file) => {
        if (file.action !== UNDO_FILE_ACTIONS.RESTORE_CONTENT) return file;
        let content:
          | Awaited<
              ReturnType<
                WorkflowOrchestrator["getWorkspaceSnapshotFileContent"]
              >
            >
          | undefined;
        try {
          content = await orchestrator?.getWorkspaceSnapshotFileContent(
            { workflowKey, runRef },
            target,
            file.path
          );
        } catch {
          content = undefined;
        }
        return {
          ...file,
          ...(content?.contentToRestore !== undefined
            ? { contentToRestore: content.contentToRestore }
            : { contentToRestore: undefined }),
        };
      })
    );
  }

  async handleRedoWorkflowChanges(
    message: RedoWorkflowChangesMessage,
    postMessage: PostMessageFn,
    _clientId: string = PANEL_CLIENT_ID
  ): Promise<void> {
    const { requestId, workflowKey, runRef, entries } = message.data;
    const firstTarget = entries[0]?.target ?? {
      kind: FINAL_STEP_PHASES.QUEUE,
      stepIndex: 0,
    };
    const result = await this.applyRedoEntries(
      entries,
      workflowKey,
      runRef,
      postMessage
    );
    this.emitUndoPromptResult(postMessage, requestId, firstTarget, result);
  }

  private async applyUndoEntries(
    entries: SnapshotEntry[],
    workflowKey: WorkflowKey,
    runRef: RunRef,
    postMessage: PostMessageFn,
    options: { emitUndoRecordWithoutHistory: boolean }
  ): Promise<UndoResult> {
    return this.applySnapshotEntries(
      entries,
      workflowKey,
      runRef,
      async (entry, result) => {
        await this.recordUndoApplied(
          entry.target,
          result,
          postMessage,
          workflowKey,
          runRef,
          options.emitUndoRecordWithoutHistory
        );
      }
    );
  }

  private async applyRedoEntries(
    entries: SnapshotEntry[],
    workflowKey: WorkflowKey,
    runRef: RunRef,
    postMessage: PostMessageFn
  ): Promise<UndoResult> {
    return this.applySnapshotEntries(
      entries,
      workflowKey,
      runRef,
      async (entry) => {
        await this.recordRedoApplied(
          entry.target,
          postMessage,
          workflowKey,
          runRef
        );
      }
    );
  }

  private async applySnapshotEntries(
    entries: SnapshotEntry[],
    workflowKey: WorkflowKey,
    runRef: RunRef,
    afterRestore: (entry: SnapshotEntry, result: UndoResult) => Promise<void>
  ): Promise<UndoResult> {
    const snapshotService = new WorkspaceSnapshotService();
    const restoredFiles: string[] = [];
    const failedFiles: Array<{ path: string; error: string }> = [];
    const redoInstructions: UndoFileInstruction[] = [];

    let workspace: UndoExecutionWorkspace;
    try {
      workspace = await this.resolveUndoExecutionWorkspace(workflowKey, runRef);
    } catch (error) {
      return {
        restoredFiles,
        failedFiles: this.createFailedUndoFiles(
          entries.flatMap((entry) => entry.files),
          `Undo refused: ${getErrorMessage(error)}`
        ),
        redoInstructions,
      };
    }

    for (const entry of entries) {
      if (entry.files.length === 0) continue;
      const filesWithContent = entry.files.filter((file) => {
        if (
          file.action !== UNDO_FILE_ACTIONS.RESTORE_CONTENT ||
          file.contentToRestore !== undefined
        ) {
          return true;
        }
        failedFiles.push({
          path: file.path,
          error: "Snapshot restore content is unavailable in run history",
        });
        return false;
      });
      if (filesWithContent.length === 0) continue;
      try {
        const result = await snapshotService.undoFiles(
          filesWithContent,
          workspace.executionRoot,
          workspace.namedWorkspaceRoots
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
          ...this.createFailedUndoFiles(filesWithContent, errorMessage)
        );
      }
    }

    return { restoredFiles, failedFiles, redoInstructions };
  }

  /** Resolve the only workspace an addressed run may write to. */
  private async resolveUndoExecutionWorkspace(
    workflowKey: WorkflowKey,
    runRef: RunRef
  ): Promise<UndoExecutionWorkspace> {
    const current = this.getCurrentWorkspaceRoots();
    const runFilePath = WorkflowPaths.runFilePath(
      current.executionRoot,
      workflowKey,
      runRef
    );
    const workingFile = JSON.parse(
      await fs.readFile(runFilePath, "utf8")
    ) as WorkingFile;
    const recordedWorktree = workingFile._runtime?.worktree;
    if (!recordedWorktree) {
      return current;
    }

    return this.validateRecordedWorktree(recordedWorktree);
  }

  private async validateRecordedWorktree(
    recorded: WorkingFileWorktreeRuntime
  ): Promise<UndoExecutionWorkspace> {
    // Settlement alone does not end undo — losing the directory does. A managed
    // run with `keep: true` settles with its checkout still present, and content
    // restore keeps working there (Settled Decision 9 disables undo on directory
    // *removal*). Keying this on `lifecycleState === "settled"` would silently
    // take undo away from the users who asked to keep the directory.
    const directoryGone =
      recorded.directoryState !== WORKTREE_DIRECTORY_STATES.PRESENT;
    if (recorded.mode === WORKTREE_MODES.MANAGED && directoryGone) {
      throw new Error(
        "the managed worktree landed as a branch; filesystem undo is unavailable once its directory is removed (Git can show the recorded diff but cannot apply this undo)"
      );
    }
    if (
      directoryGone ||
      recorded.lifecycleState === WORKTREE_LIFECYCLE_STATES.ORPHANED ||
      recorded.lifecycleState === WORKTREE_LIFECYCLE_STATES.BLOCKED
    ) {
      throw new Error("the recorded worktree is no longer an active checkout");
    }

    const [
      sourceCheckoutRoot,
      worktreePath,
      executionCheckoutRoot,
      executionRoot,
    ] = await Promise.all([
      this.realpathOrRefuse(recorded.sourceCheckoutRoot, "source checkout"),
      this.realpathOrRefuse(recorded.worktreePath, "worktree"),
      this.realpathOrRefuse(
        recorded.executionCheckoutRoot,
        "execution checkout"
      ),
      this.realpathOrRefuse(recorded.executionRoot, "execution root"),
    ]);

    if (!pathsEqual(worktreePath, executionCheckoutRoot)) {
      throw new Error("the recorded checkout identity does not match");
    }
    if (!isPathWithinDirectory(executionRoot, executionCheckoutRoot)) {
      throw new Error("the recorded execution root is outside its checkout");
    }

    const [
      sourceToplevel,
      executionToplevel,
      sourceCommonDir,
      executionCommonDir,
      branch,
      worktrees,
    ] = await Promise.all([
      repoToplevel(sourceCheckoutRoot),
      repoToplevel(executionCheckoutRoot),
      gitCommonDir(sourceCheckoutRoot),
      gitCommonDir(executionCheckoutRoot),
      currentBranch(executionCheckoutRoot),
      listWorktrees(sourceCheckoutRoot),
    ]);
    if (
      !sourceToplevel ||
      !executionToplevel ||
      !sourceCommonDir ||
      !executionCommonDir ||
      !pathsEqual(sourceToplevel, sourceCheckoutRoot) ||
      !pathsEqual(sourceCommonDir, executionCommonDir) ||
      !pathsEqual(executionToplevel, executionCheckoutRoot) ||
      branch !== recorded.branchName
    ) {
      throw new Error(
        "the recorded repository or branch identity does not match"
      );
    }

    const matchingWorktree = worktrees.find(
      (entry) =>
        pathsEqual(entry.worktreePath, executionCheckoutRoot) &&
        entry.branchName === recorded.branchName
    );
    if (!matchingWorktree) {
      throw new Error("the recorded checkout is not the registered worktree");
    }

    const namedWorkspaceRoots = await Promise.all(
      recorded.namedWorkspaceRoots.map(async (root) => {
        const fsPath = await this.realpathOrRefuse(
          root.fsPath,
          `workspace root "${root.name}"`
        );
        if (!isPathWithinDirectory(fsPath, executionCheckoutRoot)) {
          throw new Error(
            `recorded workspace root "${root.name}" is outside the checkout`
          );
        }
        return { ...root, fsPath };
      })
    );

    return { executionRoot, namedWorkspaceRoots };
  }

  private async realpathOrRefuse(
    value: string,
    label: string
  ): Promise<string> {
    if (!value || !path.isAbsolute(value)) {
      throw new Error(`recorded ${label} is invalid`);
    }
    try {
      return path.normalize(await fs.realpath(value));
    } catch {
      throw new Error(`recorded ${label} is missing`);
    }
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

  private async recordUndoApplied(
    target: OutputExecutionTarget,
    result: UndoResult,
    postMessage: PostMessageFn,
    workflowKey: WorkflowKey,
    runRef: RunRef,
    emitWithoutHistory: boolean
  ): Promise<void> {
    const undoRecord: UndoRecord = {
      appliedAt: Date.now(),
      restoredFiles: result.restoredFiles,
      redoInstructions: result.redoInstructions,
    };
    const historyFilePath = await this.resolveHistoryFilePath(
      workflowKey,
      runRef
    );
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
    workflowKey: WorkflowKey,
    runRef: RunRef
  ): Promise<void> {
    const historyFilePath = await this.resolveHistoryFilePath(
      workflowKey,
      runRef
    );
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
  private async resolveHistoryFilePath(
    workflowKey: WorkflowKey,
    runRef: RunRef
  ): Promise<string> {
    try {
      const orchestrator = this.getOrchestrator();
      if (!orchestrator) return "";
      return orchestrator
        .getOutputHistoryManager()
        .getHistoryFilePath(workflowKey, runRef);
    } catch {
      return "";
    }
  }
}
