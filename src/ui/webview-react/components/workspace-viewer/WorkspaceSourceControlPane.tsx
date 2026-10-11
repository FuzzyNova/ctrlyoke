import React, { useCallback, useEffect, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { MESSAGE_TYPES } from "@/types/messages";
import {
  SEPARATOR_VERTICAL,
  WORKSPACE_VIEWER_SIDE_PANEL_DEFAULT_SIZE,
  WORKSPACE_VIEWER_SIDE_PANEL_MAX_SIZE,
  WORKSPACE_VIEWER_SIDE_PANEL_MIN_SIZE,
} from "@/constants";
import { useIsMobile } from "@hooks/useMediaQuery";
import { usePagedCommitHistory } from "@hooks/usePagedCommitHistory";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { useSettingsStore } from "@store/settingsStore";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import {
  workspaceDiff,
  workspaceDiscard,
  workspaceRepos,
  workspaceStage,
  workspaceStatus,
  workspaceUnstage,
} from "@utils/hostedApi";
import type { SourceControlFile } from "@root/types/HostedWorkspaceViewerTypes";
import { SCM_KIND_COLOR_CLASS } from "@utils/scmStatus";
import { SCM_FILE_KINDS } from "@root/types/DashboardConstants";
import { DeleteConfirmationModal } from "../shared/DeleteConfirmationModal";
import { WorkspaceCommitArea } from "./WorkspaceCommitArea";
import { WorkspaceCommitHistoryPane } from "./WorkspaceCommitHistoryPane";
import { WorkspaceDiffPane } from "./WorkspaceDiffPane";
import { Icon } from "../shared/Icon";

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
    case SCM_FILE_KINDS.ADDED:
      return { label: "A", colorClass };
    case SCM_FILE_KINDS.DELETED:
      return { label: "D", colorClass };
    case SCM_FILE_KINDS.RENAMED:
      return { label: "R", colorClass };
    case SCM_FILE_KINDS.UNTRACKED:
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
  const pendingFileHistory = useWorkspaceViewerStore(
    (s) => s.pendingFileHistory
  );
  const clearPendingFileHistory = useWorkspaceViewerStore(
    (s) => s.clearPendingFileHistory
  );
  const fileHistoryActive = useWorkspaceViewerStore((s) => s.fileHistoryActive);
  const closeFileHistoryView = useWorkspaceViewerStore(
    (s) => s.closeFileHistoryView
  );
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
  const setCurrentBranch = useWorkspaceViewerStore((s) => s.setCurrentBranch);
  const setDetached = useWorkspaceViewerStore((s) => s.setDetached);
  const detached = useWorkspaceViewerStore((s) => s.detached);
  const previousBranch = useWorkspaceViewerStore((s) => s.previousBranch);
  const confirmDeleteOperations = useSettingsStore(
    (s) => s.globalSettings.confirmDeleteOperations
  );
  const selectedRepoId = useWorkspaceViewerStore((s) => s.selectedRepoId);
  const setRepos = useWorkspaceViewerStore((s) => s.setRepos);

  const isMobile = useIsMobile();
  const [incomingCommitCount, setIncomingCommitCount] = useState(0);
  const [outgoingCommitCount, setOutgoingCommitCount] = useState(0);
  const [pendingDiscard, setPendingDiscard] =
    useState<PendingDiscardAction | null>(null);
  const [dontWarnAgain, setDontWarnAgain] = useState(false);

  const loadStatus = useCallback(async (): Promise<SourceControlFile[]> => {
    setSourceControlLoading(true);
    try {
      const result = await workspaceStatus(selectedRepoId ?? undefined);
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
  }, [
    selectedRepoId,
    setScmError,
    setSourceControlFiles,
    setSourceControlLoading,
  ]);

  const commitHistoryController = usePagedCommitHistory({
    repo: selectedRepoId ?? undefined,
    // While detached, keep the branch we came from visible so the commits
    // "ahead" of the checked-out point still render in the graph.
    branchHint: detached && previousBranch ? detachedBranchHint() : undefined,
    detached,
  });
  const refreshCommitHistory = commitHistoryController.refresh;

  // Keep the small amount of branch metadata used by the checkout context
  // menu synchronized with the hook's authoritative response.
  useEffect(() => {
    if (!commitHistoryController.listingId) return;
    setCurrentBranch(commitHistoryController.currentBranch);
    setDetached(commitHistoryController.detached);
  }, [
    commitHistoryController.currentBranch,
    commitHistoryController.detached,
    commitHistoryController.listingId,
    setCurrentBranch,
    setDetached,
  ]);

  const refreshAll = useCallback(async () => {
    refreshCommitHistory();
    await loadStatus();
  }, [loadStatus, refreshCommitHistory]);

  // Discover repos once on mount; the selector appears only for multi-repo
  // workspaces and defaults selection to the repo containing the open file.
  useEffect(() => {
    workspaceRepos()
      .then((result) => setRepos(result.repos, result.prefixRepoIds))
      .catch(() => {
        // ignore — selector simply won't appear; SCM falls back to aggregate
      });
  }, [setRepos]);

  // Load status + history whenever the selected repo changes. The hook also
  // keys its frozen listing to this repo/context, so refresh starts a fresh
  // snapshot rather than appending to the previous repository's pages.
  useEffect(() => {
    void loadStatus();
    refreshCommitHistory();
  }, [loadStatus, refreshCommitHistory, selectedRepoId]);

  const selectFileDiff = useCallback(
    async (filePath: string) => {
      selectDiff(filePath);
      setDiffLoading(true);
      if (isMobile) setMobileDiffVisible(true);
      try {
        const result = await workspaceDiff(filePath);
        setDiffData(result);
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

  // Consume history navigation separately from single-file diff navigation.
  // The store owns the target synchronously; this consumer owns mobile pane
  // visibility just like the existing pending diff flow does.
  useEffect(() => {
    if (!pendingFileHistory) return;
    clearPendingFileHistory();
    if (isMobile) setMobileDiffVisible(true);
  }, [
    clearPendingFileHistory,
    isMobile,
    pendingFileHistory,
    setMobileDiffVisible,
  ]);

  const handleDiffBack = useCallback(() => {
    if (fileHistoryActive) closeFileHistoryView();
    setMobileDiffVisible(false);
  }, [closeFileHistoryView, fileHistoryActive, setMobileDiffVisible]);

  const refreshAfterMutation = useCallback(
    async (affectedPaths: string[]) => {
      const files = await loadStatus();
      refreshCommitHistory();
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
      loadStatus,
      refreshCommitHistory,
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
        refreshCommitHistory();
      } catch (err) {
        setScmError(String(err));
      }
    },
    [loadStatus, refreshCommitHistory, setScmError]
  );

  const handleUnstage = useCallback(
    async (filePath: string) => {
      try {
        await workspaceUnstage({ path: filePath });
        await loadStatus();
        refreshCommitHistory();
      } catch (err) {
        setScmError(String(err));
      }
    },
    [loadStatus, refreshCommitHistory, setScmError]
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

  // The files region sizes to its own content (a short list stays short)
  // capped at 45% of the column so a long list still scrolls in its own
  // region instead of pushing history off-screen. History always claims
  // whatever's left — a fixed 50/50 split previously left a large empty gap
  // under a short file list instead of handing that space to the graph.
  const filesRegionClass =
    "flex-none max-h-[45%] min-h-0 overflow-x-hidden overflow-y-auto";
  // No overflow here: WorkspaceCommitHistoryPane owns its own scroll
  // container internally (needed so its virtualizer has a fixed element to
  // measure). Adding overflow-y-auto on this wrapper too would nest a second
  // scroll region around it, which starves the virtualizer of a reliable
  // viewport height and caps it at its unmeasured-fallback row count instead
  // of loading enough pages to fill the real viewport.
  const historyRegionClass = "flex-1 basis-0 min-h-0";

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
        (file) =>
          paths.includes(file.path) && file.kind === SCM_FILE_KINDS.UNTRACKED
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
      refreshCommitHistory();
    } catch (err) {
      setScmError(String(err));
    }
  }, [changed, loadStatus, refreshCommitHistory, setScmError]);

  const handleDiscardAll = useCallback(() => {
    requestDiscard(changed.map((file) => file.path));
  }, [changed, requestDiscard]);

  const handleUnstageAll = useCallback(async () => {
    try {
      for (const file of staged) {
        await workspaceUnstage({ path: file.path });
      }
      await loadStatus();
      refreshCommitHistory();
    } catch (err) {
      setScmError(String(err));
    }
  }, [loadStatus, refreshCommitHistory, setScmError, staged]);

  const handleDiscardCheckboxChange = useCallback(
    (checked: boolean) => {
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
        className={`cy-list-row flex items-center gap-1 px-2 py-1 transition-colors ${
          isSelected
            ? "cy-list-row-selected bg-list-active-bg"
            : "hover:bg-list-hover-bg"
        }`}
      >
        <button
          onClick={() => selectFileDiff(file.path)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1 py-0.5 text-left text-sm text-editor-fg"
          title={file.path}
        >
          <span
            className={`shrink-0 text-xs font-mono font-bold ${badgeColorClass}`}
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
              className="codicon codicon-discard flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center p-1 text-xs opacity-60 hover:opacity-100 sm:min-h-0 sm:min-w-0"
              title="Discard changes"
              aria-label="Discard changes"
            />
          )}

          {isStaged ? (
            <button
              onClick={() => handleUnstage(file.path)}
              className="codicon codicon-dash flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center p-1 text-xs opacity-60 hover:opacity-100 sm:min-h-0 sm:min-w-0"
              title="Unstage"
              aria-label="Unstage"
            />
          ) : (
            <button
              onClick={() => handleStage(file.path)}
              className="codicon codicon-plus flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center p-1 text-xs opacity-60 hover:opacity-100 sm:min-h-0 sm:min-w-0"
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
                aria-label="Discard all changes"
                className="inline-flex items-center gap-1 text-xs text-btn-fg hover:underline"
              >
                <Icon name="discard" className="text-xs" />
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
    <div className="flex flex-col overflow-hidden h-full">
      <WorkspaceCommitArea
        incomingCommitCount={incomingCommitCount}
        onRefresh={refreshAll}
        outgoingCommitCount={outgoingCommitCount}
      />
      <div className="border-t border-panel-border shrink-0" />

      {/* Files region — independently scrollable */}
      <div className={filesRegionClass}>
        {sourceControlLoading ? (
          <div className="flex items-center justify-center py-6 text-editor-fg opacity-50 gap-2">
            <Icon name="loading" className="animate-spin text-sm" />
            <span className="text-xs">Refreshing…</span>
          </div>
        ) : (
          sourceControlSections
        )}
      </div>

      <div className="border-t border-panel-border shrink-0" />

      {/* Commit history region — independently scrollable */}
      <div className={historyRegionClass}>
        <WorkspaceCommitHistoryPane
          controller={commitHistoryController}
          onRefresh={() => void loadStatus()}
          isMobile={isMobile}
        />
      </div>
    </div>
  );

  if (isMobile && mobileDiffVisible) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-panel-border shrink-0">
          <button
            onClick={handleDiffBack}
            aria-label="Back to source control"
            className="flex items-center gap-1 text-editor-fg hover:opacity-80 transition-opacity"
          >
            <Icon name="arrow-left" className="text-sm" />
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
          <div className="flex-1 overflow-x-hidden overflow-y-auto flex flex-col">
            <WorkspaceCommitArea
              incomingCommitCount={incomingCommitCount}
              onRefresh={refreshAll}
              outgoingCommitCount={outgoingCommitCount}
            />
            <div className="border-t border-panel-border" />

            {sourceControlLoading ? (
              <div className="flex items-center justify-center py-6 text-editor-fg opacity-50 gap-2">
                <Icon name="loading" className="animate-spin text-sm" />
                <span className="text-xs">Refreshing…</span>
              </div>
            ) : (
              sourceControlSections
            )}

            <div className="border-t border-panel-border" />
            <WorkspaceCommitHistoryPane
              controller={commitHistoryController}
              onRefresh={() => void loadStatus()}
              isMobile={isMobile}
            />
          </div>
        </div>

        <DeleteConfirmationModal
          isOpen={pendingDiscard !== null}
          onClose={() => setPendingDiscard(null)}
          title={
            pendingDiscard?.untrackedCount === 1
              ? "Delete Untracked File?"
              : "Delete Untracked Files?"
          }
          message={discardMessage}
          detail={discardDetail}
          confirmLabel="Discard"
          onConfirm={handleConfirmDiscard}
          dontWarnAgain={dontWarnAgain}
          onDontWarnAgainChange={handleDiscardCheckboxChange}
          dontWarnAgainLabel="Don't warn me again before deleting untracked files"
        />
      </>
    );
  }

  return (
    <>
      <div className="flex h-full overflow-hidden">
        <Group
          orientation="horizontal"
          className="flex-1 min-w-0"
          id="workspace-scm-layout"
        >
          <Panel
            id="workspace-scm-files-panel"
            defaultSize={WORKSPACE_VIEWER_SIDE_PANEL_DEFAULT_SIZE}
            minSize={WORKSPACE_VIEWER_SIDE_PANEL_MIN_SIZE}
            maxSize={WORKSPACE_VIEWER_SIDE_PANEL_MAX_SIZE}
            groupResizeBehavior="preserve-pixel-size"
          >
            {leftColumn}
          </Panel>
          <Separator className={SEPARATOR_VERTICAL} />
          <Panel id="workspace-scm-diff-panel">
            <div className="h-full overflow-hidden">
              <WorkspaceDiffPane />
            </div>
          </Panel>
        </Group>
      </div>

      <DeleteConfirmationModal
        isOpen={pendingDiscard !== null}
        onClose={() => setPendingDiscard(null)}
        title={
          pendingDiscard?.untrackedCount === 1
            ? "Delete Untracked File?"
            : "Delete Untracked Files?"
        }
        message={discardMessage}
        detail={discardDetail}
        confirmLabel="Discard"
        onConfirm={handleConfirmDiscard}
        dontWarnAgain={dontWarnAgain}
        onDontWarnAgainChange={handleDiscardCheckboxChange}
        dontWarnAgainLabel="Don't warn me again before deleting untracked files"
      />
    </>
  );
};
