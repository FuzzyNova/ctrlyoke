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
import type { WorkspaceEntry } from "@root/types/HostedWorkspaceViewerTypes";
import { PROMPT_EDITOR_INSERT_MODES } from "@/types/messages";

export interface WorkspaceClipboard {
  operation: "copy" | "cut";
  path: string;
  kind: "file" | "directory";
}

export interface UseWorkspaceExplorerContextMenuOptions {
  explorerPath: string;
  onRefresh: () => void;
  onOpenFile: (path: string) => void;
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
  onRefresh,
  onOpenFile,
}: UseWorkspaceExplorerContextMenuOptions) {
  const [clipboard, setClipboard] = useState<WorkspaceClipboard | null>(null);
  const [contextMenu, setContextMenu] = useState<StepContextMenuState | null>(
    null
  );

  const handleAddToFlightPath = useCallback((entry: WorkspaceEntry) => {
    const ref =
      entry.kind === "directory" ? buildDirRef(entry.path) : buildFileRef(entry.path);
    const editorStore = useEditorStore.getState();
    editorStore.preparePromptEditorForInsert();
    editorStore.enqueuePromptEditorInsert({
      requestId: `workspace-explorer-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      references: [ref],
      mode: PROMPT_EDITOR_INSERT_MODES.APPEND,
    });
  }, []);

  const handleDelete = useCallback(
    async (path: string) => {
      try {
        await workspaceDeleteEntry({ path });
        onRefresh();
      } catch (err) {
        console.error("Delete failed:", err);
      }
    },
    [onRefresh]
  );

  const handlePaste = useCallback(async () => {
    if (!clipboard) return;
    const destDir = explorerPath;
    try {
      if (clipboard.operation === "cut") {
        await workspaceMoveEntry({ sourcePath: clipboard.path, destDir });
        setClipboard(null);
      } else {
        await workspaceCopyEntry({ sourcePath: clipboard.path, destDir });
      }
      onRefresh();
      if (clipboard.kind === "file") {
        onOpenFile(buildPastedFilePath(clipboard.path, destDir));
      }
    } catch (err) {
      console.error("Paste failed:", err);
    }
  }, [clipboard, explorerPath, onOpenFile, onRefresh]);

  const openContextMenu = useCallback(
    (x: number, y: number, entry: WorkspaceEntry) => {
      const addLabel =
        entry.kind === "file"
          ? "Add File to FlightPath"
          : "Add Directory to FlightPath";

      setContextMenu({
        x,
        y,
        items: [
          {
            label: "Cut",
            icon: "codicon-scissors",
            disabled: false,
            onClick: () => {
              setClipboard({
                operation: "cut",
                path: entry.path,
                kind: entry.kind,
              });
            },
          },
          {
            label: "Copy",
            icon: "codicon-copy",
            disabled: false,
            onClick: () => {
              setClipboard({
                operation: "copy",
                path: entry.path,
                kind: entry.kind,
              });
            },
          },
          {
            label: "Paste",
            icon: "codicon-clippy",
            disabled: clipboard === null,
            disabledTitle: clipboard === null ? "Nothing to paste" : undefined,
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
              handleAddToFlightPath(entry);
            },
          },
          { type: "divider" },
          {
            label: "Delete",
            icon: "codicon-trash",
            disabled: entry.path.length === 0,
            disabledTitle:
              entry.path.length === 0 ? "Cannot delete workspace root" : undefined,
            onClick: () => {
              if (!entry.path) return;
              void handleDelete(entry.path);
            },
          },
        ],
      });
    },
    [clipboard, handleAddToFlightPath, handleDelete, handlePaste]
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
