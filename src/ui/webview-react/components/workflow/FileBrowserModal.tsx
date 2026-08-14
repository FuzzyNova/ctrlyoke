import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, Button } from "../shared";
import { useUiStore } from "@store/uiStore";
import { workspaceTree } from "@utils/hostedApi";
import { extractExtensionsFromGlobs } from "@root/utils/fileFilterUtils";
import type { WorkspaceEntry } from "@root/types/HostedWorkspaceViewerTypes";
import {
  EntryRow,
  renderBreadcrumb,
} from "../workspace-viewer/fileBrowserShared";

/**
 * FileBrowserModal - web-native file/directory picker for the hosted
 * dashboard, where the native OS `showOpenDialog` can't reach the browser
 * user. Single canonical instance driven entirely by `uiStore.fileBrowserState`
 * (see MODAL_FILE_BROWSER_PLAN.md); renders nothing when that state is null.
 */
export const FileBrowserModal: React.FC = () => {
  const fileBrowserState = useUiStore((s) => s.fileBrowserState);
  const fileBrowserLastDirectory = useUiStore(
    (s) => s.fileBrowserLastDirectory
  );
  const closeFileBrowser = useUiStore((s) => s.closeFileBrowser);
  const setFileBrowserLastDirectory = useUiStore(
    (s) => s.setFileBrowserLastDirectory
  );

  const [path, setPath] = useState("");
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [rootLabel, setRootLabel] = useState("");
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const mode = fileBrowserState?.mode;

  // Extensions extracted from fileFilter globs; null means "no filter" (either
  // no filter was given, or the globs didn't reduce to plain extensions).
  const filterExts = useMemo(() => {
    if (mode !== "file" || !fileBrowserState?.fileFilter?.length) return null;
    const exts = extractExtensionsFromGlobs(fileBrowserState.fileFilter);
    return exts.length > 0 ? exts.map((e) => e.toLowerCase()) : null;
  }, [mode, fileBrowserState]);

  const matchesFilter = useCallback(
    (entry: WorkspaceEntry): boolean => {
      if (!filterExts) return true;
      const dot = entry.name.lastIndexOf(".");
      if (dot < 0) return false;
      return filterExts.includes(entry.name.slice(dot + 1).toLowerCase());
    },
    [filterExts]
  );

  const loadDirectory = useCallback(async (dirPath: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await workspaceTree(dirPath);
      const fwd = (p: string) => p.replace(/\\/g, "/");
      setEntries(result.entries.map((e) => ({ ...e, path: fwd(e.path) })));
      setPath(fwd(result.path));
      setParentPath(result.parentPath !== null ? fwd(result.parentPath) : null);
      setRootLabel(result.rootLabel);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  // Reset and load whenever a new request opens the modal.
  useEffect(() => {
    if (!fileBrowserState) return;
    setSelectedFile(null);
    setError(null);
    const initialPath =
      fileBrowserState.initialPath ?? fileBrowserLastDirectory ?? "";
    const shouldFallbackToRoot =
      fileBrowserState.initialPath === undefined &&
      fileBrowserLastDirectory !== null &&
      initialPath !== "";
    void (async () => {
      const loaded = await loadDirectory(initialPath);
      if (!loaded && shouldFallbackToRoot) {
        await loadDirectory("");
      }
    })();
    // Intentional: only re-run when a new request object opens the modal,
    // not on every loadDirectory identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileBrowserState, fileBrowserLastDirectory]);

  const handleCancel = useCallback(() => {
    closeFileBrowser();
  }, [closeFileBrowser]);

  const handleConfirm = useCallback(() => {
    if (!fileBrowserState) return;
    if (fileBrowserState.mode === "file") {
      if (!selectedFile) return;
      setFileBrowserLastDirectory(path);
      fileBrowserState.onSelect(selectedFile);
    } else {
      setFileBrowserLastDirectory(path);
      fileBrowserState.onSelect(path);
    }
    closeFileBrowser();
  }, [
    fileBrowserState,
    selectedFile,
    path,
    setFileBrowserLastDirectory,
    closeFileBrowser,
  ]);

  const handleEntryClick = useCallback(
    (entry: WorkspaceEntry) => {
      if (entry.kind === "directory") {
        void loadDirectory(entry.path);
        return;
      }
      if (mode === "file" && matchesFilter(entry)) {
        setSelectedFile(entry.path);
      }
    },
    [mode, matchesFilter, loadDirectory]
  );

  const handleBack = useCallback(() => {
    if (parentPath !== null) void loadDirectory(parentPath);
  }, [parentPath, loadDirectory]);

  if (!fileBrowserState) return null;

  const isDirectoryMode = mode === "directory";
  const canConfirm = isDirectoryMode ? true : !!selectedFile;
  const title =
    fileBrowserState.title ??
    (isDirectoryMode ? "Select Folder" : "Select File");
  const statusText = isDirectoryMode
    ? path || "(workspace root)"
    : (selectedFile ?? "No file selected");

  return (
    <Modal
      isOpen
      onClose={handleCancel}
      title={title}
      size="lg"
      footer={
        <div className="flex items-center justify-between w-full gap-3 min-w-0">
          <span
            className="text-xs text-description-fg truncate"
            title={statusText}
          >
            {statusText}
          </span>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button variant="secondary" onClick={handleCancel}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleConfirm}
              disabled={!canConfirm}
            >
              {isDirectoryMode ? "Select Folder" : "Select File"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-1 px-1 py-1 border-b border-panel-border">
          <button
            onClick={handleBack}
            disabled={parentPath === null}
            className={`flex items-center justify-center w-6 h-6 rounded transition-colors flex-shrink-0 ${
              parentPath === null
                ? "opacity-30 cursor-default"
                : "hover:bg-btn-secondary-hover text-editor-fg"
            }`}
            title="Go to parent directory"
            aria-label="Go to parent directory"
          >
            <i className="codicon codicon-arrow-left text-xs" />
          </button>
          <div className="flex-1 min-w-0 flex flex-wrap items-center px-1">
            {renderBreadcrumb(path, rootLabel, (p) => void loadDirectory(p))}
          </div>
        </div>

        <div className="h-72 overflow-y-auto rounded border border-panel-border">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-editor-fg opacity-50">
              <i className="codicon codicon-loading animate-spin mr-2" />
              <span className="text-sm">Loading…</span>
            </div>
          ) : error ? (
            <div className="px-3 py-2 text-sm text-warning-fg">{error}</div>
          ) : entries.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-editor-fg opacity-40 select-none">
              <span className="text-sm">Empty directory</span>
            </div>
          ) : (
            <ul className="py-1">
              {entries.map((entry) => {
                const isNonMatchingFile =
                  !isDirectoryMode &&
                  entry.kind === "file" &&
                  !matchesFilter(entry);
                const isUnselectableFile =
                  isDirectoryMode && entry.kind === "file";
                return (
                  <li
                    key={entry.path}
                    className={
                      isNonMatchingFile || isUnselectableFile
                        ? "opacity-40"
                        : undefined
                    }
                  >
                    <EntryRow
                      entry={entry}
                      isSelected={
                        !isDirectoryMode && selectedFile === entry.path
                      }
                      statusColorClass={undefined}
                      onClick={() => {
                        if (isUnselectableFile) return;
                        handleEntryClick(entry);
                      }}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {isDirectoryMode && (
          <p className="text-xs text-description-fg">
            Navigate into a folder, then click "Select Folder" to choose the
            current directory.
          </p>
        )}
      </div>
    </Modal>
  );
};
