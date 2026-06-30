import { useCallback, useState, type ReactNode, type RefObject } from "react";
import {
  StepContextMenu,
  type StepContextMenuEntry,
  type StepContextMenuState,
} from "@components/shared/StepContextMenu";
import { type WorkspaceFileEditorHandle } from "@components/workspace-viewer/WorkspaceFileEditor";
import { useLongPress } from "@hooks/useLongPress";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { useEditorStore } from "@store/editorStore";
import { writeClipboardText } from "@utils/stepClipboard";
import { MESSAGE_TYPES, PROMPT_EDITOR_INSERT_MODES } from "@/types/messages";

const PROMPT_FILE_RE = /\.(ctrlyoke\.(yaml|yml|json)|prompt\.md)$/i;

function isPromptFile(path: string | null): boolean {
  return path ? PROMPT_FILE_RE.test(path) : false;
}

function buildSelectionRef(
  path: string,
  startLine: number,
  endLine: number
): string {
  return path.includes(" ")
    ? `#selection:"${path}":${startLine}-${endLine}`
    : `#selection:${path}:${startLine}-${endLine}`;
}

function buildFileRef(path: string): string {
  return path.includes(" ") ? `@"${path}"` : `@${path}`;
}

function enqueuePromptEditorReference(reference: string): void {
  const store = useEditorStore.getState();
  store.preparePromptEditorForInsert();
  store.enqueuePromptEditorInsert({
    requestId: `workspace-editor-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    references: [reference],
    mode: PROMPT_EDITOR_INSERT_MODES.APPEND,
  });
}

interface UseWorkspaceEditorContextMenuOptions {
  editorRef: RefObject<WorkspaceFileEditorHandle | null>;
  filePath: string | null;
  onRequestSave?: () => void;
}

interface UseWorkspaceEditorContextMenuResult {
  openContextMenu: (x: number, y: number) => void;
  editorContextMenuPortal: ReactNode;
  editorLongPressHandlers: ReturnType<typeof useLongPress>;
}

export function useWorkspaceEditorContextMenu({
  editorRef,
  filePath,
}: UseWorkspaceEditorContextMenuOptions): UseWorkspaceEditorContextMenuResult {
  const vscode = useVsCodeApi();
  const [contextMenu, setContextMenu] = useState<StepContextMenuState | null>(
    null
  );

  const openContextMenu = useCallback(
    (x: number, y: number) => {
      const selectionText = editorRef.current?.getSelectionText() ?? "";
      const selectionRange = editorRef.current?.getSelectionRange();
      const hasSelection = selectionText.length > 0;
      const promptFile = isPromptFile(filePath);

      const items: StepContextMenuEntry[] = [
        {
          label: "Cut",
          icon: "codicon-screen-cut",
          disabled: !hasSelection,
          disabledTitle: "No text selected",
          onClick: () => {
            if (!selectionText) return;
            if (document.queryCommandSupported?.("cut")) {
              const didCut = document.execCommand("cut");
              if (didCut) {
                return;
              }
            }
            void writeClipboardText(selectionText);
          },
        },
        {
          label: "Copy",
          icon: "codicon-copy",
          disabled: !hasSelection,
          disabledTitle: "No text selected",
          onClick: () => {
            if (!selectionText) return;
            void writeClipboardText(selectionText);
          },
        },
        { type: "divider" },
        {
          label: "Add Selection to ctrlyoke",
          icon: "codicon-add",
          disabled: !hasSelection || !filePath,
          disabledTitle: !filePath ? "No file open" : "No text selected",
          onClick: () => {
            if (!filePath || !selectionRange) return;
            enqueuePromptEditorReference(
              buildSelectionRef(
                filePath,
                selectionRange.startLine,
                selectionRange.endLine
              )
            );
          },
        },
        {
          label: "Add File to ctrlyoke",
          icon: "codicon-add",
          disabled: !filePath,
          disabledTitle: "No file open",
          onClick: () => {
            if (!filePath) return;
            enqueuePromptEditorReference(buildFileRef(filePath));
          },
        },
      ];

      if (promptFile && filePath) {
        items.push(
          { type: "divider" },
          {
            label: "Run Workflow",
            icon: "codicon-play",
            disabled: false,
            onClick: () => {
              vscode.postMessage({
                type: MESSAGE_TYPES.LOAD_WORKFLOW,
                filePath,
              });
              vscode.postMessage({ type: MESSAGE_TYPES.RUN });
            },
          },
          {
            label: "Load Workflow",
            icon: "codicon-folder-opened",
            disabled: false,
            onClick: () =>
              vscode.postMessage({
                type: MESSAGE_TYPES.LOAD_WORKFLOW,
                filePath,
              }),
          },
          {
            label: "Queue Workflow",
            icon: "codicon-list-ordered",
            disabled: false,
            onClick: () =>
              vscode.postMessage({ type: MESSAGE_TYPES.APPEND_FILE, filePath }),
          }
        );
      }

      setContextMenu({ x, y, items });
    },
    [editorRef, filePath, vscode]
  );

  const editorLongPressHandlers = useLongPress((x, y) => openContextMenu(x, y));

  const editorContextMenuPortal = contextMenu ? (
    <StepContextMenu {...contextMenu} onClose={() => setContextMenu(null)} />
  ) : null;

  return { openContextMenu, editorContextMenuPortal, editorLongPressHandlers };
}
