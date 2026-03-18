import { create } from "zustand";
import {
  persist,
  createJSONStorage,
  type StateStorage,
} from "zustand/middleware";
import { getVsCodeApi } from "../hooks/useVsCodeApi";
import type { WorkflowSummary } from "../types/messages";
import { DEFAULT_DESKTOP_SIZES, DEFAULT_MOBILE_SIZES } from "../constants";

// ============================================================================
// VS Code State Storage Adapter
// ============================================================================

/**
 * Raw StateStorage adapter backed by the VS Code webview state API.
 *
 * Unlike localStorage, vscode.getState()/setState() persists across VS Code
 * restarts for sidebar webview views — VS Code serializes the state when the
 * extension host shuts down and restores it when the view is next opened.
 *
 * The adapter stores Zustand's serialized blob under a namespaced key within
 * the shared vscode state object, so it coexists safely with editorStore's
 * data which is written directly to the root vscode state.
 */
const vsCodeRawStorage: StateStorage = {
  getItem(name: string): string | null {
    try {
      const vscode = getVsCodeApi();
      const root = vscode.getState() ?? {};
      const value = root[name];
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  },
  setItem(name: string, value: string): void {
    try {
      const vscode = getVsCodeApi();
      const root = vscode.getState() ?? {};
      vscode.setState({ ...root, [name]: value });
    } catch {
      // Swallow — best-effort persistence
    }
  },
  removeItem(name: string): void {
    try {
      const vscode = getVsCodeApi();
      const root = vscode.getState() ?? {};
      const { [name]: _removed, ...rest } = root as Record<string, unknown>;
      vscode.setState(rest);
    } catch {
      // Swallow
    }
  },
};

/**
 * A single template variable — name plus optional UI metadata.
 * Mirrors TemplateVariable in TemplateManager.ts.
 */
export interface TemplateVariable {
  name: string;
  type?: "text" | "file";
  fileFilter?: string[];
  autoFillFilename?: boolean;
}

/**
 * Template information for new workflow modal
 */
export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  variables?: TemplateVariable[];
  isBuiltIn: boolean;
}

/**
 * Data for the Save Workflow dialog
 */
export interface SaveWorkflowDialogData {
  defaultPath: string;
  defaultFormat: "yaml" | "json";
  workflowsDir: string;
}

/**
 * Recent workflow entry
 */
export interface RecentWorkflow {
  name: string;
  path: string;
  lastUsed: number;
}

/** Panel size snapshot (percentage values) for desktop or mobile layout */
export interface PanelSizes {
  prompts: number;
  output: number;
  editor: number;
  settings: number;
}

/**
 * UI state - Layout, visibility, and modal states
 */
interface UiState {
  // Dropdown hide feature — persisted to vscode state
  hiddenDropdownOptions: Record<string, string[]>; // namespace → hidden value[]
  // Section collapse states
  promptsCollapsed: boolean;
  finalPromptFooterExpanded: boolean;
  outputCollapsed: boolean;
  editorCollapsed: boolean;

  // Diff display — when true all DiffView instances render collapsed (summary only),
  // keeping the DOM lean for runs with many large file edits.
  diffsCollapsed: boolean;

  // Persisted panel sizes — restored to useRef on mount, written back on resize
  lastDesktopSizes: PanelSizes;
  lastMobileSizes: PanelSizes;

  // Drawer state
  propertiesDrawerOpen: boolean;

  // Settings panel collapse
  settingsCollapsed: boolean;

  // Output panel state
  selectedOutputStep: number | null; // Which step's output to show (null = current)

  // Run history display state
  isViewingHistory: boolean; // true when showing a historical run (not live)
  viewingRunIndex: number; // 0 = most recent, 1 = second most recent, etc.
  availableRuns: number; // Total runs saved for this workflow
  runTimestamps: (number | undefined)[]; // startedAt timestamps, index 0 = most recent
  runStates: (string | undefined)[]; // executionState for each run, index 0 = most recent

