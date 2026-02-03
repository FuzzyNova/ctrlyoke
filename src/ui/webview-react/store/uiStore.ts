import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/**
 * Template information for new workflow modal
 */
export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  variables?: Record<string, unknown>;
  isBuiltIn: boolean;
  isAction: boolean;
}

/**
 * Recent workflow entry
 */
export interface RecentWorkflow {
  name: string;
  path: string;
  lastUsed: number;
}

/**
 * UI state - Layout, visibility, and modal states
 */
interface UiState {
  // Section collapse states
  promptsCollapsed: boolean;
  outputCollapsed: boolean;
  editorCollapsed: boolean;

  // Drawer states
  propertiesDrawerOpen: boolean;
  settingsDrawerOpen: boolean;

  // Output panel state
  autoscrollEnabled: boolean;
  selectedOutputStep: number | null; // Which step's output to show (null = current)

  // New workflow modal state
  newWorkflowModalOpen: boolean;
  templates: TemplateInfo[];
  currentTemplate: TemplateInfo | null;
  workflowsDir: string;
  defaultTemplateId: string;

  // Recent workflows dropdown
  recentWorkflows: RecentWorkflow[];
  recentWorkflowsDropdownOpen: boolean;

  // Loading states
  isLoading: boolean;
  loadingMessage: string | null;

  // Notification toast state (transient, not persisted)
  toast: {
    message: string;
    type: "info" | "success" | "warning" | "error";
    visible: boolean;
  } | null;
}

/**
 * UI actions
 */
interface UiActions {
  // Section toggles
  togglePromptsCollapse: () => void;
  toggleOutputCollapse: () => void;
  toggleEditorCollapse: () => void;
  setPromptsCollapsed: (collapsed: boolean) => void;
  setOutputCollapsed: (collapsed: boolean) => void;
  setEditorCollapsed: (collapsed: boolean) => void;

  // Drawer toggles
  togglePropertiesDrawer: () => void;
  toggleSettingsDrawer: () => void;
  openPropertiesDrawer: () => void;
  closePropertiesDrawer: () => void;
  openSettingsDrawer: () => void;
  closeSettingsDrawer: () => void;

  // Output panel
  setAutoscroll: (enabled: boolean) => void;
  selectOutputStep: (stepIndex: number | null) => void;

  // New workflow modal
  openNewWorkflowModal: (data: {
    templates: TemplateInfo[];
    workflowsDir: string;
    defaultTemplateId?: string;
  }) => void;
  closeNewWorkflowModal: () => void;
  setCurrentTemplate: (template: TemplateInfo | null) => void;
  setDefaultTemplateId: (id: string) => void;

  // Recent workflows
  setRecentWorkflows: (workflows: RecentWorkflow[]) => void;
  toggleRecentWorkflowsDropdown: () => void;
  closeRecentWorkflowsDropdown: () => void;

  // Loading state
  setLoading: (loading: boolean, message?: string) => void;

  // Toast notifications
  showToast: (
    message: string,
    type?: "info" | "success" | "warning" | "error"
  ) => void;
  hideToast: () => void;

  // Reset UI to defaults
  resetUi: () => void;
}

const initialState: UiState = {
  promptsCollapsed: false,
  outputCollapsed: false,
  editorCollapsed: false,
  propertiesDrawerOpen: false,
  settingsDrawerOpen: false,
  autoscrollEnabled: true,
  selectedOutputStep: null,
  newWorkflowModalOpen: false,
  templates: [],
  currentTemplate: null,
  workflowsDir: ".flightpath/workflows",
  defaultTemplateId: "blank",
  recentWorkflows: [],
  recentWorkflowsDropdownOpen: false,
  isLoading: false,
  loadingMessage: null,
  toast: null,
};

// Fields to persist to localStorage
const persistedFields = [
  "promptsCollapsed",
  "outputCollapsed",
  "editorCollapsed",
  "autoscrollEnabled",
  "defaultTemplateId",
] as const;

