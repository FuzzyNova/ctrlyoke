import { create } from "zustand";

interface EditorState {
  selectedPromptIndex: number | null;
  originalPromptData: any | null;
  hasActiveQueue: boolean;
  promptText: string;
  promptName: string;

  selectPrompt: (index: number | null) => void;
  setOriginalPromptData: (data: any) => void;
  setHasActiveQueue: (hasQueue: boolean) => void;
  setPromptText: (text: string) => void;
  setPromptName: (name: string) => void;
  resetEditor: () => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  selectedPromptIndex: null,
  originalPromptData: null,
  hasActiveQueue: false,
  promptText: "",
  promptName: "",

  selectPrompt: (index) => set({ selectedPromptIndex: index }),
  setOriginalPromptData: (data) => set({ originalPromptData: data }),
  setHasActiveQueue: (hasQueue) => set({ hasActiveQueue: hasQueue }),
  setPromptText: (text) => set({ promptText: text }),
  setPromptName: (name) => set({ promptName: name }),

  resetEditor: () =>
    set({
      selectedPromptIndex: null,
      originalPromptData: null,
      promptText: "",
      promptName: "",
    }),
}));
