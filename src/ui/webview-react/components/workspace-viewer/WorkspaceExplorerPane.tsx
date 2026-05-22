import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { useSettingsStore } from "@store/settingsStore";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { MESSAGE_TYPES, SETTING_SCOPES } from "@/types/messages";
import {
  workspaceTree,
  workspaceFile,
  workspaceSaveFile,
} from "@utils/hostedApi";
import { useIsMobile } from "@hooks/useMediaQuery";
import {
  WorkspaceFileEditor,
  type WorkspaceFileEditorHandle,
} from "./WorkspaceFileEditor";

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
  const selectedFilePath = useWorkspaceViewerStore((s) => s.selectedFilePath);
  const fileContent = useWorkspaceViewerStore((s) => s.fileContent);
  const fileDirty = useWorkspaceViewerStore((s) => s.fileDirty);
  const fileLoading = useWorkspaceViewerStore((s) => s.fileLoading);
  const fileSaving = useWorkspaceViewerStore((s) => s.fileSaving);
  const fileReadOnly = useWorkspaceViewerStore((s) => s.fileReadOnly);
  const fileReadOnlyReason = useWorkspaceViewerStore(
    (s) => s.fileReadOnlyReason
  );
  const mobileEditorVisible = useWorkspaceViewerStore(
    (s) => s.mobileEditorVisible
  );
  const selectFile = useWorkspaceViewerStore((s) => s.selectFile);
  const setFileContent = useWorkspaceViewerStore((s) => s.setFileContent);
  const setLoadedFileContent = useWorkspaceViewerStore(
    (s) => s.setLoadedFileContent
  );
  const discardFileDraft = useWorkspaceViewerStore((s) => s.discardFileDraft);
  const markFileSaved = useWorkspaceViewerStore((s) => s.markFileSaved);
  const setFileLoading = useWorkspaceViewerStore((s) => s.setFileLoading);
  const setFileSaving = useWorkspaceViewerStore((s) => s.setFileSaving);
  const setFileReadOnly = useWorkspaceViewerStore((s) => s.setFileReadOnly);
  const setMobileEditorVisible = useWorkspaceViewerStore(
    (s) => s.setMobileEditorVisible
  );
  const setError = useWorkspaceViewerStore((s) => s.setError);

  const pendingNavigation = useWorkspaceViewerStore((s) => s.pendingNavigation);
  const clearPendingNavigation = useWorkspaceViewerStore(
    (s) => s.clearPendingNavigation
  );

  // Holds a line selection to apply once the next file finishes loading
  const pendingSelectionRef = useRef<{
    startLine: number;
    endLine: number;
  } | null>(null);

  const showHiddenFiles = useSettingsStore(
    (s) => s.globalSettings.showHiddenFiles
  );
  const showHiddenFilesScope = useSettingsStore((s) =>
    s.globalSettings.settingSources["ui.showHiddenFiles"] ===
    SETTING_SCOPES.WORKSPACE
      ? SETTING_SCOPES.WORKSPACE
      : SETTING_SCOPES.USER
  );
  const vscode = useVsCodeApi();

  const isMobile = useIsMobile();

  const editorRef = useRef<WorkspaceFileEditorHandle>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Nav metadata kept in local state — not needed globally
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [rootLabel, setRootLabel] = useState<string>("");

  const visibleEntries = useMemo(
    () =>
      showHiddenFiles
        ? explorerEntries
        : explorerEntries.filter((entry) => !entry.name.startsWith(".")),
    [explorerEntries, showHiddenFiles]
  );

  const loadDirectory = useCallback(
    async (dirPath: string) => {
      setExplorerLoading(true);
      try {
        const result = await workspaceTree(dirPath);
        setExplorerEntries(result.entries);
        setExplorerPath(result.path);
        setParentPath(result.parentPath);
        setRootLabel(result.rootLabel);
      } catch (err) {
        setError(String(err));
      } finally {
        setExplorerLoading(false);
      }
    },
    [setExplorerLoading, setExplorerEntries, setExplorerPath, setError]
  );

  // Load root on mount, unless a pending navigation will handle it
  useEffect(() => {
    if (!useWorkspaceViewerStore.getState().pendingNavigation) {
      loadDirectory(explorerPath);
    }
    // Intentional: run once on mount; navigation is explicit through loadDirectory calls
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openFile = useCallback(
    async (filePath: string) => {
      setFileLoading(true);
      selectFile(filePath);
      if (isMobile) setMobileEditorVisible(true);
      try {
        const result = await workspaceFile(filePath);
        if (result.readOnly) {
          setFileReadOnly(true, result.reason);
        } else {
          setFileReadOnly(false);
          setLoadedFileContent(filePath, result.content);
        }
      } catch (err) {
        setError(String(err));
      } finally {
        setFileLoading(false);
      }
    },
    [
      isMobile,
      selectFile,
      setFileLoading,
      setLoadedFileContent,
      setFileReadOnly,
      setMobileEditorVisible,
      setError,
    ]
  );

  // Consume pending navigation set externally (e.g. from CodeMirror link clicks)
  useEffect(() => {
    if (!pendingNavigation) return;
    clearPendingNavigation();
    if (pendingNavigation.type === "directory") {
      loadDirectory(pendingNavigation.dirPath);
    } else {
      const { filePath, startLine, endLine } = pendingNavigation;
      if (startLine !== undefined && endLine !== undefined) {
        pendingSelectionRef.current = { startLine, endLine };
      }
      openFile(filePath);
    }
  }, [pendingNavigation, clearPendingNavigation, loadDirectory, openFile]);

  // Apply pending line selection once file loading completes
  useEffect(() => {
    if (fileLoading) return;
    const sel = pendingSelectionRef.current;
    if (!sel) return;
    pendingSelectionRef.current = null;
    requestAnimationFrame(() => {
      editorRef.current?.selectLines(sel.startLine, sel.endLine);
    });
  }, [fileLoading]);

  const handleBack = useCallback(() => {
    if (parentPath !== null) {
      loadDirectory(parentPath);
    }
  }, [parentPath, loadDirectory]);

  const handleRefresh = useCallback(() => {
    loadDirectory(explorerPath);
  }, [explorerPath, loadDirectory]);

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

  // Build breadcrumb segments from the current explorerPath.
  // Handles both forward-slash and backslash separators.
  const renderBreadcrumb = () => {
    const sep = explorerPath.includes("\\") ? "\\" : "/";
    const segments = explorerPath
      ? explorerPath.split(/[/\\]/).filter(Boolean)
      : [];
    const crumbs: React.ReactNode[] = [
      <button
        key="root"
        onClick={() => loadDirectory("")}
        className="max-w-full truncate whitespace-nowrap hover:underline text-editor-fg opacity-70 hover:opacity-100 text-xs"
        title="Go to workspace root"
      >
        {rootLabel || "workspace"}
      </button>,
    ];

    segments.forEach((segment, i) => {
      const segPath = segments.slice(0, i + 1).join(sep);
      const isLast = i === segments.length - 1;
      crumbs.push(
        <span
          key={`sep-${i}`}
          className="whitespace-nowrap opacity-40 text-xs mx-0.5 select-none"
        >
          /
        </span>
      );
      if (isLast) {
        crumbs.push(
          <span
            key={segPath}
            className="max-w-full truncate whitespace-nowrap text-editor-fg text-xs font-medium"
          >
            {segment}
          </span>
        );
      } else {
        crumbs.push(
          <button
            key={segPath}
            onClick={() => loadDirectory(segPath)}
            className="max-w-full truncate whitespace-nowrap hover:underline text-editor-fg opacity-70 hover:opacity-100 text-xs"
          >
            {segment}
          </button>
        );
      }
    });

    return crumbs;
  };

  // ---------------------------------------------------------------------------
  // Directory list (left column / mobile default view)
  // ---------------------------------------------------------------------------

  const directoryListColumn = (
    <div className="flex flex-col h-full w-full sm:w-64 sm:flex-shrink-0 border-r border-panel-border overflow-hidden">
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
            {renderBreadcrumb()}
          </div>
        </div>

        <button
          onClick={() =>
            vscode.postMessage({
              type: MESSAGE_TYPES.UPDATE_GLOBAL_SETTING,
              path: "ui.showHiddenFiles",
              value: !showHiddenFiles,
              scope: showHiddenFilesScope,
            })
          }
          className={`flex items-center justify-center w-6 h-6 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 rounded transition-colors flex-shrink-0 ${
            showHiddenFiles
              ? "hover:bg-btn-secondary-hover text-editor-fg"
              : "hover:bg-btn-secondary-hover text-editor-fg opacity-40"
          }`}
          title={showHiddenFiles ? "Hide dotfiles" : "Show dotfiles"}
          aria-label={showHiddenFiles ? "Hide dotfiles" : "Show dotfiles"}
        >
          <i
            className={`codicon ${showHiddenFiles ? "codicon-eye" : "codicon-eye-closed"} text-xs`}
          />
        </button>

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
              return (
                <li key={entry.path}>
                  <button
                    onClick={() => {
                      if (entry.kind === "directory") {
                        loadDirectory(entry.path);
                      } else {
                        openFile(entry.path);
                      }
                    }}
                    className={`w-full flex items-center gap-1.5 px-3 py-1 min-h-[44px] sm:min-h-0 text-sm text-left transition-colors ${
                      isSelected
                        ? "bg-list-active-bg text-editor-fg"
                        : "text-editor-fg hover:bg-btn-secondary-hover"
                    }`}
                    title={entry.path}
                  >
                    <i
                      className={`codicon flex-shrink-0 text-sm ${
                        entry.kind === "directory"
                          ? "codicon-folder text-[var(--status-warning)]"
                          : "codicon-file"
                      }`}
                    />
                    <span className="truncate">
                      {entry.name}
                      {entry.kind === "directory" ? "/" : ""}
                    </span>
                  </button>
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
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-panel-border flex-shrink-0 min-h-[2.25rem]">
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
            <WorkspaceFileEditor
              ref={editorRef}
              filePath={selectedFilePath}
              content={fileContent}
              onChange={(newContent) => setFileContent(newContent)}
              onSave={handleSave}
              saving={fileSaving}
              onUndoRedoChange={handleUndoRedoChange}
            />
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
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      {directoryListColumn}
      {fileEditorColumn}
    </div>
  );
};