  // Save workflow dialog state
  saveWorkflowDialogOpen: boolean;
  saveWorkflowDialogData: SaveWorkflowDialogData | null;

  // New workflow modal state
  newWorkflowModalOpen: boolean;
  templates: TemplateInfo[];
  currentTemplate: TemplateInfo | null;
  workflowsDir: string;
  defaultTemplateId: string;
  /** Last file selected via OS file picker for a template variable; cleared after TemplateModal consumes it */
  templateFileSelection: { variable: string; path: string } | null;

  // Recent workflows dropdown
  recentWorkflows: RecentWorkflow[];
  recentWorkflowsDropdownOpen: boolean;

  // Multi-workflow support
  loadedWorkflows: WorkflowSummary[];
  activeWorkflowId: string | null;

  // Loading states
  isLoading: boolean;
  loadingMessage: string | null;

  // Output / editor font size (px) — user-adjustable, persisted
  outputFontSize: number;

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
  toggleFinalPromptFooterExpanded: () => void;
  setFinalPromptFooterExpanded: (expanded: boolean) => void;
  toggleOutputCollapse: () => void;
  toggleEditorCollapse: () => void;
  setPromptsCollapsed: (collapsed: boolean) => void;
  setOutputCollapsed: (collapsed: boolean) => void;
  setEditorCollapsed: (collapsed: boolean) => void;
  toggleDiffsCollapsed: () => void;

  // Panel sizes (persisted, written from App.tsx resize handlers)
  setLastDesktopSizes: (sizes: Partial<PanelSizes>) => void;
  setLastMobileSizes: (sizes: Partial<PanelSizes>) => void;

  // Drawer toggles
  togglePropertiesDrawer: () => void;
  openPropertiesDrawer: () => void;
  closePropertiesDrawer: () => void;

  // Settings panel
  toggleSettingsCollapse: () => void;
  setSettingsCollapsed: (collapsed: boolean) => void;

  // Output panel
  selectOutputStep: (stepIndex: number | null) => void;

  // Save workflow dialog
  openSaveWorkflowDialog: (data: SaveWorkflowDialogData) => void;
  closeSaveWorkflowDialog: () => void;

  // New workflow modal
  openNewWorkflowModal: (data: {
    templates: TemplateInfo[];
    workflowsDir: string;
    defaultTemplateId?: string;
  }) => void;
  closeNewWorkflowModal: () => void;
  setCurrentTemplate: (template: TemplateInfo | null) => void;
  setDefaultTemplateId: (id: string) => void;
  setTemplateFileSelection: (selection: { variable: string; path: string } | null) => void;

  // Recent workflows
  setRecentWorkflows: (workflows: RecentWorkflow[]) => void;
  toggleRecentWorkflowsDropdown: () => void;
  closeRecentWorkflowsDropdown: () => void;

  // Multi-workflow support
  setLoadedWorkflows: (workflows: WorkflowSummary[]) => void;
  addLoadedWorkflow: (workflow: WorkflowSummary) => void;
  removeLoadedWorkflow: (workflowId: string) => void;
  updateLoadedWorkflow: (workflow: WorkflowSummary) => void;
  setActiveWorkflowId: (id: string | null) => void;

  // Output / editor font size
  setOutputFontSize: (size: number) => void;

  // Loading state
  setLoading: (loading: boolean, message?: string) => void;

  // Toast notifications
  showToast: (
    message: string,
    type?: "info" | "success" | "warning" | "error"
  ) => void;
  hideToast: () => void;

  // Run history view
  setHistoryView: (
    runIndex: number,
    availableRuns: number,
    runTimestamps?: (number | undefined)[],
    runStates?: (string | undefined)[]
  ) => void;
  setRunTimestamps: (timestamps: (number | undefined)[]) => void;
  setRunStates: (states: (string | undefined)[]) => void;
  clearHistoryView: () => void;

