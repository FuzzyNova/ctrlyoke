import React, { useCallback, useEffect, useState } from "react";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { workspaceStatus, workspaceDiff, workspaceStage, workspaceUnstage } from "@utils/hostedApi";
import { useIsMobile } from "@hooks/useMediaQuery";
import type { SourceControlFile } from "@root/types/HostedWorkspaceViewerTypes";
import { WorkspaceCommitArea } from "./WorkspaceCommitArea";
import { WorkspaceDiffPane } from "./WorkspaceDiffPane";

function getStatusBadge(file: SourceControlFile): string {
  if (file.kind === "added") return "A";
  if (file.kind === "deleted") return "D";
  if (file.kind === "renamed") return "R";
  if (file.kind === "untracked") return "U";
  return "M";
}

export const WorkspaceSourceControlPane: React.FC = () => {
  const sourceControlFiles = useWorkspaceViewerStore((s) => s.sourceControlFiles);
  const selectedDiffPath = useWorkspaceViewerStore((s) => s.selectedDiffPath);
  const sourceControlLoading = useWorkspaceViewerStore((s) => s.sourceControlLoading);
  const setSourceControlFiles = useWorkspaceViewerStore((s) => s.setSourceControlFiles);
  const setSourceControlLoading = useWorkspaceViewerStore((s) => s.setSourceControlLoading);
  const selectDiff = useWorkspaceViewerStore((s) => s.selectDiff);
  const setDiffData = useWorkspaceViewerStore((s) => s.setDiffData);
  const setDiffLoading = useWorkspaceViewerStore((s) => s.setDiffLoading);
  const setScmError = useWorkspaceViewerStore((s) => s.setScmError);

  const isMobile = useIsMobile();
  const [mobileDiffVisible, setMobileDiffVisible] = useState(false);

  const loadStatus = useCallback(async () => {
    setSourceControlLoading(true);
    try {
      const result = await workspaceStatus();
      setSourceControlFiles(result.files);
    } catch (err) {
      setScmError(String(err));
    } finally {
      setSourceControlLoading(false);
    }
  }, [setSourceControlLoading, setSourceControlFiles, setScmError]);

  useEffect(() => {
    loadStatus();
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
        setDiffData(result.oldContent, result.newContent, result.language, result.kind);
      } catch (err) {
        setScmError(String(err));
      } finally {
        setDiffLoading(false);
      }
    },
    [selectDiff, setDiffLoading, isMobile, setDiffData, setScmError]
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

  const staged = sourceControlFiles.filter((f) => f.stagedStatus !== null);
  const changed = sourceControlFiles.filter((f) => f.unstagedStatus !== null);

  const handleStageAll = useCallback(async () => {
    try {
      for (const f of changed) {
        await workspaceStage({ path: f.path });
      }
      await loadStatus();
    } catch (err) {
      setScmError(String(err));
    }
  }, [changed, loadStatus, setScmError]);

  const handleUnstageAll = useCallback(async () => {
    try {
      for (const f of staged) {
        await workspaceUnstage({ path: f.path });
      }
      await loadStatus();
    } catch (err) {
      setScmError(String(err));
    }
  }, [staged, loadStatus, setScmError]);

  // ---------------------------------------------------------------------------
  // File row renderer
  // ---------------------------------------------------------------------------

  const renderFileRow = (file: SourceControlFile, isStaged: boolean) => {
    const badge = getStatusBadge(file);
    const isSelected = selectedDiffPath === file.path;

    return (
      <button
        key={`${isStaged ? "staged" : "changed"}-${file.path}`}
        onClick={() => selectFileDiff(file.path)}
        className={`w-full flex items-center gap-2 px-3 py-1.5 min-h-[44px] sm:min-h-0 text-sm text-left hover:bg-list-hover-bg transition-colors ${
          isSelected ? "bg-list-active-bg" : ""
        }`}
        title={file.path}
      >
        <span
          className={`text-xs font-mono font-bold flex-shrink-0 ${
            isStaged
              ? "text-[var(--vscode-gitDecoration-addedResourceForeground,#81b88b)]"
              : "text-[var(--vscode-gitDecoration-modifiedResourceForeground,#e2c08d)]"
          }`}
        >
          {badge}
        </span>
        <span className="flex-1 truncate text-editor-fg text-xs min-w-0">
          {file.path}
        </span>
        {isStaged ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleUnstage(file.path);
            }}
            className="codicon codicon-dash text-xs opacity-60 hover:opacity-100 flex-shrink-0 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 flex items-center justify-center p-1"
            title="Unstage"
            aria-label="Unstage"
          />
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleStage(file.path);
            }}
            className="codicon codicon-plus text-xs opacity-60 hover:opacity-100 flex-shrink-0 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 flex items-center justify-center p-1"
            title="Stage"
            aria-label="Stage"
          />
        )}
      </button>
    );
  };

  // ---------------------------------------------------------------------------
  // Left column (commit area + file lists)
  // ---------------------------------------------------------------------------

  const leftColumn = (
    <div className="w-64 flex-shrink-0 flex flex-col border-r border-panel-border overflow-y-auto">
      <WorkspaceCommitArea onRefresh={loadStatus} />
      <div className="border-t border-panel-border" />

      {sourceControlLoading ? (
        <div className="flex items-center justify-center py-6 text-editor-fg opacity-50 gap-2">
          <i className="codicon codicon-loading animate-spin text-sm" />
          <span className="text-xs">Refreshing…</span>
        </div>
      ) : (
        <>
          {/* Staged section */}
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
              <div>{staged.map((f) => renderFileRow(f, true))}</div>
            )}
          </div>

          <div className="border-t border-panel-border" />

          {/* Changes section */}
          <div>
            <div className="flex items-center justify-between px-3 py-1.5">
              <span className="text-xs font-semibold uppercase text-editor-fg opacity-60">
                Changes ({changed.length})
              </span>
              {changed.length > 0 && (
                <button
                  onClick={handleStageAll}
                  className="text-xs text-btn-fg hover:underline"
                >
                  Stage All
                </button>
              )}
            </div>
            {changed.length === 0 ? (
              <p className="px-3 pb-2 text-xs text-editor-fg opacity-40 select-none">
                No changes
              </p>
            ) : (
              <div>{changed.map((f) => renderFileRow(f, false))}</div>
            )}
          </div>
        </>
      )}
    </div>
  );

  // ---------------------------------------------------------------------------
  // Mobile diff view (full-screen when a file is selected)
  // ---------------------------------------------------------------------------

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
          <span className="flex-1 text-sm truncate text-editor-fg min-w-0 ml-1">
            {selectedDiffPath}
          </span>
        </div>
        <div className="flex-1 overflow-auto">
          <WorkspaceDiffPane />
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Mobile: show only left column (file list + commit)
  // ---------------------------------------------------------------------------

  if (isMobile) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex-1 overflow-y-auto flex flex-col">
          <WorkspaceCommitArea onRefresh={loadStatus} />
          <div className="border-t border-panel-border" />

          {sourceControlLoading ? (
            <div className="flex items-center justify-center py-6 text-editor-fg opacity-50 gap-2">
              <i className="codicon codicon-loading animate-spin text-sm" />
              <span className="text-xs">Refreshing…</span>
            </div>
          ) : (
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
                  <div>{staged.map((f) => renderFileRow(f, true))}</div>
                )}
              </div>
              <div className="border-t border-panel-border" />
              <div>
                <div className="flex items-center justify-between px-3 py-1.5">
                  <span className="text-xs font-semibold uppercase text-editor-fg opacity-60">
                    Changes ({changed.length})
                  </span>
                  {changed.length > 0 && (
                    <button
                      onClick={handleStageAll}
                      className="text-xs text-btn-fg hover:underline"
                    >
                      Stage All
                    </button>
                  )}
                </div>
                {changed.length === 0 ? (
                  <p className="px-3 pb-2 text-xs text-editor-fg opacity-40 select-none">
                    No changes
                  </p>
                ) : (
                  <div>{changed.map((f) => renderFileRow(f, false))}</div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Wide viewport: two-column layout
  // ---------------------------------------------------------------------------

  return (
    <div className="flex h-full overflow-hidden">
      {leftColumn}
      <div className="flex-1 overflow-hidden">
        <WorkspaceDiffPane />
      </div>
    </div>
  );
};
