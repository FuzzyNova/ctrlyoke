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
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { useSettingsStore } from "@store/settingsStore";
import { useIsMobile } from "@hooks/useMediaQuery";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { useWorkspaceEditorContextMenu } from "@hooks/useWorkspaceEditorContextMenu";
import { useWorkspaceExplorerContextMenu } from "@hooks/useWorkspaceExplorerContextMenu";
import { MESSAGE_TYPES, SETTING_SCOPES } from "@/types/messages";
import type {
  WorkspaceEntry,
  SourceControlFile,
} from "@root/types/HostedWorkspaceViewerTypes";
import {
  workspaceTree,
  workspaceFile,
  workspaceSaveFile,
  workspaceStatus,
} from "@utils/hostedApi";
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
  EntryRow,
  renderBreadcrumb as renderBreadcrumbShared,
  toWorkspaceRelative,
} from "./fileBrowserShared";

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
  if (ownStatus && ownStatus.kind !== "deleted") {
    return SCM_KIND_COLOR_CLASS[ownStatus.kind];
  }

  if (entry.kind !== "directory") return undefined;

  const prefix = `${entry.path}/`;
  let aggregateKind: SourceControlFile["kind"] | undefined;
  for (const file of sourceControlFiles) {
    if (file.kind === "deleted" || !file.path.startsWith(prefix)) continue;
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
  const explorerEntries = useWorkspaceViewerStore((s) => s.explorerEntries);
  const explorerLoading = useWorkspaceViewerStore((s) => s.explorerLoading);
  const setExplorerPath = useWorkspaceViewerStore((s) => s.setExplorerPath);
  const setExplorerEntries = useWorkspaceViewerStore(
    (s) => s.setExplorerEntries
  );
  const setExplorerLoading = useWorkspaceViewerStore(
    (s) => s.setExplorerLoading
  );
  const explorerIsGitRepo = useWorkspaceViewerStore((s) => s.explorerIsGitRepo);
  const setExplorerIsGitRepo = useWorkspaceViewerStore(
    (s) => s.setExplorerIsGitRepo
  );
  const sourceControlFiles = useWorkspaceViewerStore(
    (s) => s.sourceControlFiles
  );
  const setSourceControlFiles = useWorkspaceViewerStore(
    (s) => s.setSourceControlFiles
  );
  const selectedFilePath = useWorkspaceViewerStore((s) => s.selectedFilePath);
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
  const setActiveTab = useWorkspaceViewerStore((s) => s.setActiveTab);
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

  const isMobile = useIsMobile();

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

  // Nav metadata kept in local state — not needed globally
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [rootLabel, setRootLabel] = useState<string>("");
  // True when the current listing is the virtual top level of a multi-root
  // workspace (one entry per root folder) rather than a real directory —
  // entry-level file operations (cut/copy/delete/paste) are disabled there
  // since each entry represents an entire workspace root.
  const [isRootsList, setIsRootsList] = useState(false);

  const visibleEntries = useMemo(
    () =>
      hideGitIgnoredFiles
        ? explorerEntries.filter((entry) => !entry.gitIgnored)
        : explorerEntries,
    [explorerEntries, hideGitIgnoredFiles]
  );

  const loadDirectory = useCallback(
    async (dirPath: string) => {
      setExplorerLoading(true);
      try {
        const result = await workspaceTree(dirPath);
        const fwd = (p: string) => p.replace(/\\/g, "/");
        setExplorerEntries(
          result.entries.map((e) => ({ ...e, path: fwd(e.path) }))
        );
        setExplorerPath(fwd(result.path));
        setParentPath(
          result.parentPath !== null ? fwd(result.parentPath) : null
        );
        setRootLabel(result.rootLabel);
        setExplorerIsGitRepo(result.isGitRepo);
        setIsRootsList(result.isRootsList ?? false);
      } catch (err) {
        setError(String(err));
      } finally {
        setExplorerLoading(false);
      }
    },
    [
      setExplorerLoading,
      setExplorerEntries,
      setExplorerPath,
      setExplorerIsGitRepo,
      setError,
    ]
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
    if (!useWorkspaceViewerStore.getState().pendingNavigation) {
      loadDirectory(explorerPath);
    }
    loadGitStatus();
    // Intentional: run once on mount; navigation is explicit through loadDirectory calls
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openFile = useCallback(
    async (filePath: string) => {
      const relPath = toWorkspaceRelative(filePath, workspacePath);
      setFileLoading(true);
      selectFile(relPath);
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
    if (!selectedFilePath) return;
    const lastSep = Math.max(
      selectedFilePath.lastIndexOf("/"),
      selectedFilePath.lastIndexOf("\\")
    );
    const parentDir = lastSep > 0 ? selectedFilePath.slice(0, lastSep) : "";
    if (parentDir !== useWorkspaceViewerStore.getState().explorerPath) {
      loadDirectory(parentDir);
    }
  }, [selectedFilePath, loadDirectory]);

  // Consume pending navigation set externally (e.g. from CodeMirror link clicks)
  useEffect(() => {
    if (!pendingNavigation) return;
    if (pendingNavigation.type === "directory") {
      loadDirectory(pendingNavigation.dirPath);
    } else {
      const { filePath, startLine, endLine } = pendingNavigation;
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
  }, [pendingNavigation, clearPendingNavigation, loadDirectory, openFile]);

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

  const handleRefresh = useCallback(() => {
    loadDirectory(explorerPath);
    loadGitStatus();
  }, [explorerPath, loadDirectory, loadGitStatus]);

  const handleSyncExplorer = useCallback(() => {
    if (!selectedFilePath) return;
    const lastSep = Math.max(
      selectedFilePath.lastIndexOf("/"),
      selectedFilePath.lastIndexOf("\\")
    );
    const parentDir = lastSep > 0 ? selectedFilePath.slice(0, lastSep) : "";
    loadDirectory(parentDir);
  }, [selectedFilePath, loadDirectory]);

  const { clipboard, openContextMenu, explorerContextMenuPortal } =
    useWorkspaceExplorerContextMenu({
      explorerPath,
      isRootsList,
      onRefresh: handleRefresh,
      onOpenFile: openFile,
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
    } catch (err) {
      setError(String(err));
    } finally {
      setFileSaving(false);
    }
  }, [selectedFilePath, fileContent, setFileSaving, markFileSaved, setError]);

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
    <div className="flex flex-col h-full w-full overflow-hidden select-none [-webkit-touch-callout:none]">
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
          <i className="codicon codicon-arrow-left text-xs" />
        </button>

        <div className="flex-1 min-w-0 px-1 py-0.5">
          <div className="flex flex-wrap items-center min-w-0">
            {renderBreadcrumbShared(explorerPath, rootLabel, loadDirectory)}
          </div>
        </div>

        {explorerIsGitRepo && (
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
            <i
              className={`codicon ${hideGitIgnoredFiles ? "codicon-eye-closed" : "codicon-eye"} text-xs`}
            />
          </button>
        )}

        <button
          onClick={handleRefresh}
          className="flex items-center justify-center w-6 h-6 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 rounded hover:bg-btn-secondary-hover text-editor-fg transition-colors flex-shrink-0"
          title="Refresh directory"
          aria-label="Refresh directory"
        >
          <i
            className={`codicon codicon-refresh text-xs ${
              explorerLoading ? "animate-spin" : ""
            }`}
          />
        </button>

        {!isMobile && (
          <button
            onClick={handleSyncExplorer}
            disabled={!selectedFilePath}
            className={`flex items-center justify-center w-6 h-6 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 rounded transition-colors flex-shrink-0 ${
              selectedFilePath
                ? "hover:bg-btn-secondary-hover text-editor-fg"
                : "opacity-30 cursor-default"
            }`}
            title="Sync explorer to open file"
            aria-label="Sync explorer to open file"
          >
            <i className="codicon codicon-arrow-swap text-xs" />
          </button>
        )}

        <button
          onClick={() => setActiveTab("search")}
          className="flex items-center justify-center w-6 h-6 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 rounded hover:bg-btn-secondary-hover text-editor-fg transition-colors flex-shrink-0"
          title="Search workspace"
          aria-label="Search workspace"
        >
          <i className="codicon codicon-search text-xs" />
        </button>
      </div>

      {/* Entry list */}
      <div className="flex-1 overflow-y-auto">
        {explorerLoading ? (
          <div className="flex items-center justify-center py-8 text-editor-fg opacity-50">
            <i className="codicon codicon-loading animate-spin mr-2" />
            <span className="text-sm">Loading…</span>
          </div>
        ) : visibleEntries.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-editor-fg opacity-40 select-none">
            <span className="text-sm">Empty directory</span>
          </div>
        ) : (
          <ul className="py-1">
            {visibleEntries.map((entry) => {
              const isSelected =
                entry.kind === "file" && selectedFilePath === entry.path;
              const isCut =
                clipboard?.operation === "cut" && clipboard.path === entry.path;
              const statusColorClass = getEntryStatusColorClass(
                entry,
                sourceControlFiles
              );

              return (
                <li key={entry.path}>
                  <EntryRow
                    entry={entry}
                    isSelected={isSelected}
                    isCut={isCut}
                    statusColorClass={statusColorClass}
                    onClick={() => {
                      if (entry.kind === "directory") {
                        loadDirectory(entry.path);
                      } else {
                        openFile(entry.path);
                      }
                    }}
                    openContextMenu={openContextMenu}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );

  // ---------------------------------------------------------------------------
  // File editor column (right column on desktop; full-screen on mobile)
  // ---------------------------------------------------------------------------

  const fileEditorColumn = (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      {/* File toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-panel-border flex-shrink-0 min-h-9">
        {isMobile && (
          <button
            onClick={handleMobileBack}
            className="flex items-center gap-1 text-editor-fg hover:opacity-80 transition-opacity"
          >
            <i className="codicon codicon-arrow-left text-sm" />
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
                >
                  {fileSaving ? (
                    <i className="codicon codicon-loading animate-spin" />
                  ) : (
                    <i className="codicon codicon-save" />
                  )}
                  Save
                </button>
                {/* Undo / Redo merged control */}
                <div
                  className="fp-button-group"
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
                    <i className="codicon codicon-discard" />
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
                    <i className="codicon codicon-redo" />
                  </button>
                </div>
                {isMarkdownFile && (
                  <button
                    type="button"
                    onClick={() => setPreviewMode((p) => !p)}
                    aria-pressed={previewMode}
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
                    <i
                      className={`codicon ${previewMode ? "codicon-code" : "codicon-open-preview"}`}
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
                  <i className="codicon codicon-debug-restart" />
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
        <div className="flex-1 flex flex-col overflow-hidden">
          {fileLoading ? (
            <div className="flex items-center gap-2 p-4 opacity-50 text-editor-fg">
              <i className="codicon codicon-loading animate-spin" />
              <span className="text-sm">Loading file…</span>
            </div>
          ) : fileReadOnly ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 text-editor-fg opacity-70">
              <i className="codicon codicon-info text-2xl" />
              <p className="text-sm">
                {fileReadOnlyReason ?? "This file cannot be edited"}
              </p>
            </div>
          ) : (
            <div className="flex-1 overflow-hidden relative">
              {/* Editor stays mounted while previewing so undo history and
                  scroll position survive toggling back to edit mode. */}
              <div
                className={`h-full ${showPreview ? "hidden" : ""}`}
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
          {directoryListColumn}
        </Panel>
        <Separator className={SEPARATOR_VERTICAL} />
        <Panel id="workspace-explorer-editor-panel">{fileEditorColumn}</Panel>
      </Group>
      {explorerContextMenuPortal}
      {editorContextMenuPortal}
    </div>
  );
};