export const useUiStore = create<UiState & UiActions>()(
  persist(
    (set) => ({
      ...initialState,

      // ============================================================================
      // SECTION TOGGLES
      // ============================================================================

      togglePromptsCollapse: () =>
        set((state) => ({ promptsCollapsed: !state.promptsCollapsed })),

      toggleOutputCollapse: () =>
        set((state) => ({ outputCollapsed: !state.outputCollapsed })),

      toggleEditorCollapse: () =>
        set((state) => ({ editorCollapsed: !state.editorCollapsed })),

      setPromptsCollapsed: (collapsed) => set({ promptsCollapsed: collapsed }),

      setOutputCollapsed: (collapsed) => set({ outputCollapsed: collapsed }),

      setEditorCollapsed: (collapsed) => set({ editorCollapsed: collapsed }),

      // ============================================================================
      // DRAWER TOGGLES
      // ============================================================================

      togglePropertiesDrawer: () =>
        set((state) => ({
          propertiesDrawerOpen: !state.propertiesDrawerOpen,
          // Close settings drawer when opening properties
          settingsDrawerOpen: state.propertiesDrawerOpen
            ? state.settingsDrawerOpen
            : false,
        })),

      toggleSettingsDrawer: () =>
        set((state) => ({
          settingsDrawerOpen: !state.settingsDrawerOpen,
          // Close properties drawer when opening settings
          propertiesDrawerOpen: state.settingsDrawerOpen
            ? state.propertiesDrawerOpen
            : false,
        })),

      openPropertiesDrawer: () =>
        set({ propertiesDrawerOpen: true, settingsDrawerOpen: false }),

      closePropertiesDrawer: () => set({ propertiesDrawerOpen: false }),

      openSettingsDrawer: () =>
        set({ settingsDrawerOpen: true, propertiesDrawerOpen: false }),

      closeSettingsDrawer: () => set({ settingsDrawerOpen: false }),

      // ============================================================================
      // OUTPUT PANEL
      // ============================================================================

      setAutoscroll: (enabled) => set({ autoscrollEnabled: enabled }),

      selectOutputStep: (stepIndex) => set({ selectedOutputStep: stepIndex }),

      // ============================================================================
      // NEW WORKFLOW MODAL
      // ============================================================================

      openNewWorkflowModal: ({ templates, workflowsDir, defaultTemplateId }) =>
        set({
          newWorkflowModalOpen: true,
          templates,
          workflowsDir,
          defaultTemplateId: defaultTemplateId ?? "blank",
          currentTemplate:
            templates.find((t) => t.id === (defaultTemplateId ?? "blank")) ??
            null,
        }),

      closeNewWorkflowModal: () =>
        set({
          newWorkflowModalOpen: false,
          currentTemplate: null,
        }),

      setCurrentTemplate: (template) => set({ currentTemplate: template }),

      setDefaultTemplateId: (id) => set({ defaultTemplateId: id }),

      // ============================================================================
      // RECENT WORKFLOWS
      // ============================================================================

      setRecentWorkflows: (workflows) => set({ recentWorkflows: workflows }),

      toggleRecentWorkflowsDropdown: () =>
        set((state) => ({
          recentWorkflowsDropdownOpen: !state.recentWorkflowsDropdownOpen,
        })),

      closeRecentWorkflowsDropdown: () =>
        set({ recentWorkflowsDropdownOpen: false }),

      // ============================================================================
      // LOADING STATE
      // ============================================================================

      setLoading: (loading, message) =>
        set({
          isLoading: loading,
          loadingMessage: loading ? (message ?? null) : null,
        }),

      // ============================================================================
      // TOAST NOTIFICATIONS
      // ============================================================================

      showToast: (message, type = "info") =>
        set({
          toast: { message, type, visible: true },
        }),

      hideToast: () => set({ toast: null }),

      // ============================================================================
      // RESET
      // ============================================================================

      resetUi: () =>
        set({
          // Reset non-persisted state
          propertiesDrawerOpen: false,
          settingsDrawerOpen: false,
          selectedOutputStep: null,
          newWorkflowModalOpen: false,
          templates: [],
          currentTemplate: null,
          recentWorkflows: [],
          recentWorkflowsDropdownOpen: false,
          isLoading: false,
          loadingMessage: null,
          toast: null,
        }),
    }),
    {
      name: "flightpath-ui-state",
      storage: createJSONStorage(() => localStorage),
      // Only persist specific fields (layout preferences)
      partialize: (state) =>
        Object.fromEntries(
          persistedFields.map((key) => [key, state[key]])
        ) as Pick<UiState, (typeof persistedFields)[number]>,
    }
  )
);
