import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import {
  SEPARATOR_VERTICAL,
  WORKSPACE_VIEWER_SIDE_PANEL_DEFAULT_SIZE,
  WORKSPACE_VIEWER_SIDE_PANEL_MAX_SIZE,
  WORKSPACE_VIEWER_SIDE_PANEL_MIN_SIZE,
} from "@/constants";
import { useUiStore } from "@store/uiStore";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { useSettingsStore } from "@store/settingsStore";
import { useIsMobile } from "@hooks/useMediaQuery";
import { useElementNarrow } from "@hooks/useElementNarrow";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { useWorkspaceEditorContextMenu } from "@hooks/useWorkspaceEditorContextMenu";
import { useWorkspaceExplorerContextMenu } from "@hooks/useWorkspaceExplorerContextMenu";
import { usePagedWorkspaceDirectory } from "@hooks/usePagedWorkspaceDirectory";
import { MESSAGE_TYPES, SETTING_SCOPES } from "@/types/messages";
import type {
  WorkspaceEntry,
  SourceControlFile,
} from "@root/types/HostedWorkspaceViewerTypes";
import {
  workspaceFile,
  workspaceSaveFile,
  workspaceStatus,
} from "@utils/hostedApi";
import { VirtualizedPagedList } from "@components/shared";
import {
  SCM_IGNORED_COLOR_CLASS,
  SCM_KIND_COLOR_CLASS,
} from "@utils/scmStatus";
import { getLanguageFromPath } from "@utils/syntaxHighlighting";
import { MarkdownText } from "@components/output/MarkdownText";
import {
  WorkspaceFileEditor,
  type WorkspaceFileEditorHandle,
  type WorkspaceFileEditorPendingSelection,
} from "./WorkspaceFileEditor";
import {
  DirectoryPageFailureNotice,
  EntryRow,
  FILE_BROWSER_NARROW_THRESHOLD,
  FileBrowserSortHeader,
  renderBreadcrumb as renderBreadcrumbShared,
  toWorkspaceRelative,
} from "./fileBrowserShared";
import type { WorkspaceEntrySortKey } from "@root/types/HostedWorkspaceViewerTypes";
import { nextWorkspaceEntrySort } from "@utils/workspaceEntrySort";
import {
  CLIPBOARD_OPERATIONS,
  SCM_FILE_KINDS,
  WORKSPACE_ENTRY_KINDS,
} from "@root/types/DashboardConstants";
import { Icon } from "../shared/Icon";

/**
 * Resolves the git-status text color class for an explorer entry, mirroring
 * VS Code's explorer gitDecoration coloring.
 * Ignored entries take priority. A directory with no status of its own falls
 * back to the aggregate status of its descendants; a mix of different kinds
 * is colored as modified (same as VS Code's folder decoration).
 */
function getEntryStatusColorClass(
  entry: WorkspaceEntry,
  sourceControlFiles: SourceControlFile[]
): string | undefined {
  if (entry.gitIgnored) return SCM_IGNORED_COLOR_CLASS;

  const ownStatus = sourceControlFiles.find((f) => f.path === entry.path);
  if (ownStatus && ownStatus.kind !== SCM_FILE_KINDS.DELETED) {
    return SCM_KIND_COLOR_CLASS[ownStatus.kind];
  }

  if (entry.kind !== WORKSPACE_ENTRY_KINDS.DIRECTORY) return undefined;

  const prefix = `${entry.path}/`;
  let aggregateKind: SourceControlFile["kind"] | undefined;
  for (const file of sourceControlFiles) {
    if (file.kind === SCM_FILE_KINDS.DELETED || !file.path.startsWith(prefix))
      continue;
    if (aggregateKind === undefined) {
      aggregateKind = file.kind;
    } else if (aggregateKind !== file.kind) {
      return SCM_KIND_COLOR_CLASS.modified;
    }
  }
  return aggregateKind ? SCM_KIND_COLOR_CLASS[aggregateKind] : undefined;
}

