import { useCallback, useState, type ReactNode, type RefObject } from "react";
import {
  StepContextMenu,
  type StepContextMenuEntry,
  type StepContextMenuState,
} from "@components/shared/StepContextMenu";
import { type WorkspaceFileEditorHandle } from "@components/workspace-viewer/WorkspaceFileEditor";
import { useLongPress } from "@hooks/useLongPress";
import { useWorkflowFileMenuItems } from "@hooks/useWorkflowFileMenuItems";
import { useEditorStore } from "@store/editorStore";
import { writeClipboardText } from "@utils/stepClipboard";
import { PROMPT_EDITOR_INSERT_MODES } from "@/types/messages";

const NO_SYMBOL_TITLE = "No symbol at cursor";

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

/**
 * Symbol actions stay visible but disabled when the click is not on a symbol,
 * so the menu keeps a stable shape and still advertises what the language
 * server offers. Format Document acts on the whole file and is always enabled.
 */
export function buildLanguageIntelligenceMenuItems(
  editorRef: RefObject<WorkspaceFileEditorHandle | null>,
  capabilities: Record<string, unknown>,
  hasSymbol: boolean
): StepContextMenuEntry[] {
  const items: StepContextMenuEntry[] = [];
  const symbolItem = (
    label: string,
    icon: string,
    run: (editor: WorkspaceFileEditorHandle) => Promise<void>
  ): StepContextMenuEntry => ({
    label,
    icon,
    disabled: !hasSymbol,
    disabledTitle: NO_SYMBOL_TITLE,
    onClick: () => {
      if (editorRef.current) void run(editorRef.current);
    },
  });
  if (capabilities.definitionProvider)
    items.push(
      symbolItem("Go to Definition", "codicon-go-to-file", (editor) =>
        editor.goToDefinition()
      )
    );
  if (capabilities.referencesProvider)
    items.push(
      symbolItem("Find All References", "codicon-references", (editor) =>
        editor.findAllReferences()
      )
    );
  if (capabilities.renameProvider)
    items.push(
      symbolItem("Rename Symbol", "codicon-rename", (editor) =>
        editor.renameSymbol()
      )
    );
  if (capabilities.documentFormattingProvider)
    items.push({
      label: "Format Document",
      icon: "codicon-edit-sparkle",
      disabled: false,
      onClick: () => void editorRef.current?.formatDocument(),
    });
  return items;
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
  const buildWorkflowFileMenuItems = useWorkflowFileMenuItems();
  const [contextMenu, setContextMenu] = useState<StepContextMenuState | null>(
    null
  );

  const openContextMenu = useCallback(
    (x: number, y: number) => {
      editorRef.current?.placeCaretAtCoords(x, y);
      const selectionText = editorRef.current?.getSelectionText() ?? "";
      const selectionRange = editorRef.current?.getSelectionRange();
      const hasSelection = selectionText.length > 0;
      const languageCapabilities =
        editorRef.current?.getLanguageCapabilities() ?? {};
      const languageItems = buildLanguageIntelligenceMenuItems(
        editorRef,
        languageCapabilities,
        editorRef.current?.hasSymbolAtCaret() ?? false
      );

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
        ...(languageItems.length
          ? [{ type: "divider" as const }, ...languageItems]
          : []),
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
        ...buildWorkflowFileMenuItems(filePath),
      ];

      setContextMenu({ x, y, items });
    },
    [editorRef, filePath, buildWorkflowFileMenuItems]
  );

  const editorLongPressHandlers = useLongPress((x, y) => openContextMenu(x, y));

  const editorContextMenuPortal = contextMenu ? (
    <StepContextMenu {...contextMenu} onClose={() => setContextMenu(null)} />
  ) : null;

  return { openContextMenu, editorContextMenuPortal, editorLongPressHandlers };
}
