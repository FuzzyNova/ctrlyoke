import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import {
  PROMPT_HISTORY_KINDS,
  type PromptHistoryKind,
} from "@root/types/DashboardConstants";
import { webviewRawStorage } from "@utils/webviewStateStorage";

/** Most entries kept; older ones fall off the end. */
export const PROMPT_HISTORY_LIMIT = 15;
/**
 * Longest prompt kept. Webview state is one serialized object shared by every
 * persisted store, so a pasted log must not be copied into it again and
 * again; a prompt over this size is simply not remembered.
 */
export const PROMPT_HISTORY_MAX_TEXT_LENGTH = 50_000;

export interface PromptHistoryEntry {
  text: string;
  kind: PromptHistoryKind;
  /** Epoch milliseconds of the send, or of the moment the draft was replaced. */
  timestampMs: number;
}

interface PromptHistoryState {
  /** Newest first, unique by text. */
  entries: PromptHistoryEntry[];
  /**
   * Remember text that left the editor. An entry with the same text moves to
   * the top and takes the new kind, so the list never shows a prompt twice.
   */
  record: (text: string, kind: PromptHistoryKind) => void;
  /**
   * Remember unsent text the editor is about to replace, unless the list
   * already holds it. Leaving an existing entry where it is keeps the list
   * stable while the user steps through it.
   */
  rememberDraft: (text: string) => void;
}

function isStorable(text: string): boolean {
  return text.length > 0 && text.length <= PROMPT_HISTORY_MAX_TEXT_LENGTH;
}

/**
 * Prompts recently run, queued or steered from the prompt editor, plus unsent
 * drafts the editor replaced, for the editor's Recent Prompts menu. Kept for
 * every workflow at once, so a prompt sent to the wrong workflow can be loaded
 * again in the right one. Persisted per client: the VS Code panel and each
 * browser keep their own list.
 */
export const usePromptHistoryStore = create<PromptHistoryState>()(
  persist(
    (set, get) => ({
      entries: [],

      record: (text, kind) => {
        const trimmed = text.trim();
        if (!isStorable(trimmed)) return;
        set({
          entries: [
            { text: trimmed, kind, timestampMs: Date.now() },
            ...get().entries.filter((entry) => entry.text !== trimmed),
          ].slice(0, PROMPT_HISTORY_LIMIT),
        });
      },

      rememberDraft: (text) => {
        const trimmed = text.trim();
        if (!isStorable(trimmed)) return;
        if (get().entries.some((entry) => entry.text === trimmed)) return;
        get().record(trimmed, PROMPT_HISTORY_KINDS.DRAFT);
      },
    }),
    {
      name: "ctrlyoke-prompt-history",
      skipHydration: true,
      storage: createJSONStorage(() => webviewRawStorage),
      partialize: (state) => ({ entries: state.entries }),
    }
  )
);
