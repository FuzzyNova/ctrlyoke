import { useCallback, useState, type ReactNode, type RefObject } from "react";
import {
  ContextMenu,
  type ContextMenuEntry,
  type ContextMenuState,
} from "@components/shared/ContextMenu";
import { type WorkspaceFileEditorHandle } from "@components/workspace-viewer/WorkspaceFileEditor";
import { useLongPress } from "@hooks/useLongPress";
import { useWorkflowFileMenuItems } from "@hooks/useWorkflowFileMenuItems";
import { useEditorStore } from "@store/editorStore";
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
): ContextMenuEntry[] {
  const items: ContextMenuEntry[] = [];
  const symbolItem = (
    label: string,
    icon: string,
    run: (editor: WorkspaceFileEditorHandle) => Promise<void>
  ): ContextMenuEntry => ({
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
  /** `fromTouch` keeps focus (and the on-screen keyboard) in the editor. */
  openContextMenu: (x: number, y: number, fromTouch?: boolean) => void;
  editorContextMenuPortal: ReactNode;
  editorLongPressHandlers: ReturnType<typeof useLongPress>;
}

export function useWorkspaceEditorContextMenu({
  editorRef,
  filePath,
}: UseWorkspaceEditorContextMenuOptions): UseWorkspaceEditorContextMenuResult {
  const buildWorkflowFileMenuItems = useWorkflowFileMenuItems();
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const openContextMenu = useCallback(
    (x: number, y: number, fromTouch = false) => {
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

      const items: ContextMenuEntry[] = [
        ...(editorRef.current?.getEditMenuItems() ?? []),
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

      setContextMenu({ x, y, items, keepInvokerFocus: fromTouch });
    },
    [editorRef, filePath, buildWorkflowFileMenuItems]
  );

  const openContextMenuFromTouch = useCallback(
    (x: number, y: number) => openContextMenu(x, y, true),
    [openContextMenu]
  );
  // A long press on a selection handle is the user dragging the selection.
  const canStartLongPress = useCallback(
    (x: number, y: number) =>
      !editorRef.current?.isTouchOnSelectionHandle(x, y),
    [editorRef]
  );
  const editorLongPressHandlers = useLongPress(
    openContextMenuFromTouch,
    undefined,
    false,
    canStartLongPress
  );

  const editorContextMenuPortal = contextMenu ? (
    <ContextMenu {...contextMenu} onClose={() => setContextMenu(null)} />
  ) : null;

  return { openContextMenu, editorContextMenuPortal, editorLongPressHandlers };
}
