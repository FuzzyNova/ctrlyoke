import React, { useCallback, useEffect, useState } from "react";
import { MESSAGE_TYPES } from "@/types/messages";
import { useIsMobile } from "@hooks/useMediaQuery";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { useSettingsStore } from "@store/settingsStore";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import {
  workspaceCommitLog,
  workspaceDiff,
  workspaceDiscard,
  workspaceStage,
  workspaceStatus,
  workspaceUnstage,
} from "@utils/hostedApi";
import type { SourceControlFile } from "@root/types/HostedWorkspaceViewerTypes";
import { SCM_KIND_COLOR_CLASS } from "@utils/scmStatus";
import { Button } from "../shared/Button";
import { Modal } from "../shared/Modal";
import { WorkspaceCommitArea } from "./WorkspaceCommitArea";
import { WorkspaceCommitHistoryPane } from "./WorkspaceCommitHistoryPane";
import { WorkspaceDiffPane } from "./WorkspaceDiffPane";

interface PendingDiscardAction {
  paths: string[];
  untrackedCount: number;
}

/**
 * When in detached-HEAD state, returns the branch we came from (if known) so
 * the commit-log request can keep that branch's newer commits visible.
 * Returns undefined when on a branch (default HEAD log is correct).
 */
function detachedBranchHint(): string | undefined {
  const { detached, previousBranch } = useWorkspaceViewerStore.getState();
  return detached && previousBranch ? previousBranch : undefined;
}

/** Status badge label and color class, keyed off the file's git status kind. */
function getStatusBadge(file: SourceControlFile): {
  label: string;
  colorClass: string;
} {
  const colorClass = SCM_KIND_COLOR_CLASS[file.kind];
  switch (file.kind) {
    case "added":
      return { label: "A", colorClass };
    case "deleted":
      return { label: "D", colorClass };
    case "renamed":
      return { label: "R", colorClass };
    case "untracked":
      return { label: "U", colorClass };
    default:
      return { label: "M", colorClass };
  }
}

/** Splits a workspace-relative path into its file name and containing directory. */
function splitFilePath(path: string): { name: string; dir: string } {
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash === -1) return { name: path, dir: "" };
  return { name: path.slice(lastSlash + 1), dir: path.slice(0, lastSlash) };
}

