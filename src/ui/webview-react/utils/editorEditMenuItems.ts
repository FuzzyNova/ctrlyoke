import { EditorSelection, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { selectAll, selectLine } from "@codemirror/commands";
import type { StepContextMenuEntry } from "@components/shared/StepContextMenu";
import { readClipboardText, writeClipboardText } from "@utils/stepClipboard";

const NO_SELECTION_TITLE = "No text selected";
const READ_ONLY_TITLE = "Editor is read-only";
const EMPTY_EDITOR_TITLE = "Editor is empty";
const NO_WORD_TITLE = "No word at cursor";

/**
 * Moves the caret to the given client coordinates, as a right-click or long
 * press does in VS Code, unless they land inside the current selection (which
 * is kept so Cut/Copy still act on it). CodeMirror itself only moves the caret
 * for the primary button.
 */
export function placeCaretForContextMenu(
  view: EditorView,
  x: number,
  y: number
): void {
  const pos = view.posAtCoords({ x, y });
  if (pos == null) return;
  const { from, to } = view.state.selection.main;
  if (from !== to && pos >= from && pos <= to) return;
  view.dispatch({
    selection: EditorSelection.cursor(pos),
    userEvent: "select.pointer",
  });
}

/**
 * The run of non-whitespace text touching the caret on either side: a whole
 * reference such as `@src/a/b.ts`, where CodeMirror's own `wordAt` would stop
 * at `b`.
 */
export function findWordRangeAt(
  state: EditorState,
  pos: number
): { from: number; to: number } | null {
  const line = state.doc.lineAt(pos);
  const offset = pos - line.from;
  const isWordChar = (index: number) => /\S/.test(line.text.charAt(index));
  let start = offset;
  while (isWordChar(start - 1)) start--;
  let end = offset;
  while (isWordChar(end)) end++;
  return start === end
    ? null
    : { from: line.from + start, to: line.from + end };
}

/**
 * Cut/Copy/Paste and Select Word/Line/All for a CodeMirror context menu,
 * shared by the prompt editor and the workspace file editor. Each selection
 * item focuses the editor afterwards, so a following Backspace deletes what
 * it selected (the quick way to clear a long reference on a phone).
 */
export function buildEditorEditMenuItems(
  view: EditorView,
  readOnly: boolean
): StepContextMenuEntry[] {
  const { state } = view;
  const selection = state.selection.main;
  const selectedText = state.sliceDoc(selection.from, selection.to);
  const hasSelection = selectedText.length > 0;
  const isEmpty = state.doc.length === 0;
  const word = selection.empty ? findWordRangeAt(state, selection.head) : null;

  const run = (action: () => void) => () => {
    action();
    view.focus();
  };

  return [
    {
      label: "Cut",
      icon: "codicon-screen-cut",
      disabled: !hasSelection || readOnly,
      disabledTitle: readOnly ? READ_ONLY_TITLE : NO_SELECTION_TITLE,
      onClick: run(() => {
        void writeClipboardText(selectedText);
        view.dispatch(
          view.state.update(view.state.replaceSelection(""), {
            userEvent: "delete.cut",
            scrollIntoView: true,
          })
        );
      }),
    },
    {
      label: "Copy",
      icon: "codicon-copy",
      disabled: !hasSelection,
      disabledTitle: NO_SELECTION_TITLE,
      onClick: run(() => void writeClipboardText(selectedText)),
    },
    {
      label: "Paste",
      icon: "codicon-clippy",
      disabled: readOnly,
      disabledTitle: READ_ONLY_TITLE,
      onClick: () => {
        void readClipboardText()
          .then((text) => {
            if (!text) return;
            view.dispatch(
              view.state.update(view.state.replaceSelection(text), {
                userEvent: "input.paste",
                scrollIntoView: true,
              })
            );
          })
          .catch(() => undefined)
          .finally(() => view.focus());
      },
    },
    { type: "divider" },
    {
      label: "Select Word",
      icon: "codicon-whole-word",
      disabled: !word,
      disabledTitle: NO_WORD_TITLE,
      onClick: run(() => {
        if (!word) return;
        view.dispatch({
          selection: EditorSelection.range(word.from, word.to),
          userEvent: "select",
        });
      }),
    },
    {
      label: "Select Line",
      icon: "codicon-list-selection",
      disabled: isEmpty,
      disabledTitle: EMPTY_EDITOR_TITLE,
      onClick: run(() => selectLine(view)),
    },
    {
      label: "Select All",
      icon: "codicon-selection",
      disabled: isEmpty,
      disabledTitle: EMPTY_EDITOR_TITLE,
      onClick: run(() => selectAll(view)),
    },
  ];
}
