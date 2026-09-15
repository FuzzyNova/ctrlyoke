import { useCallback, useState } from "react";
import {
  StepContextMenu,
  type StepContextMenuState,
} from "@components/shared/StepContextMenu";
import { useEditorStore } from "@store/editorStore";
import {
  workspaceCopyEntry,
  workspaceDeleteEntry,
  workspaceMoveEntry,
} from "@utils/hostedApi";
import { WebviewLog } from "@utils/logger";
import type { WorkspaceEntry } from "@root/types/HostedWorkspaceViewerTypes";
import { PROMPT_EDITOR_INSERT_MODES } from "@/types/messages";
import {
  CLIPBOARD_OPERATIONS,
  WORKSPACE_ENTRY_KINDS,
} from "@root/types/DashboardConstants";

export interface WorkspaceClipboard {
  operation: (typeof CLIPBOARD_OPERATIONS)[keyof typeof CLIPBOARD_OPERATIONS];
  path: string;
  kind:
    typeof WORKSPACE_ENTRY_KINDS.FILE | typeof WORKSPACE_ENTRY_KINDS.DIRECTORY;
}

export interface UseWorkspaceExplorerContextMenuOptions {
  explorerPath: string;
  /**
   * True when the current directory listing is the virtual top level of a
   * multi-root workspace (one entry per root folder). Cut/Copy/Delete/Paste
   * are disabled in that view since each entry represents an entire
   * workspace root, not a real file or subdirectory.
   */
  isRootsList: boolean;
  onRefresh: (affectedPath?: string) => void;
  onOpenFile: (path: string) => void;
  onViewFileHistory: (path: string) => void;
}

function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function buildFileRef(path: string): string {
  return path.includes(" ") ? `@"${path}"` : `@${path}`;
}

function buildDirRef(path: string): string {
  const p = path.endsWith("/") ? path : `${path}/`;
  return p.includes(" ") ? `@"${p}"` : `@${p}`;
}

function buildPastedFilePath(sourcePath: string, destDir: string): string {
  const normalizedSourcePath = sourcePath.replace(/\\/g, "/");
  const normalizedDestDir = destDir.replace(/\\/g, "/").replace(/\/$/, "");
  const baseName = normalizedSourcePath.slice(
    normalizedSourcePath.lastIndexOf("/") + 1
  );
  return normalizedDestDir ? `${normalizedDestDir}/${baseName}` : baseName;
}

export function useWorkspaceExplorerContextMenu({
  explorerPath,
  isRootsList,
  onRefresh,
  onOpenFile,
  onViewFileHistory,
}: UseWorkspaceExplorerContextMenuOptions) {
  const [clipboard, setClipboard] = useState<WorkspaceClipboard | null>(null);
  const [contextMenu, setContextMenu] = useState<StepContextMenuState | null>(
    null
  );

  const handleAddToCtrlYoke = useCallback((entry: WorkspaceEntry) => {
    const ref =
      entry.kind === WORKSPACE_ENTRY_KINDS.DIRECTORY
        ? buildDirRef(entry.path)
        : buildFileRef(entry.path);
    const editorStore = useEditorStore.getState();
    editorStore.preparePromptEditorForInsert();
    editorStore.enqueuePromptEditorInsert({
      requestId: `workspace-explorer-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      references: [ref],
      mode: PROMPT_EDITOR_INSERT_MODES.APPEND,
    });
  }, []);

  const handleViewFileHistory = useCallback(
    (entry: WorkspaceEntry) => {
      if (entry.kind !== WORKSPACE_ENTRY_KINDS.FILE) return;
      onViewFileHistory(normalizeWorkspacePath(entry.path));
    },
    [onViewFileHistory]
  );

  const handleDelete = useCallback(
    async (path: string) => {
      try {
        await workspaceDeleteEntry({ path });
        onRefresh(path);
      } catch (err) {
        WebviewLog.error(
          "[useWorkspaceExplorerContextMenu] Delete failed:",
          err
        );
      }
    },
    [onRefresh]
  );

  const handlePaste = useCallback(async () => {
    if (!clipboard || isRootsList) return;
    const destDir = explorerPath;
    try {
      if (clipboard.operation === CLIPBOARD_OPERATIONS.CUT) {
        await workspaceMoveEntry({ sourcePath: clipboard.path, destDir });
        setClipboard(null);
      } else {
        await workspaceCopyEntry({ sourcePath: clipboard.path, destDir });
      }
      onRefresh(
        clipboard.kind === WORKSPACE_ENTRY_KINDS.FILE
          ? buildPastedFilePath(clipboard.path, destDir)
          : destDir
      );
      if (clipboard.kind === WORKSPACE_ENTRY_KINDS.FILE) {
        onOpenFile(buildPastedFilePath(clipboard.path, destDir));
      }
    } catch (err) {
      WebviewLog.error("[useWorkspaceExplorerContextMenu] Paste failed:", err);
    }
  }, [clipboard, explorerPath, isRootsList, onOpenFile, onRefresh]);

  const openContextMenu = useCallback(
    (x: number, y: number, entry: WorkspaceEntry) => {
      const addLabel =
        entry.kind === WORKSPACE_ENTRY_KINDS.FILE
          ? "Add File to ctrlyoke"
          : "Add Directory to ctrlyoke";
      const rootDisabledTitle = isRootsList
        ? "Cannot modify a workspace root folder"
        : undefined;

      setContextMenu({
        x,
        y,
        items: [
          {
            label: "Cut",
            icon: "codicon-screen-cut",
            disabled: isRootsList,
            disabledTitle: rootDisabledTitle,
            onClick: () => {
              setClipboard({
                operation: CLIPBOARD_OPERATIONS.CUT,
                path: entry.path,
                kind: entry.kind,
              });
            },
          },
          {
            label: "Copy",
            icon: "codicon-copy",
            disabled: isRootsList,
            disabledTitle: rootDisabledTitle,
            onClick: () => {
              setClipboard({
                operation: CLIPBOARD_OPERATIONS.COPY,
                path: entry.path,
                kind: entry.kind,
              });
            },
          },
          {
            label: "Paste",
            icon: "codicon-clippy",
            disabled: clipboard === null || isRootsList,
            disabledTitle: isRootsList
              ? rootDisabledTitle
              : clipboard === null
                ? "Nothing to paste"
                : undefined,
            onClick: () => {
              void handlePaste();
            },
          },
          { type: "divider" },
          {
            label: addLabel,
            icon: "codicon-add",
            disabled: false,
            onClick: () => {
              handleAddToCtrlYoke(entry);
            },
          },
          ...(entry.kind === WORKSPACE_ENTRY_KINDS.FILE
            ? [
                {
                  label: "View File History",
                  icon: "codicon-history",
                  disabled: false,
                  onClick: () => handleViewFileHistory(entry),
                },
              ]
            : []),
          { type: "divider" },
          {
            label: "Delete",
            icon: "codicon-trash",
            disabled: entry.path.length === 0 || isRootsList,
            disabledTitle:
              entry.path.length === 0
                ? "Cannot delete workspace root"
                : rootDisabledTitle,
            onClick: () => {
              if (!entry.path) return;
              void handleDelete(entry.path);
            },
          },
        ],
      });
    },
    [
      clipboard,
      handleAddToCtrlYoke,
      handleDelete,
      handlePaste,
      handleViewFileHistory,
      isRootsList,
    ]
  );

  const explorerContextMenuPortal = contextMenu ? (
    <StepContextMenu {...contextMenu} onClose={() => setContextMenu(null)} />
  ) : null;

  return {
    clipboard,
    openContextMenu,
    explorerContextMenuPortal,
  };
}