export const WorkspaceSourceControlPane: React.FC = () => {
  const vscode = useVsCodeApi();
  const sourceControlFiles = useWorkspaceViewerStore(
    (s) => s.sourceControlFiles
  );
  const selectedDiffPath = useWorkspaceViewerStore((s) => s.selectedDiffPath);
  const pendingDiff = useWorkspaceViewerStore((s) => s.pendingDiff);
  const clearPendingDiff = useWorkspaceViewerStore((s) => s.clearPendingDiff);
  const sourceControlLoading = useWorkspaceViewerStore(
    (s) => s.sourceControlLoading
  );
  const setSourceControlFiles = useWorkspaceViewerStore(
    (s) => s.setSourceControlFiles
  );
  const setSourceControlLoading = useWorkspaceViewerStore(
    (s) => s.setSourceControlLoading
  );
  const selectDiff = useWorkspaceViewerStore((s) => s.selectDiff);
  const setDiffData = useWorkspaceViewerStore((s) => s.setDiffData);
  const setDiffLoading = useWorkspaceViewerStore((s) => s.setDiffLoading);
  const mobileDiffVisible = useWorkspaceViewerStore((s) => s.mobileDiffVisible);
  const setMobileDiffVisible = useWorkspaceViewerStore(
    (s) => s.setMobileDiffVisible
  );
  const setScmError = useWorkspaceViewerStore((s) => s.setScmError);
  const confirmDeleteOperations = useSettingsStore(
    (s) => s.globalSettings.confirmDeleteOperations
  );
  const setCommitHistory = useWorkspaceViewerStore((s) => s.setCommitHistory);
  const appendCommitHistory = useWorkspaceViewerStore(
    (s) => s.appendCommitHistory
  );
  const setCommitHistoryLoading = useWorkspaceViewerStore(
    (s) => s.setCommitHistoryLoading
  );
  const commitHistory = useWorkspaceViewerStore((s) => s.commitHistory);
  const commitHistoryHasMore = useWorkspaceViewerStore(
    (s) => s.commitHistoryHasMore
  );

  const isMobile = useIsMobile();
  const [incomingCommitCount, setIncomingCommitCount] = useState(0);
  const [outgoingCommitCount, setOutgoingCommitCount] = useState(0);
  const [pendingDiscard, setPendingDiscard] =
    useState<PendingDiscardAction | null>(null);
  const [dontWarnAgain, setDontWarnAgain] = useState(false);

  const loadStatus = useCallback(async (): Promise<SourceControlFile[]> => {
    setSourceControlLoading(true);
    try {
      const result = await workspaceStatus();
      setSourceControlFiles(result.files);
      setIncomingCommitCount(result.incomingCommitCount);
      setOutgoingCommitCount(result.outgoingCommitCount);
      return result.files;
    } catch (err) {
      setScmError(String(err));
      return [];
    } finally {
      setSourceControlLoading(false);
    }
  }, [setScmError, setSourceControlFiles, setSourceControlLoading]);

  const loadHistory = useCallback(async () => {
    setCommitHistoryLoading(true);
    try {
      // While detached, keep the branch we came from visible so the commits
      // "ahead" of the checked-out point still render in the graph.
      const result = await workspaceCommitLog(0, 30, detachedBranchHint());
      setCommitHistory(
        result.commits,
        result.hasMore,
        result.currentBranch,
        result.detached
      );
    } catch {
      // silently ignore — history panel will show empty state
    } finally {
      setCommitHistoryLoading(false);
    }
  }, [setCommitHistory, setCommitHistoryLoading]);

  const loadMoreHistory = useCallback(async () => {
    if (!commitHistoryHasMore) return;
    setCommitHistoryLoading(true);
    try {
      const result = await workspaceCommitLog(
        commitHistory.length,
        30,
        detachedBranchHint()
      );
      appendCommitHistory(result.commits, result.hasMore);
    } catch {
      // silently ignore
    } finally {
      setCommitHistoryLoading(false);
    }
  }, [
    appendCommitHistory,
    commitHistory.length,
    commitHistoryHasMore,
    setCommitHistoryLoading,
  ]);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadStatus(), loadHistory()]);
  }, [loadHistory, loadStatus]);

  useEffect(() => {
    void loadStatus();
    void loadHistory();
    // Intentional: run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectFileDiff = useCallback(
    async (filePath: string) => {
      selectDiff(filePath);
      setDiffLoading(true);
      if (isMobile) setMobileDiffVisible(true);
      try {
        const result = await workspaceDiff(filePath);
        setDiffData(
          result.oldContent,
          result.newContent,
          result.language,
          result.kind
        );
      } catch (err) {
        setScmError(String(err));
      } finally {
        setDiffLoading(false);
      }
    },
    [
      isMobile,
      selectDiff,
      setDiffData,
      setDiffLoading,
      setMobileDiffVisible,
      setScmError,
    ]
  );

  // Consume a diff selection set externally (back/forward, deep-link restore)
  // by loading its content, mirroring how the explorer consumes pendingNavigation.
  useEffect(() => {
    if (!pendingDiff) return;
    clearPendingDiff();
    void selectFileDiff(pendingDiff);
  }, [pendingDiff, clearPendingDiff, selectFileDiff]);

  const refreshAfterMutation = useCallback(
    async (affectedPaths: string[]) => {
      const files = await loadStatus();
      void loadHistory();
      if (!selectedDiffPath || !affectedPaths.includes(selectedDiffPath)) {
        return;
      }

      const selectedStillExists = files.some(
        (file) => file.path === selectedDiffPath
      );
      if (!selectedStillExists) {
        if (isMobile) {
          setMobileDiffVisible(false);
        }
        return;
      }

      await selectFileDiff(selectedDiffPath);
    },
    [
      isMobile,
      loadHistory,
      loadStatus,
      selectFileDiff,
      selectedDiffPath,
      setMobileDiffVisible,
    ]
  );

  const handleStage = useCallback(
    async (filePath: string) => {
      try {
        await workspaceStage({ path: filePath });
        await loadStatus();
      } catch (err) {
        setScmError(String(err));
      }
    },
    [loadStatus, setScmError]
  );

  const handleUnstage = useCallback(
    async (filePath: string) => {
      try {
        await workspaceUnstage({ path: filePath });
        await loadStatus();
      } catch (err) {
        setScmError(String(err));
      }
    },
    [loadStatus, setScmError]
  );

  const performDiscard = useCallback(
    async (paths: string[]) => {
      try {
        for (const filePath of paths) {
          await workspaceDiscard({ path: filePath });
        }
        await refreshAfterMutation(paths);
      } catch (err) {
        setScmError(String(err));
      }
    },
    [refreshAfterMutation, setScmError]
  );

  const staged = sourceControlFiles.filter((f) => f.stagedStatus !== null);
  const changed = sourceControlFiles.filter((f) => f.unstagedStatus !== null);
  const filesEmpty =
    staged.length === 0 && changed.length === 0 && !sourceControlLoading;
  const historyEmpty = commitHistory.length === 0;

  // 50/50 flex split with empty-fill: when a region has no content, collapse
  // it to its natural height so the sibling consumes the remaining slack.
  const filesRegionClass = filesEmpty
    ? "flex-none"
    : "flex-1 basis-0 min-h-0 overflow-y-auto";
  const historyRegionClass = historyEmpty
    ? "flex-none"
    : "flex-1 basis-0 min-h-0 overflow-y-auto";

  const openDiscardWarning = useCallback(
    (paths: string[], untrackedCount: number) => {
      setDontWarnAgain(!confirmDeleteOperations);
      setPendingDiscard({ paths, untrackedCount });
    },
    [confirmDeleteOperations]
  );

  const requestDiscard = useCallback(
    (paths: string[]) => {
      const untrackedCount = sourceControlFiles.filter(
        (file) => paths.includes(file.path) && file.kind === "untracked"
      ).length;

      if (untrackedCount > 0 && confirmDeleteOperations) {
        openDiscardWarning(paths, untrackedCount);
        return;
      }

      void performDiscard(paths);
    },
    [
      confirmDeleteOperations,
      openDiscardWarning,
      performDiscard,
      sourceControlFiles,
    ]
  );

  const handleStageAll = useCallback(async () => {
    try {
      for (const file of changed) {
        await workspaceStage({ path: file.path });
      }
      await loadStatus();
    } catch (err) {
      setScmError(String(err));
    }
  }, [changed, loadStatus, setScmError]);

  const handleDiscardAll = useCallback(() => {
    requestDiscard(changed.map((file) => file.path));
  }, [changed, requestDiscard]);

  const handleUnstageAll = useCallback(async () => {
    try {
      for (const file of staged) {
        await workspaceUnstage({ path: file.path });
      }
      await loadStatus();
    } catch (err) {
      setScmError(String(err));
    }
  }, [loadStatus, setScmError, staged]);

  const handleDiscardCheckboxChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const checked = e.target.checked;
      setDontWarnAgain(checked);
      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_CONFIRM_DELETE,
        value: !checked,
      });
    },
    [vscode]
  );

  const handleConfirmDiscard = useCallback(() => {
    const action = pendingDiscard;
    setPendingDiscard(null);
    if (action) {
      void performDiscard(action.paths);
    }
  }, [pendingDiscard, performDiscard]);

  const discardMessage =
    pendingDiscard?.untrackedCount === 1
      ? "Discarding will delete this untracked file from disk."
      : `Discarding will delete ${pendingDiscard?.untrackedCount ?? 0} untracked files from disk.`;
  const discardDetail =
    pendingDiscard &&
    pendingDiscard.paths.length > pendingDiscard.untrackedCount
      ? "Tracked files in the same discard action will be restored to their Git state."
      : undefined;

  const renderFileRow = (file: SourceControlFile, isStaged: boolean) => {
    const { label: badge, colorClass: badgeColorClass } = getStatusBadge(file);
    const isSelected = selectedDiffPath === file.path;
    const { name, dir } = splitFilePath(file.path);

    return (
      <div
        key={`${isStaged ? "staged" : "changed"}-${file.path}`}
        className={`fp-list-row flex items-center gap-1 px-2 py-1 transition-colors ${
          isSelected
            ? "fp-list-row-selected bg-list-active-bg"
            : "hover:bg-list-hover-bg"
        }`}
      >
        <button
          onClick={() => selectFileDiff(file.path)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-left text-sm text-editor-fg"
          title={file.path}
        >
          <span
            className={`flex-shrink-0 text-xs font-mono font-bold ${badgeColorClass}`}
          >
            {badge}
          </span>
          <span className="min-w-0 flex-1 flex flex-col">
            <span className="truncate text-xs">{name}</span>
            {dir && <span className="truncate text-xxs opacity-50">{dir}</span>}
          </span>
        </button>

        <div className="flex items-center">
          {!isStaged && (
            <button
              onClick={() => requestDiscard([file.path])}
              className="codicon codicon-discard flex min-h-[44px] min-w-[44px] flex-shrink-0 items-center justify-center p-1 text-xs opacity-60 hover:opacity-100 sm:min-h-0 sm:min-w-0"
              title="Discard changes"
              aria-label="Discard changes"
            />
          )}

          {isStaged ? (
            <button
              onClick={() => handleUnstage(file.path)}
              className="codicon codicon-dash flex min-h-[44px] min-w-[44px] flex-shrink-0 items-center justify-center p-1 text-xs opacity-60 hover:opacity-100 sm:min-h-0 sm:min-w-0"
              title="Unstage"
              aria-label="Unstage"
            />
          ) : (
            <button
              onClick={() => handleStage(file.path)}
              className="codicon codicon-plus flex min-h-[44px] min-w-[44px] flex-shrink-0 items-center justify-center p-1 text-xs opacity-60 hover:opacity-100 sm:min-h-0 sm:min-w-0"
              title="Stage"
              aria-label="Stage"
            />
          )}
        </div>
      </div>
    );
  };

  const sourceControlSections = (
    <>
      <div>
        <div className="flex items-center justify-between px-3 py-1.5">
          <span className="text-xs font-semibold uppercase text-editor-fg opacity-60">
            Staged ({staged.length})
          </span>
          {staged.length > 0 && (
            <button
              onClick={handleUnstageAll}
              className="text-xs text-btn-fg hover:underline"
            >
              Unstage All
            </button>
          )}
        </div>
        {staged.length === 0 ? (
          <p className="px-3 pb-2 text-xs text-editor-fg opacity-40 select-none">
            No staged files
          </p>
        ) : (
          <div>{staged.map((file) => renderFileRow(file, true))}</div>
        )}
      </div>

      <div className="border-t border-panel-border" />

      <div>
        <div className="flex items-center justify-between px-3 py-1.5">
          <span className="text-xs font-semibold uppercase text-editor-fg opacity-60">
            Changes ({changed.length})
          </span>
          {changed.length > 0 && (
            <div className="flex items-center gap-3">
              <button
                onClick={handleDiscardAll}
                className="inline-flex items-center gap-1 text-xs text-btn-fg hover:underline"
              >
                <i className="codicon codicon-discard text-xs" />
                <span>Discard All</span>
              </button>
              <button
                onClick={handleStageAll}
                className="text-xs text-btn-fg hover:underline"
              >
                Stage All
              </button>
            </div>
          )}
        </div>
        {changed.length === 0 ? (
          <p className="px-3 pb-2 text-xs text-editor-fg opacity-40 select-none">
            No changes
          </p>
        ) : (
          <div>{changed.map((file) => renderFileRow(file, false))}</div>
        )}
      </div>
    </>
  );

  const leftColumn = (
    <div className="w-64 flex-shrink-0 flex flex-col border-r border-panel-border overflow-hidden h-full">
      <WorkspaceCommitArea
        incomingCommitCount={incomingCommitCount}
        onRefresh={refreshAll}
        outgoingCommitCount={outgoingCommitCount}
      />
      <div className="border-t border-panel-border flex-shrink-0" />

      {/* Files region — independently scrollable */}
      <div className={filesRegionClass}>
        {sourceControlLoading ? (
          <div className="flex items-center justify-center py-6 text-editor-fg opacity-50 gap-2">
            <i className="codicon codicon-loading animate-spin text-sm" />
            <span className="text-xs">Refreshing…</span>
          </div>
        ) : (
          sourceControlSections
        )}
      </div>

      <div className="border-t border-panel-border flex-shrink-0" />

      {/* Commit history region — independently scrollable */}
      <div className={historyRegionClass}>
        <WorkspaceCommitHistoryPane
          onLoadMore={() => void loadMoreHistory()}
          onRefresh={() => void refreshAll()}
        />
      </div>
    </div>
  );

  if (isMobile && mobileDiffVisible) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-panel-border flex-shrink-0">
          <button
            onClick={() => setMobileDiffVisible(false)}
            className="flex items-center gap-1 text-editor-fg hover:opacity-80 transition-opacity"
          >
            <i className="codicon codicon-arrow-left text-sm" />
            <span className="text-sm">Back</span>
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          <WorkspaceDiffPane />
        </div>
      </div>
    );
  }

  if (isMobile) {
    return (
      <>
        <div className="flex flex-col h-full overflow-hidden">
          <div className="flex-1 overflow-y-auto flex flex-col">
            <WorkspaceCommitArea
              incomingCommitCount={incomingCommitCount}
              onRefresh={refreshAll}
              outgoingCommitCount={outgoingCommitCount}
            />
            <div className="border-t border-panel-border" />

            {sourceControlLoading ? (
              <div className="flex items-center justify-center py-6 text-editor-fg opacity-50 gap-2">
                <i className="codicon codicon-loading animate-spin text-sm" />
                <span className="text-xs">Refreshing…</span>
              </div>
            ) : (
              sourceControlSections
            )}

            <div className="border-t border-panel-border" />
            <WorkspaceCommitHistoryPane
              onLoadMore={() => void loadMoreHistory()}
              onRefresh={() => void refreshAll()}
            />
          </div>
        </div>

        <Modal
          isOpen={pendingDiscard !== null}
          onClose={() => setPendingDiscard(null)}
          elevated
          title={
            pendingDiscard?.untrackedCount === 1
              ? "Delete Untracked File?"
              : "Delete Untracked Files?"
          }
          size="sm"
          footer={
            <>
              <Button
                variant="secondary"
                size="md"
                onClick={() => setPendingDiscard(null)}
              >
                Cancel
              </Button>
              <Button variant="danger" size="md" onClick={handleConfirmDiscard}>
                Discard
              </Button>
            </>
          }
        >
          <p className="text-foreground">{discardMessage}</p>
          {discardDetail && (
            <p className="mt-2 text-sm text-description-fg">{discardDetail}</p>
          )}
          <label
            htmlFor="discard-untracked-dont-warn-mobile"
            className="mt-4 flex cursor-pointer items-center gap-2 select-none text-sm text-description-fg transition-colors hover:text-foreground"
          >
            <input
              id="discard-untracked-dont-warn-mobile"
              type="checkbox"
              checked={dontWarnAgain}
              onChange={handleDiscardCheckboxChange}
              aria-label="Don't warn me again before deleting untracked files"
              className="h-3.5 w-3.5 cursor-pointer accent-button-bg"
            />
            Don't warn me again
          </label>
        </Modal>
      </>
    );
  }

  return (
    <>
      <div className="flex h-full overflow-hidden">
        {leftColumn}
        <div className="flex-1 overflow-hidden">
          <WorkspaceDiffPane />
        </div>
      </div>

      <Modal
        isOpen={pendingDiscard !== null}
        onClose={() => setPendingDiscard(null)}
        elevated
        title={
          pendingDiscard?.untrackedCount === 1
            ? "Delete Untracked File?"
            : "Delete Untracked Files?"
        }
        size="sm"
        footer={
          <>
            <Button
              variant="secondary"
              size="md"
              onClick={() => setPendingDiscard(null)}
            >
              Cancel
            </Button>
            <Button variant="danger" size="md" onClick={handleConfirmDiscard}>
              Discard
            </Button>
          </>
        }
      >
        <p className="text-foreground">{discardMessage}</p>
        {discardDetail && (
          <p className="mt-2 text-sm text-description-fg">{discardDetail}</p>
        )}
        <label
          htmlFor="discard-untracked-dont-warn"
          className="mt-4 flex cursor-pointer items-center gap-2 select-none text-sm text-description-fg transition-colors hover:text-foreground"
        >
          <input
            id="discard-untracked-dont-warn"
            type="checkbox"
            checked={dontWarnAgain}
            onChange={handleDiscardCheckboxChange}
            aria-label="Don't warn me again before deleting untracked files"
            className="h-3.5 w-3.5 cursor-pointer accent-button-bg"
          />
          Don't warn me again
        </label>
      </Modal>
    </>
  );
};