  // Dropdown hide feature
  hideDropdownOption: (namespace: string, value: string) => void;
  unhideDropdownOption: (namespace: string, value: string) => void;
  clearHiddenDropdownOptions: (namespace: string) => void;

  // Reset UI to defaults
  resetUi: () => void;
}

const initialState: UiState = {
  hiddenDropdownOptions: {},
  saveWorkflowDialogOpen: false,
  saveWorkflowDialogData: null,
  promptsCollapsed: false,
  finalPromptFooterExpanded: false,
  outputCollapsed: false,
  editorCollapsed: false,
  diffsCollapsed: true, // collapsed by default to keep the DOM lean
  lastDesktopSizes: { ...DEFAULT_DESKTOP_SIZES },
  lastMobileSizes: { ...DEFAULT_MOBILE_SIZES },
  propertiesDrawerOpen: false,
  settingsCollapsed: true,
  selectedOutputStep: null,
  newWorkflowModalOpen: false,
  templates: [],
  currentTemplate: null,
  workflowsDir: ".flightpath/workflows",
  defaultTemplateId: "blank",
  templateFileSelection: null,
  recentWorkflows: [],
  recentWorkflowsDropdownOpen: false,
  loadedWorkflows: [],
  activeWorkflowId: null,
  isLoading: false,
  loadingMessage: null,
  outputFontSize: 13,
  toast: null,
  isViewingHistory: false,
  viewingRunIndex: 0,
  availableRuns: 0,
  runTimestamps: [],
  runStates: [],
};

