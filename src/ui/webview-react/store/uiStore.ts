import { create } from "zustand";
import { persist } from "zustand/middleware";

interface UiState {
  promptsCollapsed: boolean;
  outputCollapsed: boolean;
  editorCollapsed: boolean;
  propertiesDrawerOpen: boolean;
  settingsDrawerOpen: boolean;
  autoscrollEnabled: boolean;

  togglePromptsCollapse: () => void;
  toggleOutputCollapse: () => void;
  toggleEditorCollapse: () => void;
  togglePropertiesDrawer: () => void;
  toggleSettingsDrawer: () => void;
  setAutoscroll: (enabled: boolean) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      promptsCollapsed: false,
      outputCollapsed: false,
      editorCollapsed: false,
      propertiesDrawerOpen: false,
      settingsDrawerOpen: false,
      autoscrollEnabled: true,

      togglePromptsCollapse: () =>
        set((state) => ({ promptsCollapsed: !state.promptsCollapsed })),
      toggleOutputCollapse: () =>
        set((state) => ({ outputCollapsed: !state.outputCollapsed })),
      toggleEditorCollapse: () =>
        set((state) => ({ editorCollapsed: !state.editorCollapsed })),
      togglePropertiesDrawer: () =>
        set((state) => ({ propertiesDrawerOpen: !state.propertiesDrawerOpen })),
      toggleSettingsDrawer: () =>
        set((state) => ({ settingsDrawerOpen: !state.settingsDrawerOpen })),
      setAutoscroll: (enabled) => set({ autoscrollEnabled: enabled }),
    }),
    {
      name: "flightpath-ui-state",
    }
  )
);
