/**
 * Beat labels the prompt editor capture records and its composition cuts on.
 * Shared so a renamed beat breaks the typecheck instead of the render.
 */
export const PROMPT_EDITOR_TAKE = "type";

/** The references typed into the prompt, in order; each opens a completion. */
export const PROMPT_EDITOR_REFS = [
  "symbol",
  "file",
  "folder",
  "previous",
  "commit",
  "secret",
  "skill",
] as const;
export type PromptEditorRef = (typeof PROMPT_EDITOR_REFS)[number];

export const PROMPT_EDITOR_BEATS = {
  /** The selected lines in the workspace viewer's editor. */
  CODE: "code",
  SELECT_START: "select-start",
  SELECT_END: "select-end",
  MENU: "menu",
  ADD_SELECTION: "add-selection",
  CLOSE_VIEWER: "close-viewer",
  /** The prompt editor, holding the selection's chip. */
  EDITOR: "editor",
  /** A reference's completion list opens, then the pick. */
  open: (ref: PromptEditorRef) => `${ref}-open`,
  pick: (ref: PromptEditorRef) => `${ref}-pick`,
  DONE: "done",
} as const;