// Fields to persist via vscode.getState()/setState()
const persistedFields = [
  "promptsCollapsed",
  "outputCollapsed",
  "editorCollapsed",
  "settingsCollapsed",
  "defaultTemplateId",
  "hiddenDropdownOptions",
  "lastDesktopSizes",
  "lastMobileSizes",
  "diffsCollapsed",
  "outputFontSize",
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

      toggleFinalPromptFooterExpanded: () =>
        set((state) => ({
          finalPromptFooterExpanded: !state.finalPromptFooterExpanded,
        })),

      setFinalPromptFooterExpanded: (expanded) =>
        set({ finalPromptFooterExpanded: expanded }),

      toggleOutputCollapse: () =>
        set((state) => ({ outputCollapsed: !state.outputCollapsed })),

      toggleEditorCollapse: () =>
        set((state) => ({ editorCollapsed: !state.editorCollapsed })),

      setPromptsCollapsed: (collapsed) => set({ promptsCollapsed: collapsed }),

      setOutputCollapsed: (collapsed) => set({ outputCollapsed: collapsed }),

      setEditorCollapsed: (collapsed) => set({ editorCollapsed: collapsed }),

      toggleDiffsCollapsed: () =>
        set((state) => ({ diffsCollapsed: !state.diffsCollapsed })),

      // ============================================================================
      // PANEL SIZES
      // ============================================================================

      setLastDesktopSizes: (sizes) =>
        set((state) => ({
          lastDesktopSizes: { ...state.lastDesktopSizes, ...sizes },
        })),

      setLastMobileSizes: (sizes) =>
        set((state) => ({
          lastMobileSizes: { ...state.lastMobileSizes, ...sizes },
        })),

      // ============================================================================
      // DRAWER TOGGLES
      // ============================================================================

      togglePropertiesDrawer: () =>
        set((state) => ({ propertiesDrawerOpen: !state.propertiesDrawerOpen })),

      openPropertiesDrawer: () => set({ propertiesDrawerOpen: true }),

      closePropertiesDrawer: () => set({ propertiesDrawerOpen: false }),

      // ============================================================================
      // SETTINGS PANEL
      // ============================================================================

      toggleSettingsCollapse: () =>
        set((state) => ({ settingsCollapsed: !state.settingsCollapsed })),

      setSettingsCollapsed: (collapsed) =>
        set({ settingsCollapsed: collapsed }),

      // ============================================================================
      // OUTPUT PANEL
      // ============================================================================

      selectOutputStep: (stepIndex) => set({ selectedOutputStep: stepIndex }),

      // ============================================================================
      // SAVE WORKFLOW DIALOG
      // ============================================================================

      openSaveWorkflowDialog: (data) =>
        set({ saveWorkflowDialogOpen: true, saveWorkflowDialogData: data }),

      closeSaveWorkflowDialog: () =>
        set({ saveWorkflowDialogOpen: false, saveWorkflowDialogData: null }),

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

      setTemplateFileSelection: (selection) => set({ templateFileSelection: selection }),

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
      // MULTI-WORKFLOW SUPPORT
      // ============================================================================

      setLoadedWorkflows: (workflows) => set({ loadedWorkflows: workflows }),

      addLoadedWorkflow: (workflow) =>
        set((state) => ({
          loadedWorkflows: [
            ...state.loadedWorkflows.filter((w) => w.id !== workflow.id),
            workflow,
          ],
        })),

      removeLoadedWorkflow: (workflowId) =>
        set((state) => ({
          loadedWorkflows: state.loadedWorkflows.filter(
            (w) => w.id !== workflowId
          ),
        })),

      updateLoadedWorkflow: (workflow) =>
        set((state) => ({
          loadedWorkflows: state.loadedWorkflows.map((w) =>
            w.id === workflow.id ? workflow : w
          ),
        })),

      setActiveWorkflowId: (id) => set({ activeWorkflowId: id }),

      // ============================================================================
      // OUTPUT FONT SIZE
      // ============================================================================

      setOutputFontSize: (size) =>
        set({ outputFontSize: Math.min(24, Math.max(10, size)) }),

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
      // RUN HISTORY VIEW
      // ============================================================================

      setHistoryView: (runIndex, availableRuns, runTimestamps, runStates) =>
        set({
          isViewingHistory: true,
          viewingRunIndex: runIndex,
          availableRuns,
          ...(runTimestamps !== undefined ? { runTimestamps } : {}),
          ...(runStates !== undefined ? { runStates } : {}),
        }),

      setRunTimestamps: (timestamps) => set({ runTimestamps: timestamps }),

      setRunStates: (states) => set({ runStates: states }),

      clearHistoryView: () =>
        set({ isViewingHistory: false, viewingRunIndex: 0 }),

      // ============================================================================
      // DROPDOWN HIDE FEATURE
      // ============================================================================

      hideDropdownOption: (namespace, value) =>
        set((state) => ({
          hiddenDropdownOptions: {
            ...state.hiddenDropdownOptions,
            [namespace]: [
              ...(state.hiddenDropdownOptions[namespace] ?? []).filter(
                (v) => v !== value
              ),
              value,
            ],
          },
        })),

      unhideDropdownOption: (namespace, value) =>
        set((state) => ({
          hiddenDropdownOptions: {
            ...state.hiddenDropdownOptions,
            [namespace]: (state.hiddenDropdownOptions[namespace] ?? []).filter(
              (v) => v !== value
            ),
          },
        })),

      clearHiddenDropdownOptions: (namespace) =>
        set((state) => ({
          hiddenDropdownOptions: {
            ...state.hiddenDropdownOptions,
            [namespace]: [],
          },
        })),

      // ============================================================================
      // RESET
      // ============================================================================

      resetUi: () =>
        set({
          // Reset non-persisted state
          saveWorkflowDialogOpen: false,
          saveWorkflowDialogData: null,
          propertiesDrawerOpen: false,
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
      storage: createJSONStorage(() => vsCodeRawStorage),
      // Only persist specific fields (layout preferences)
      partialize: (state) =>
        Object.fromEntries(
          persistedFields.map((key) => [key, state[key]])
        ) as Pick<UiState, (typeof persistedFields)[number]>,
    }
  )
);
