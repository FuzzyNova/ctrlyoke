import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Modal, Button } from "../shared";
import { useUiStore } from "@store/uiStore";
import { extractExtensionsFromGlobs } from "@root/utils/fileFilterUtils";
import { usePagedWorkspaceDirectory } from "@hooks/usePagedWorkspaceDirectory";
import { useElementNarrow } from "@hooks/useElementNarrow";
import { VirtualizedPagedList } from "@components/shared";
import type { WorkspaceTreeEntry } from "@root/types/HostedWorkspaceViewerTypes";
import {
  DirectoryPageFailureNotice,
  EntryRow,
  FILE_BROWSER_NARROW_THRESHOLD,
  FileBrowserSortHeader,
  renderBreadcrumb,
} from "../workspace-viewer/fileBrowserShared";
import type { WorkspaceEntrySortKey } from "@root/types/HostedWorkspaceViewerTypes";
import { nextWorkspaceEntrySort } from "@utils/workspaceEntrySort";

const FILE_BROWSER_VIRTUALIZATION_THRESHOLD = 50;
const FILE_BROWSER_OVERSCAN = 12;
const FILE_BROWSER_ROW_ESTIMATE = 36;

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
  const workspaceEntrySort = useUiStore((s) => s.workspaceEntrySort);
  const setWorkspaceEntrySort = useUiStore((s) => s.setWorkspaceEntrySort);

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const rememberedDirectoryFallbackRef = useRef(false);
  const [narrowColumnRef, isNarrowColumnLayout] =
    useElementNarrow<HTMLDivElement>(FILE_BROWSER_NARROW_THRESHOLD);

  const mode = fileBrowserState?.mode;
  const initialDirectoryPath =
    fileBrowserState?.initialPath ?? fileBrowserLastDirectory ?? "";

  const directory = usePagedWorkspaceDirectory({
    path: initialDirectoryPath,
    includeGitIgnored: true,
    sort: workspaceEntrySort,
    sortAnchorPath: selectedFile ?? undefined,
    enabled: fileBrowserState !== null,
  });
  const navigateDirectory = directory.navigate;

  const handleSortKeyRequest = useCallback(
    (key: WorkspaceEntrySortKey) => {
      setWorkspaceEntrySort(nextWorkspaceEntrySort(workspaceEntrySort, key));
    },
    [setWorkspaceEntrySort, workspaceEntrySort]
  );

  // Extensions extracted from fileFilter globs; null means "no filter" (either
  // no filter was given, or the globs didn't reduce to plain extensions).
  const filterExts = useMemo(() => {
    if (mode !== "file" || !fileBrowserState?.fileFilter?.length) return null;
    const exts = extractExtensionsFromGlobs(fileBrowserState.fileFilter);
    return exts.length > 0 ? exts.map((e) => e.toLowerCase()) : null;
  }, [mode, fileBrowserState]);

  const matchesFilter = useCallback(
    (entry: WorkspaceTreeEntry): boolean => {
      if (!filterExts) return true;
      const dot = entry.name.lastIndexOf(".");
      if (dot < 0) return false;
      return filterExts.includes(entry.name.slice(dot + 1).toLowerCase());
    },
    [filterExts]
  );

  // Reset and load whenever a new request opens the modal.
  useEffect(() => {
    if (!fileBrowserState) {
      rememberedDirectoryFallbackRef.current = false;
      return;
    }
    setSelectedFile(null);
    rememberedDirectoryFallbackRef.current =
      fileBrowserState.initialPath === undefined &&
      fileBrowserLastDirectory !== null &&
      initialDirectoryPath !== "";
    // Intentional: only reset selection when a new request opens the modal,
    // not when a paged directory response arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileBrowserState, fileBrowserLastDirectory]);

  useEffect(() => {
    if (
      !fileBrowserState ||
      !rememberedDirectoryFallbackRef.current ||
      !directory.initialError
    ) {
      return;
    }
    rememberedDirectoryFallbackRef.current = false;
    navigateDirectory("");
  }, [directory.initialError, fileBrowserState, navigateDirectory]);

  const handleCancel = useCallback(() => {
    closeFileBrowser();
  }, [closeFileBrowser]);

  const handleConfirm = useCallback(() => {
    if (!fileBrowserState) return;
    if (fileBrowserState.mode === "file") {
      if (!selectedFile) return;
      setFileBrowserLastDirectory(directory.path);
      fileBrowserState.onSelect(selectedFile);
    } else {
      setFileBrowserLastDirectory(directory.path);
      fileBrowserState.onSelect(directory.path);
    }
    closeFileBrowser();
  }, [
    fileBrowserState,
    selectedFile,
    directory.path,
    setFileBrowserLastDirectory,
    closeFileBrowser,
  ]);

  const handleEntryClick = useCallback(
    (entry: WorkspaceTreeEntry) => {
      if (entry.kind === "directory") {
        navigateDirectory(entry.path);
        return;
      }
      if (mode === "file" && matchesFilter(entry)) {
        setSelectedFile(entry.path);
      }
    },
    [matchesFilter, mode, navigateDirectory]
  );

  const handleBack = useCallback(() => {
    if (directory.parentPath !== null) navigateDirectory(directory.parentPath);
  }, [directory.parentPath, navigateDirectory]);

  if (!fileBrowserState) return null;

  const isDirectoryMode = mode === "directory";
  const canConfirm = isDirectoryMode ? true : !!selectedFile;
  const title =
    fileBrowserState.title ??
    (isDirectoryMode ? "Select Folder" : "Select File");
  const statusText = isDirectoryMode
    ? directory.path || "(workspace root)"
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
      <div ref={narrowColumnRef} className="space-y-3">
        <div className="flex items-center gap-1 px-1 py-1 border-b border-panel-border">
          <button
            onClick={handleBack}
            disabled={directory.parentPath === null}
            className={`flex items-center justify-center w-6 h-6 rounded transition-colors flex-shrink-0 ${
              directory.parentPath === null
                ? "opacity-30 cursor-default"
                : "hover:bg-btn-secondary-hover text-editor-fg"
            }`}
            title="Go to parent directory"
            aria-label="Go to parent directory"
          >
            <i className="codicon codicon-arrow-left text-xs" />
          </button>
          <div className="flex-1 min-w-0 flex flex-wrap items-center px-1">
            {renderBreadcrumb(directory.path, directory.rootLabel, (p) =>
              directory.navigate(p)
            )}
          </div>
        </div>

        <FileBrowserSortHeader
          sort={workspaceEntrySort}
          onSortKeyRequest={handleSortKeyRequest}
          isNarrow={isNarrowColumnLayout}
          scrollContainerRef={scrollContainerRef}
        />

        <div
          ref={scrollContainerRef}
          data-testid="file-browser-directory-list"
          className="h-72 overflow-y-auto rounded border border-panel-border"
          aria-busy={directory.isLoading}
        >
          {directory.isInitialLoading ? (
            <div className="flex items-center justify-center py-8 text-editor-fg opacity-50">
              <i className="codicon codicon-loading animate-spin mr-2" />
              <span className="text-sm">Loading…</span>
            </div>
          ) : directory.initialError ? (
            <div className="flex items-center justify-center gap-2 px-3 py-8 text-sm text-warning-fg">
              <span>{directory.initialError.message}</span>
              <Button variant="secondary" onClick={directory.retryInitial}>
                Retry
              </Button>
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
                  const isNonMatchingFile =
                    !isDirectoryMode &&
                    entry.kind === "file" &&
                    !matchesFilter(entry);
                  const isUnselectableFile =
                    isDirectoryMode && entry.kind === "file";
                  const isUnselectable =
                    isNonMatchingFile || isUnselectableFile;
                  return (
                    <div
                      role="listitem"
                      className={isUnselectable ? "opacity-40" : undefined}
                    >
                      <EntryRow
                        entry={entry}
                        isSelected={
                          !isDirectoryMode && selectedFile === entry.path
                        }
                        disabled={isUnselectable}
                        statusColorClass={undefined}
                        onClick={() => handleEntryClick(entry)}
                        isNarrow={isNarrowColumnLayout}
                      />
                    </div>
                  );
                }}
                renderPlaceholder={(index) => {
                  return (
                    <div
                      role="listitem"
                      className="min-h-[44px] animate-pulse px-3 py-2"
                      aria-label={`Loading entry ${index + 1}`}
                    >
                      <span className="block h-4 w-2/3 rounded bg-panel-border opacity-50" />
                    </div>
                  );
                }}
                scrollContainerRef={scrollContainerRef}
                estimateItemSize={() => FILE_BROWSER_ROW_ESTIMATE}
                overscan={FILE_BROWSER_OVERSCAN}
                threshold={FILE_BROWSER_VIRTUALIZATION_THRESHOLD}
                onRangeChange={directory.onRangeChange}
                layoutResetKey={directory.listingId ?? undefined}
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
            <p className="px-1 text-xs text-description-fg" aria-live="polite">
              Loaded {directory.uniqueLoadedCount.toLocaleString()} of{" "}
              {directory.totalCount.toLocaleString()}
              {directory.pageLoading ? " …" : ""}
            </p>
          )}

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