export const WorkspaceExplorerPane: React.FC = () => {
  const explorerPath = useWorkspaceViewerStore((s) => s.explorerPath);
  const setExplorerPath = useWorkspaceViewerStore((s) => s.setExplorerPath);
  const sourceControlFiles = useWorkspaceViewerStore(
    (s) => s.sourceControlFiles
  );
  const setSourceControlFiles = useWorkspaceViewerStore(
    (s) => s.setSourceControlFiles
  );
  const selectedFilePath = useWorkspaceViewerStore((s) => s.selectedFilePath);
  const selectedFileExternal = useWorkspaceViewerStore(
    (s) => s.selectedFileExternal
  );
  const fileContent = useWorkspaceViewerStore((s) => s.fileContent);
  const fileDirty = useWorkspaceViewerStore((s) => s.fileDirty);
  const fileLoading = useWorkspaceViewerStore((s) => s.fileLoading);
  const fileSaving = useWorkspaceViewerStore((s) => s.fileSaving);
  const fileReadOnly = useWorkspaceViewerStore((s) => s.fileReadOnly);
  const fileReadOnlyReason = useWorkspaceViewerStore(
    (s) => s.fileReadOnlyReason
  );
  const fileImageDataUri = useWorkspaceViewerStore((s) => s.fileImageDataUri);
  const mobileEditorVisible = useWorkspaceViewerStore(
    (s) => s.mobileEditorVisible
  );
  const selectFile = useWorkspaceViewerStore((s) => s.selectFile);
  const setFileContent = useWorkspaceViewerStore((s) => s.setFileContent);
  const setLoadedFileContent = useWorkspaceViewerStore(
    (s) => s.setLoadedFileContent
  );
  const setLoadedImage = useWorkspaceViewerStore((s) => s.setLoadedImage);
  const discardFileDraft = useWorkspaceViewerStore((s) => s.discardFileDraft);
  const markFileSaved = useWorkspaceViewerStore((s) => s.markFileSaved);
  const setFileLoading = useWorkspaceViewerStore((s) => s.setFileLoading);
  const setFileSaving = useWorkspaceViewerStore((s) => s.setFileSaving);
  const setFileReadOnly = useWorkspaceViewerStore((s) => s.setFileReadOnly);
  const setMobileEditorVisible = useWorkspaceViewerStore(
    (s) => s.setMobileEditorVisible
  );
  const openToFileHistory = useWorkspaceViewerStore((s) => s.openToFileHistory);
  const setError = useWorkspaceViewerStore((s) => s.setError);

  const pendingNavigation = useWorkspaceViewerStore((s) => s.pendingNavigation);
  const clearPendingNavigation = useWorkspaceViewerStore(
    (s) => s.clearPendingNavigation
  );

  const selectionRequestSeqRef = useRef(0);

  const workspacePath = useSettingsStore((s) => s.globalSettings.workspaceRoot);
  const hideGitIgnoredFiles = useSettingsStore(
    (s) => s.globalSettings.hideGitIgnoredFiles
  );
  const hideGitIgnoredFilesScope = useSettingsStore((s) =>
    s.globalSettings.settingSources["ui.hideGitIgnoredFiles"] ===
    SETTING_SCOPES.WORKSPACE
      ? SETTING_SCOPES.WORKSPACE
      : SETTING_SCOPES.USER
  );
  const vscode = useVsCodeApi();
  const workspaceEntrySort = useUiStore((s) => s.workspaceEntrySort);
  const setWorkspaceEntrySort = useUiStore((s) => s.setWorkspaceEntrySort);

  const isMobile = useIsMobile();
  const [narrowColumnRef, isNarrowColumnLayout] =
    useElementNarrow<HTMLDivElement>(FILE_BROWSER_NARROW_THRESHOLD);

  const editorRef = useRef<WorkspaceFileEditorHandle>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);
  const [pendingEditorSelection, setPendingEditorSelection] =
    useState<WorkspaceFileEditorPendingSelection | null>(null);

  // Markdown files can be toggled between the CodeMirror editor and a rendered
  // markdown preview (reusing MarkdownText). Non-markdown files never preview.
  const isMarkdownFile = useMemo(
    () =>
      !!selectedFilePath &&
      getLanguageFromPath(selectedFilePath) === "markdown",
    [selectedFilePath]
  );
  const showPreview = previewMode && isMarkdownFile && !fileReadOnly;

  // Reset to the editor view whenever the open file changes so a newly-opened
  // (possibly non-markdown) file never lands in a stale preview state.
  useEffect(() => {
    setPreviewMode(false);
  }, [selectedFilePath]);
  const {
    openContextMenu: openEditorContextMenu,
    editorContextMenuPortal,
    editorLongPressHandlers,
  } = useWorkspaceEditorContextMenu({
    editorRef,
    filePath: selectedFilePath,
  });

  const directoryScrollContainerRef = useRef<HTMLDivElement>(null);
  const directory = usePagedWorkspaceDirectory({
    path: explorerPath,
    includeGitIgnored: !hideGitIgnoredFiles,
    sort: workspaceEntrySort,
    sortAnchorPath: selectedFilePath ?? undefined,
    // A pending route/open request is consumed below. Let that request own
    // the first listing so the hook cannot issue a duplicate request that is
    // immediately aborted by the pending-navigation effect.
    enabled: pendingNavigation === null,
  });
  const parentPath = directory.parentPath;
  const rootLabel = directory.rootLabel;
  const isRootsList = directory.isRootsList;
  const navigateDirectory = directory.navigate;
  const refreshPagedDirectory = directory.refresh;

  const handleSortKeyRequest = useCallback(
    (key: WorkspaceEntrySortKey) => {
      setWorkspaceEntrySort(nextWorkspaceEntrySort(workspaceEntrySort, key));
    },
    [setWorkspaceEntrySort, workspaceEntrySort]
  );

  // The hook is the listing source; explorerPath remains in the store only so
  // navigation URLs can describe the directory currently shown.
  useEffect(() => {
    if (directory.path !== useWorkspaceViewerStore.getState().explorerPath) {
      setExplorerPath(directory.path);
    }
  }, [directory.path, setExplorerPath]);

  const loadDirectory = useCallback(
    (dirPath: string, anchorPath?: string) => {
      navigateDirectory(dirPath, anchorPath ? { anchorPath } : undefined);
    },
    [navigateDirectory]
  );

  const refreshDirectory = useCallback(
    (affectedPath?: string) => {
      const candidate = affectedPath ?? selectedFilePath;
      const normalizedCandidate = candidate?.replace(/\\/g, "/");
      const lastSlash = normalizedCandidate?.lastIndexOf("/") ?? -1;
      const candidateParent =
        lastSlash > 0 ? normalizedCandidate?.slice(0, lastSlash) : "";
      const anchorPath =
        normalizedCandidate && candidateParent === directory.path
          ? normalizedCandidate
          : undefined;
      refreshPagedDirectory(anchorPath ? { anchorPath } : undefined);
    },
    [directory.path, refreshPagedDirectory, selectedFilePath]
  );

  // Loads git status for the whole workspace, used to color explorer entries
  // by their gitDecoration status (mirrors VS Code's explorer coloring).
  const loadGitStatus = useCallback(() => {
    workspaceStatus()
      .then((result) => setSourceControlFiles(result.files))
      .catch(() => {
        // silently ignore — entries simply render without status colors
      });
  }, [setSourceControlFiles]);

  // Load root on mount, unless a pending navigation will handle it
  useEffect(() => {
    loadGitStatus();
    // The paged-directory hook owns the initial listing; status remains an
    // aggregate, unpaged workspace request used for row coloring.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openFile = useCallback(
    async (filePath: string, external = false) => {
      const relPath = external
        ? filePath
        : toWorkspaceRelative(filePath, workspacePath);
      setFileLoading(true);
      selectFile(relPath, external);
      if (isMobile) setMobileEditorVisible(true);
      try {
        const result = await workspaceFile(relPath);
        // Use the server's canonical workspace-relative path so that
        // selectedFilePath is self-corrected even if relPath was an absolute
        // path that failed stripping (e.g. due to workspacePath being empty).
        const canonicalPath = result.path.replace(/\\/g, "/");
        if (result.imageDataUri) {
          setLoadedImage(canonicalPath, result.imageDataUri);
        } else if (result.readOnly) {
          setFileReadOnly(true, result.reason);
        } else {
          setFileReadOnly(false);
          setLoadedFileContent(canonicalPath, result.content);
        }
      } catch (err) {
        setError(String(err));
      } finally {
        setFileLoading(false);
      }
    },
    [
      workspacePath,
      isMobile,
      selectFile,
      setFileLoading,
      setLoadedFileContent,
      setLoadedImage,
      setFileReadOnly,
      setMobileEditorVisible,
      setError,
    ]
  );

  // Keep the directory listing in sync with the selected file.
  // Whenever a file is opened by any means (explorer click, CodeMirror link,
  // future callers), navigate the explorer to its parent directory if not already there.
  // The directory list already highlights whichever entry matches selectedFilePath,
  // so loading the parent is all that's needed.
  //
  // NOTE: explorerPath is intentionally NOT in the dependency array. Including it
  // would cause the effect to re-run on every manual directory navigation, dragging
  // the user back to the selected file's parent dir. We read it from store state
  // directly to keep the "don't reload if already there" optimisation without
  // making explorerPath a trigger.
  useEffect(() => {
    if (!selectedFilePath || pendingNavigation || selectedFileExternal) return;
    const relativePath = toWorkspaceRelative(selectedFilePath, workspacePath);
    const normalizedPath = relativePath.replace(/\\/g, "/");
    const lastSep = Math.max(
      normalizedPath.lastIndexOf("/"),
      normalizedPath.lastIndexOf("\\")
    );
    const parentDir = lastSep > 0 ? normalizedPath.slice(0, lastSep) : "";
    if (parentDir !== useWorkspaceViewerStore.getState().explorerPath) {
      loadDirectory(parentDir, normalizedPath);
    }
  }, [
    loadDirectory,
    pendingNavigation,
    selectedFileExternal,
    selectedFilePath,
    workspacePath,
  ]);

  // Consume pending navigation set externally (e.g. from CodeMirror link clicks)
  useEffect(() => {
    if (!pendingNavigation) return;
    if (pendingNavigation.type === WORKSPACE_ENTRY_KINDS.DIRECTORY) {
      const normalizedPath = pendingNavigation.dirPath
        .replace(/\\/g, "/")
        .replace(/^\.\//, "");
      // Keep the hook's path prop aligned with the request before enabling
      // its normal option effect. This lets the one-shot navigate call below
      // be recognized as intentional rather than restarting the old path.
      setExplorerPath(normalizedPath);
      loadDirectory(normalizedPath);
    } else if (pendingNavigation.external) {
      // An external file (e.g. the user-scope settings.json) isn't part of
      // the explorer tree, so there's no parent directory to navigate to.
      setPendingEditorSelection(null);
      openFile(pendingNavigation.filePath, true);
    } else {
      const { filePath, startLine, endLine } = pendingNavigation;
      const relativePath = toWorkspaceRelative(filePath, workspacePath);
      const normalizedPath = relativePath.replace(/\\/g, "/");
      const lastSlash = normalizedPath.lastIndexOf("/");
      const parentDir = lastSlash > 0 ? normalizedPath.slice(0, lastSlash) : "";
      setExplorerPath(parentDir);
      loadDirectory(parentDir, normalizedPath);
      if (startLine !== undefined && endLine !== undefined) {
        setPendingEditorSelection({
          requestId: ++selectionRequestSeqRef.current,
          startLine,
          endLine,
        });
      } else {
        setPendingEditorSelection(null);
      }
      openFile(filePath);
    }
    // File navigation updates selectedFilePath synchronously before its HTTP
    // request begins. Clear the request afterwards so navigation recording sees
    // the target file rather than the file that was previously open.
    clearPendingNavigation();
  }, [
    pendingNavigation,
    clearPendingNavigation,
    loadDirectory,
    openFile,
    setExplorerPath,
    workspacePath,
  ]);

  const handlePendingSelectionApplied = useCallback((requestId: number) => {
    setPendingEditorSelection((current) =>
      current?.requestId === requestId ? null : current
    );
  }, []);

  const handleBack = useCallback(() => {
    if (parentPath !== null) {
      loadDirectory(parentPath);
    }
  }, [parentPath, loadDirectory]);

  const handleRefresh = useCallback(
    (affectedPath?: string) => {
      refreshDirectory(affectedPath);
      loadGitStatus();
    },
    [loadGitStatus, refreshDirectory]
  );

  const handleSyncExplorer = useCallback(() => {
    if (!selectedFilePath || selectedFileExternal) return;
    const relativePath = toWorkspaceRelative(selectedFilePath, workspacePath);
    const normalizedPath = relativePath.replace(/\\/g, "/");
    const lastSep = Math.max(
      normalizedPath.lastIndexOf("/"),
      normalizedPath.lastIndexOf("\\")
    );
    const parentDir = lastSep > 0 ? normalizedPath.slice(0, lastSep) : "";
    loadDirectory(parentDir, normalizedPath);
  }, [loadDirectory, selectedFileExternal, selectedFilePath, workspacePath]);

  const { clipboard, openContextMenu, explorerContextMenuPortal } =
    useWorkspaceExplorerContextMenu({
      explorerPath,
      isRootsList,
      onRefresh: handleRefresh,
      onOpenFile: openFile,
      onViewFileHistory: openToFileHistory,
    });

  const handleMobileBack = useCallback(() => {
    setMobileEditorVisible(false);
  }, [setMobileEditorVisible]);

  const handleSave = useCallback(async () => {
    if (!selectedFilePath) return;
    setFileSaving(true);
    try {
      await workspaceSaveFile({ path: selectedFilePath, content: fileContent });
      markFileSaved(fileContent);
      refreshDirectory(selectedFilePath);
    } catch (err) {
      setError(String(err));
    } finally {
      setFileSaving(false);
    }
  }, [
    selectedFilePath,
    fileContent,
    setFileSaving,
    markFileSaved,
    refreshDirectory,
    setError,
  ]);

  const handleDiscardUnsaved = useCallback(async () => {
    if (!selectedFilePath) return;
    setFileLoading(true);
    try {
      const result = await workspaceFile(selectedFilePath);
      if (result.readOnly) {
        setFileReadOnly(true, result.reason);
      } else {
        setFileReadOnly(false);
        discardFileDraft(selectedFilePath, result.content);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setFileLoading(false);
    }
  }, [
    selectedFilePath,
    setFileLoading,
    setFileReadOnly,
    discardFileDraft,
    setError,
  ]);

  const handleUndo = useCallback(() => {
    editorRef.current?.undo();
  }, []);

  const handleRedo = useCallback(() => {
    editorRef.current?.redo();
  }, []);

  const handleUndoRedoChange = useCallback(
    (newCanUndo: boolean, newCanRedo: boolean) => {
      setCanUndo(newCanUndo);
      setCanRedo(newCanRedo);
    },
    []
  );

  // ---------------------------------------------------------------------------
  // Directory list (left column / mobile default view)
  // ---------------------------------------------------------------------------

  const directoryListColumn = (
    <div
      ref={narrowColumnRef}
      className="flex flex-col h-full w-full overflow-hidden cy-no-select"
    >
      {/* Navigation toolbar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-panel-border flex-shrink-0">
        <button
          onClick={handleBack}
          disabled={parentPath === null}
          className={`flex items-center justify-center w-6 h-6 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 rounded transition-colors flex-shrink-0 ${
            parentPath === null
              ? "opacity-30 cursor-default"
              : "hover:bg-btn-secondary-hover text-editor-fg"
          }`}
          title="Go to parent directory"
          aria-label="Go to parent directory"
        >
          <Icon name="arrow-left" className="text-xs" />
        </button>

        <div className="flex-1 min-w-0 px-1 py-0.5">
          <div className="flex flex-wrap items-center min-w-0">
            {renderBreadcrumbShared(explorerPath, rootLabel, loadDirectory)}
          </div>
        </div>

        {directory.isGitRepo && (
          <button
            onClick={() =>
              vscode.postMessage({
                type: MESSAGE_TYPES.UPDATE_GLOBAL_SETTING,
                path: "ui.hideGitIgnoredFiles",
                value: !hideGitIgnoredFiles,
                scope: hideGitIgnoredFilesScope,
              })
            }
            className={`flex items-center justify-center w-6 h-6 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 rounded transition-colors flex-shrink-0 ${
              hideGitIgnoredFiles
                ? "hover:bg-btn-secondary-hover text-editor-fg opacity-40"
                : "hover:bg-btn-secondary-hover text-editor-fg"
            }`}
            title={
              hideGitIgnoredFiles
                ? "Show git-ignored files"
                : "Hide git-ignored files"
            }
            aria-label={
              hideGitIgnoredFiles
                ? "Show git-ignored files"
                : "Hide git-ignored files"
            }
          >
            <Icon
              name={hideGitIgnoredFiles ? "codicon-eye-closed" : "codicon-eye"}
              className="text-xs"
            />
          </button>
        )}

        <button
          onClick={() => handleRefresh()}
          className="flex items-center justify-center w-6 h-6 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 rounded hover:bg-btn-secondary-hover text-editor-fg transition-colors flex-shrink-0"
          title="Refresh directory"
          aria-label="Refresh directory"
        >
          <Icon
            name="refresh"
            className={`text-xs ${directory.isLoading ? "animate-spin" : ""}`}
          />
        </button>

        {!isMobile && (
          <button
            onClick={handleSyncExplorer}
            disabled={!selectedFilePath || selectedFileExternal}
            className={`flex items-center justify-center w-6 h-6 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 rounded transition-colors flex-shrink-0 ${
              selectedFilePath && !selectedFileExternal
                ? "hover:bg-btn-secondary-hover text-editor-fg"
                : "opacity-30 cursor-default"
            }`}
            title="Sync explorer to open file"
            aria-label="Sync explorer to open file"
          >
            <Icon name="arrow-swap" className="text-xs" />
          </button>
        )}
      </div>

      {/* Entry list */}
      <div
        ref={directoryScrollContainerRef}
        className="flex-1 overflow-y-auto"
        aria-busy={directory.isLoading}
      >
        <FileBrowserSortHeader
          sort={workspaceEntrySort}
          onSortKeyRequest={handleSortKeyRequest}
          isNarrow={isNarrowColumnLayout}
        />
        {directory.initialError && directory.totalCount === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-sm text-warning-fg">
            <span>{directory.initialError.message}</span>
            <button
              type="button"
              className="rounded border border-btn-border px-2 py-1 hover:bg-btn-secondary-hover"
              onClick={directory.retryInitial}
            >
              Retry
            </button>
          </div>
        ) : directory.isLoading && directory.totalCount === 0 ? (
          <div className="flex items-center justify-center py-8 text-editor-fg opacity-50">
            <Icon name="loading" className="animate-spin mr-2" />
            <span className="text-sm">Loading…</span>
          </div>
        ) : directory.totalCount === 0 ? (
          <div className="flex items-center justify-center py-8 text-editor-fg opacity-40 select-none">
            <span className="text-sm">Empty directory</span>
          </div>
        ) : (
          <div role="list" className="py-1">
            <VirtualizedPagedList
              totalCount={directory.totalCount}
              listingId={directory.listingId ?? ""}
              getItem={directory.getEntry}
              getItemKey={(entry) => entry.path}
              renderItem={(entry) => {
                const isSelected =
                  entry.kind === WORKSPACE_ENTRY_KINDS.FILE &&
                  selectedFilePath === entry.path;
                const isCut =
                  clipboard?.operation === CLIPBOARD_OPERATIONS.CUT &&
                  clipboard.path === entry.path;
                const statusColorClass = getEntryStatusColorClass(
                  entry,
                  sourceControlFiles
                );

                return (
                  <div role="listitem">
                    <EntryRow
                      entry={entry}
                      isSelected={isSelected}
                      isCut={isCut}
                      statusColorClass={statusColorClass}
                      onClick={() => {
                        if (entry.kind === WORKSPACE_ENTRY_KINDS.DIRECTORY) {
                          loadDirectory(entry.path);
                        } else {
                          openFile(entry.path);
                        }
                      }}
                      openContextMenu={openContextMenu}
                      isNarrow={isNarrowColumnLayout}
                    />
                  </div>
                );
              }}
              renderPlaceholder={(index) => {
                return (
                  <div
                    role="listitem"
                    className="min-h-[36px] animate-pulse px-3 py-2"
                    aria-label={`Loading entry ${index + 1}`}
                  >
                    <span className="block h-4 w-2/3 rounded bg-panel-border opacity-50" />
                  </div>
                );
              }}
              scrollContainerRef={directoryScrollContainerRef}
              estimateItemSize={() => 36}
              overscan={12}
              threshold={50}
              onRangeChange={directory.onRangeChange}
              layoutResetKey={directory.listingId ?? undefined}
              scrollToIndex={directory.scrollRestoration?.index ?? null}
              scrollToIndexRequest={directory.scrollRestoration?.requestId}
            />
          </div>
        )}
      </div>
      <DirectoryPageFailureNotice
        failedRange={directory.failedRanges[0]}
        onRetry={directory.retryPage}
      />
      {!directory.isInitialLoading &&
        directory.totalCount > 0 &&
        directory.uniqueLoadedCount < directory.totalCount && (
          <p
            className="flex-shrink-0 px-2 py-1 text-xs text-description-fg"
            aria-live="polite"
          >
            Loaded {directory.uniqueLoadedCount.toLocaleString()} of{" "}
            {directory.totalCount.toLocaleString()}
            {directory.pageLoading ? " …" : ""}
          </p>
        )}
    </div>
  );

  // ---------------------------------------------------------------------------
  // File editor column (right column on desktop; full-screen on mobile)
  // ---------------------------------------------------------------------------

  const fileEditorColumn = (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden relative">
      {/* File toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-panel-border flex-shrink-0 min-h-9">
        {isMobile && (
          <button
            onClick={handleMobileBack}
            aria-label="Back to file list"
            className="flex items-center gap-1 text-editor-fg hover:opacity-80 transition-opacity"
          >
            <Icon name="arrow-left" className="text-sm" />
            <span className="text-sm">Back</span>
          </button>
        )}
        {selectedFilePath ? (
          <>
            {!fileReadOnly && (
              <>
                <button
                  onClick={handleSave}
                  disabled={fileSaving || !fileDirty}
                  className={`flex items-center gap-1 px-2 py-0.5 text-xs rounded border transition-colors flex-shrink-0 ${
                    fileDirty && !fileSaving
                      ? "border-btn-border bg-btn-bg text-btn-fg hover:opacity-80"
                      : "border-transparent bg-transparent text-editor-fg opacity-40 cursor-default"
                  }`}
                  title={fileDirty ? "Save file" : "No changes to save"}
                  aria-label={fileDirty ? "Save file" : "No changes to save"}
                >
                  {fileSaving ? (
                    <Icon name="loading" className="animate-spin" />
                  ) : (
                    <Icon name="save" />
                  )}
                  Save
                </button>
                {/* Undo / Redo merged control */}
                <div
                  className="cy-button-group"
                  role="group"
                  aria-label="Undo / Redo"
                >
                  <button
                    type="button"
                    onClick={handleUndo}
                    disabled={!canUndo}
                    title="Undo"
                    aria-label="Undo"
                    className={`inline-flex items-center justify-center min-w-[24px] px-1.5 py-0.5 text-xs transition-colors focus:outline-none focus-visible:ring-1 ${
                      canUndo
                        ? "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
                        : "bg-btn-secondary-bg text-btn-secondary-fg opacity-40 cursor-not-allowed"
                    }`}
                  >
                    <Icon name="discard" />
                  </button>
                  <div className="bg-btn-secondary-bg text-btn-secondary-fg py-0.5 flex-shrink-0">
                    <div className="w-px h-full bg-current opacity-40" />
                  </div>
                  <button
                    type="button"
                    onClick={handleRedo}
                    disabled={!canRedo}
                    title="Redo"
                    aria-label="Redo"
                    className={`inline-flex items-center justify-center min-w-[24px] px-1.5 py-0.5 text-xs transition-colors focus:outline-none focus-visible:ring-1 ${
                      canRedo
                        ? "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
                        : "bg-btn-secondary-bg text-btn-secondary-fg opacity-40 cursor-not-allowed"
                    }`}
                  >
                    <Icon name="redo" />
                  </button>
                </div>
                {isMarkdownFile && (
                  <button
                    type="button"
                    onClick={() => setPreviewMode((p) => !p)}
                    aria-pressed={previewMode}
                    aria-label={previewMode ? "Edit file" : "Preview file"}
                    className={`flex items-center gap-1 px-2 py-0.5 text-xs rounded border transition-colors flex-shrink-0 ${
                      previewMode
                        ? "border-btn-border bg-btn-bg text-btn-fg hover:opacity-80"
                        : "border-btn-border bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
                    }`}
                    title={
                      previewMode
                        ? "Show the editor"
                        : "Preview rendered markdown"
                    }
                  >
                    <Icon
                      name={
                        previewMode ? "codicon-code" : "codicon-open-preview"
                      }
                    />
                    {previewMode ? "Edit" : "Preview"}
                  </button>
                )}
                <button
                  onClick={handleDiscardUnsaved}
                  disabled={fileSaving || fileLoading || !fileDirty}
                  className={`ml-auto flex items-center gap-1 px-2 py-0.5 text-xs rounded border transition-colors flex-shrink-0 ${
                    fileDirty && !fileSaving && !fileLoading
                      ? "border-btn-border bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
                      : "border-transparent bg-transparent text-editor-fg opacity-40 cursor-default"
                  }`}
                  title={
                    fileDirty
                      ? "Discard unsaved changes and reload from disk"
                      : "No unsaved changes to discard"
                  }
                >
                  <Icon name="debug-restart" />
                  Discard
                </button>
              </>
            )}
          </>
        ) : (
          !isMobile && (
            <span className="text-sm text-editor-fg opacity-40 select-none">
              No file selected
            </span>
          )
        )}
      </div>

      {/* Content area */}
      {selectedFilePath ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {fileLoading ? (
            <div className="flex items-center gap-2 p-4 opacity-50 text-editor-fg">
              <Icon name="loading" className="animate-spin" />
              <span className="text-sm">Loading file…</span>
            </div>
          ) : fileReadOnly ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 text-editor-fg opacity-70">
              <Icon name="info" className="text-2xl" />
              <p className="text-sm">
                {fileReadOnlyReason ?? "This file cannot be edited"}
              </p>
            </div>
          ) : (
            <div className="relative flex min-h-0 flex-1 overflow-hidden">
              {/* Editor stays mounted while previewing so undo history and
                  scroll position survive toggling back to edit mode. */}
              <div
                className={`h-full min-w-0 w-full flex-1 ${showPreview ? "hidden" : ""}`}
                role="presentation"
                onContextMenu={(e) => {
                  e.preventDefault();
                  openEditorContextMenu(e.clientX, e.clientY);
                }}
                {...editorLongPressHandlers}
              >
                <WorkspaceFileEditor
                  ref={editorRef}
                  filePath={selectedFilePath}
                  content={fileContent}
                  imageDataUri={fileImageDataUri ?? undefined}
                  onChange={(newContent) => setFileContent(newContent)}
                  onSave={handleSave}
                  saving={fileSaving}
                  onUndoRedoChange={handleUndoRedoChange}
                  pendingSelection={pendingEditorSelection}
                  onPendingSelectionApplied={handlePendingSelectionApplied}
                />
              </div>
              {showPreview && (
                <div className="absolute inset-0 overflow-y-auto overflow-x-hidden bg-editor-bg px-4 py-3">
                  {/* tableFullscreen=false: streamdown's table fullscreen
                      overlay portals to document.body and doesn't surface from
                      this preview pane — hide the button (copy/download stay). */}
                  <MarkdownText tableFullscreen={false}>
                    {fileContent}
                  </MarkdownText>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-editor-fg opacity-50 select-none">
          <p className="text-sm">Select a file to edit</p>
        </div>
      )}
    </div>
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (isMobile) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        {mobileEditorVisible ? fileEditorColumn : directoryListColumn}
        {explorerContextMenuPortal}
        {editorContextMenuPortal}
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      <Group
        orientation="horizontal"
        className="flex-1 min-w-0"
        id="workspace-explorer-layout"
      >
        <Panel
          id="workspace-explorer-tree-panel"
          defaultSize={WORKSPACE_VIEWER_SIDE_PANEL_DEFAULT_SIZE}
          minSize={WORKSPACE_VIEWER_SIDE_PANEL_MIN_SIZE}
          maxSize={WORKSPACE_VIEWER_SIDE_PANEL_MAX_SIZE}
          groupResizeBehavior="preserve-pixel-size"
        >
          <div className="h-full overflow-hidden">{directoryListColumn}</div>
        </Panel>
        <Separator className={SEPARATOR_VERTICAL} />
        <Panel id="workspace-explorer-editor-panel">
          <div className="h-full overflow-hidden">{fileEditorColumn}</div>
        </Panel>
      </Group>
      {explorerContextMenuPortal}
      {editorContextMenuPortal}
    </div>
  );
};
