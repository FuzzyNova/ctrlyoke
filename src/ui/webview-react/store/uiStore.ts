import { create } from "zustand";
import {
  persist,
  createJSONStorage,
  type StateStorage,
} from "zustand/middleware";
import { getVsCodeApi } from "../hooks/useVsCodeApi";
import type { WorkflowSummary } from "../types/messages";
import type {
  LocalMcpServerEntry,
  RegistryMcpEntry,
} from "@root/types/WebviewMessageTypes";
import type { McpServerConfig } from "@root/types/FlightPathTypes";
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

/** Panel size snapshot for desktop or mobile layout.
 *  Desktop: steps/settings are in pixels; output/editor are percentages.
 *  Mobile: output/editor are percentages. */
export interface PanelSizes {
  steps: number;
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
  stepsCollapsed: boolean;
  finalStepFooterExpanded: boolean;
  outputCollapsed: boolean;
  editorCollapsed: boolean;

  // Diff display — when true all DiffView instances render collapsed (summary only),
  // keeping the DOM lean for runs with many large file edits.
  diffsCollapsed: boolean;
  // Monotonic counter bumped on every "expand all" / "collapse all" action.
  // DiffView includes this in its useEffect deps so the effect fires even when
  // diffsCollapsed doesn't change (e.g. user manually collapsed one diff while
  // diffsCollapsed was already false, then presses "Expand all" again).
  diffResetVersion: number;

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
  activeWorkflowWorkingFilePath: string | null;

  // Loading states
  isLoading: boolean;
  loadingMessage: string | null;

  // Output / editor font size (px) — user-adjustable, persisted
  outputFontSize: number;
  // Terminal font size (px) — user-adjustable, persisted
  terminalFontSize: number;

  // Terminal tab state (per workflow, defaults to 'output')
  activeOutputTabs: Record<string, "output" | "terminal">;
  // Workflows with at least one running terminal session
  terminalActiveWorkflows: Set<string>;

  // Terminal session rail layout — persisted
  terminalRailCollapsed: boolean;
  terminalRailSizePx: number;

  // Notification toast state (transient, not persisted)
  toast: {
    message: string;
    type: "info" | "success" | "warning" | "error";
    visible: boolean;
  } | null;

  // Footer quick picker state (transient, not persisted)
  footerOpenPicker:
    | "harness"
    | "model"
    | "agent"
    | "skills"
    | "permissions"
    | "context"
    | null;

  // MCP Discovery state
  mcpDiscoveryTab: "local" | "registry";
  mcpLocalServers: LocalMcpServerEntry[];
  mcpLocalServersLoading: boolean;
  mcpLocalServersError: string | undefined;
  mcpRegistryServers: RegistryMcpEntry[] | undefined;
  mcpRegistryLoading: boolean;
  mcpRegistryError: string | undefined;
  mcpRegistryQuery: string;
  /** Cursor for the next page of registry results (undefined = no more pages) */
  mcpRegistryNextCursor: string | undefined;
  /**
   * History of cursors for each visited page.
   * Index 0 = page 1 (cursor undefined), index 1 = page 2 (nextCursor from page 1), etc.
   * Current page = last element. Length = current page number.
   */
  mcpRegistryPageCursors: (string | undefined)[];
  // MCP Workspace registry (undefined = not yet loaded)
  mcpWorkspaceServers: McpServerConfig[] | undefined;
  mcpWorkspaceServersLoading: boolean;

  // Mobile drawer/sidebar state (transient — not persisted)
  mobilePromptsOpen: boolean;
  mobilePromptsMode: "sidebar" | "fullwidth";
  mobileSettingsOpen: boolean;

  // Global settings drawer state
  globalSettingsOpen: boolean;
  globalSettingsActiveTab: string;

  // Startup overlay — true once STARTUP_COMPLETE (or WORKFLOW_LOADED) is received.
  // NOT persisted: every panel open should show the overlay until startup settles.
  startupReady: boolean;
  devRestarting: boolean;

  // This client's identity assigned by the extension host on connect.
  // Used to derive isController for terminal sessions.
  myClientId: string;
}

/**
 * UI actions
 */
interface UiActions {
  // Section toggles
  togglePromptsCollapse: () => void;
  toggleFinalStepFooterExpanded: () => void;
  setFinalStepFooterExpanded: (expanded: boolean) => void;
  toggleOutputCollapse: () => void;
  toggleEditorCollapse: () => void;
  setPromptsCollapsed: (collapsed: boolean) => void;
  setOutputCollapsed: (collapsed: boolean) => void;
  setEditorCollapsed: (collapsed: boolean) => void;
  toggleDiffsCollapsed: () => void;
  setDiffsCollapsed: (collapsed: boolean) => void;
  expandAllDiffs: () => void;
  collapseAllDiffs: () => void;

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
  setTemplateFileSelection: (
    selection: { variable: string; path: string } | null
  ) => void;

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
  setActiveWorkflowWorkingFilePath: (path: string | null) => void;

  // Output / editor font size
  setOutputFontSize: (size: number) => void;
  // Terminal font size
  setTerminalFontSize: (size: number) => void;

  // Loading state
  setLoading: (loading: boolean, message?: string) => void;

  // Toast notifications
  showToast: (
    message: string,
    type?: "info" | "success" | "warning" | "error"
  ) => void;
  hideToast: () => void;

  // Terminal tab switching
  setActiveOutputTab: (workflowId: string, tab: "output" | "terminal") => void;
  setTerminalSessionActive: (workflowId: string, active: boolean) => void;

  // Terminal session rail layout
  setTerminalRailCollapsed: (collapsed: boolean) => void;
  setTerminalRailSizePx: (px: number) => void;

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

  // Footer quick picker
  setFooterOpenPicker: (
    picker:
      | "harness"
      | "model"
      | "agent"
      | "skills"
      | "permissions"
      | "context"
      | null
  ) => void;

  // MCP discovery
  setMcpDiscoveryTab: (tab: "local" | "registry") => void;
  setMcpLocalServersLoading: (loading: boolean) => void;
  setMcpLocalServersResult: (
    servers: LocalMcpServerEntry[],
    error?: string
  ) => void;
  setMcpRegistryLoading: (loading: boolean) => void;
  setMcpRegistryResult: (
    servers: RegistryMcpEntry[],
    query?: string,
    error?: string,
    nextCursor?: string
  ) => void;
  /** Navigate to the next registry page (appends nextCursor to page history) */
  mcpRegistryGoNextPage: () => string | undefined;
  /** Navigate to the previous registry page (trims page history, returns cursor to fetch) */
  mcpRegistryGoPrevPage: () => string | undefined;
  /** Reset pagination (e.g. on first load) */
  resetMcpRegistryPages: () => void;
  setMcpWorkspaceServersLoading: (loading: boolean) => void;
  setMcpWorkspaceServersResult: (
    servers: McpServerConfig[],
    error?: string
  ) => void;
  setMcpWorkspaceServers: (servers: McpServerConfig[]) => void;

  // Mobile drawer actions
  toggleMobilePrompts: () => void;
  setMobilePromptsMode: (mode: "sidebar" | "fullwidth") => void;
  toggleMobileSettings: () => void;
  closeMobilePrompts: () => void;
  closeMobileSettings: () => void;

  // Global settings drawer actions
  toggleGlobalSettings: () => void;
  closeGlobalSettings: () => void;
  setGlobalSettingsTab: (tab: string) => void;

  // Startup overlay
  setStartupReady: (ready: boolean) => void;
  setDevRestarting: (restarting: boolean) => void;

  // Client identity
  setMyClientId: (clientId: string) => void;

  // Reset UI to defaults
  resetUi: () => void;
}

const initialState: UiState = {
  hiddenDropdownOptions: {},
  saveWorkflowDialogOpen: false,
  saveWorkflowDialogData: null,
  stepsCollapsed: false,
  finalStepFooterExpanded: false,
  outputCollapsed: false,
  editorCollapsed: false,
  diffsCollapsed: true, // collapsed by default to keep the DOM lean
  diffResetVersion: 0,
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
  activeWorkflowWorkingFilePath: null,
  isLoading: false,
  loadingMessage: null,
  outputFontSize: 13,
  terminalFontSize: 14,
  toast: null,
  activeOutputTabs: {},
  terminalActiveWorkflows: new Set<string>(),
  terminalRailCollapsed: true,
  terminalRailSizePx: 140,
  isViewingHistory: false,
  viewingRunIndex: 0,
  availableRuns: 0,
  runTimestamps: [],
  runStates: [],
  footerOpenPicker: null,
  mcpDiscoveryTab: "registry",
  mcpLocalServers: [],
  mcpLocalServersLoading: false,
  mcpLocalServersError: undefined,
  mcpRegistryServers: undefined,
  mcpRegistryLoading: false,
  mcpRegistryError: undefined,
  mcpRegistryQuery: "",
  mcpRegistryNextCursor: undefined,
  mcpRegistryPageCursors: [undefined],
  mcpWorkspaceServers: undefined,
  mcpWorkspaceServersLoading: false,
  mobilePromptsOpen: false,
  mobilePromptsMode: "sidebar",
  mobileSettingsOpen: false,
  globalSettingsOpen: false,
  globalSettingsActiveTab: "general",
  startupReady: false,
  devRestarting: false,
  myClientId: "",
};

// Fields to persist via vscode.getState()/setState()
const persistedFields = [
  "stepsCollapsed",
  "outputCollapsed",
  "editorCollapsed",
  "settingsCollapsed",
  "defaultTemplateId",
  "hiddenDropdownOptions",
  "lastDesktopSizes",
  "lastMobileSizes",
  "diffsCollapsed",
  "outputFontSize",
  "terminalFontSize",
  "terminalRailCollapsed",
  "terminalRailSizePx",
  "mcpDiscoveryTab",
  "globalSettingsActiveTab",
  "activeWorkflowWorkingFilePath",
] as const;

export const useUiStore = create<UiState & UiActions>()(
  persist(
    (set, get) => ({
      ...initialState,

      // ============================================================================
      // SECTION TOGGLES
      // ============================================================================

      togglePromptsCollapse: () =>
        set((state) => ({ stepsCollapsed: !state.stepsCollapsed })),

      toggleFinalStepFooterExpanded: () =>
        set((state) => ({
          finalStepFooterExpanded: !state.finalStepFooterExpanded,
        })),

      setFinalStepFooterExpanded: (expanded) =>
        set({ finalStepFooterExpanded: expanded }),

      toggleOutputCollapse: () =>
        set((state) => ({ outputCollapsed: !state.outputCollapsed })),

      toggleEditorCollapse: () =>
        set((state) => ({ editorCollapsed: !state.editorCollapsed })),

      setPromptsCollapsed: (collapsed) => set({ stepsCollapsed: collapsed }),

      setOutputCollapsed: (collapsed) => set({ outputCollapsed: collapsed }),

      setEditorCollapsed: (collapsed) => set({ editorCollapsed: collapsed }),

      toggleDiffsCollapsed: () =>
        set((state) => ({ diffsCollapsed: !state.diffsCollapsed })),

      setDiffsCollapsed: (collapsed) => set({ diffsCollapsed: collapsed }),

      expandAllDiffs: () =>
        set((state) => ({
          diffsCollapsed: false,
          diffResetVersion: state.diffResetVersion + 1,
        })),

      collapseAllDiffs: () =>
        set((state) => ({
          diffsCollapsed: true,
          diffResetVersion: state.diffResetVersion + 1,
        })),

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

      setTemplateFileSelection: (selection) =>
        set({ templateFileSelection: selection }),

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

      setActiveWorkflowWorkingFilePath: (path) =>
        set({ activeWorkflowWorkingFilePath: path }),

      // ============================================================================
      // OUTPUT FONT SIZE
      // ============================================================================

      setOutputFontSize: (size) =>
        set({ outputFontSize: Math.min(24, Math.max(10, size)) }),

      setTerminalFontSize: (size) =>
        set({ terminalFontSize: Math.min(24, Math.max(10, size)) }),

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
      // TERMINAL TAB STATE
      // ============================================================================

      setActiveOutputTab: (workflowId: string, tab: "output" | "terminal") =>
        set((state) => ({
          activeOutputTabs: { ...state.activeOutputTabs, [workflowId]: tab },
        })),

      setTerminalSessionActive: (workflowId: string, active: boolean) =>
        set((state) => {
          const next = new Set(state.terminalActiveWorkflows);
          if (active) {
            next.add(workflowId);
          } else {
            next.delete(workflowId);
          }
          return { terminalActiveWorkflows: next };
        }),

      // ============================================================================
      // TERMINAL SESSION RAIL LAYOUT
      // ============================================================================

      setTerminalRailCollapsed: (collapsed) =>
        set({ terminalRailCollapsed: collapsed }),

      setTerminalRailSizePx: (px) => set({ terminalRailSizePx: px }),

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
      // FOOTER QUICK PICKER
      // ============================================================================

      setFooterOpenPicker: (picker) => set({ footerOpenPicker: picker }),

      // ============================================================================
      // MCP DISCOVERY
      // ============================================================================

      setMcpDiscoveryTab: (tab) => set({ mcpDiscoveryTab: tab }),

      setMcpLocalServersLoading: (loading) =>
        set({ mcpLocalServersLoading: loading }),

      setMcpLocalServersResult: (servers, error) =>
        set({
          mcpLocalServers: servers,
          mcpLocalServersLoading: false,
          mcpLocalServersError: error,
        }),

      setMcpRegistryLoading: (loading) => set({ mcpRegistryLoading: loading }),

      setMcpRegistryResult: (servers, query, error, nextCursor) =>
        set({
          mcpRegistryServers: servers,
          mcpRegistryLoading: false,
          mcpRegistryError: error,
          mcpRegistryQuery: query ?? "",
          mcpRegistryNextCursor: nextCursor,
        }),

      mcpRegistryGoNextPage: () => {
        const state = get();
        const cursor = state.mcpRegistryNextCursor;
        if (!cursor) return undefined;
        set({
          mcpRegistryPageCursors: [...state.mcpRegistryPageCursors, cursor],
        });
        return cursor;
      },

      mcpRegistryGoPrevPage: () => {
        const state = get();
        const pages = state.mcpRegistryPageCursors;
        if (pages.length <= 1) return undefined;
        const newPages = pages.slice(0, -1);
        const prevCursor = newPages[newPages.length - 1];
        set({ mcpRegistryPageCursors: newPages });
        return prevCursor;
      },

      resetMcpRegistryPages: () =>
        set({
          mcpRegistryPageCursors: [undefined],
          mcpRegistryNextCursor: undefined,
        }),

      setMcpWorkspaceServersLoading: (loading) =>
        set({ mcpWorkspaceServersLoading: loading }),

      setMcpWorkspaceServersResult: (servers, _error) =>
        set({
          mcpWorkspaceServers: servers,
          mcpWorkspaceServersLoading: false,
        }),

      setMcpWorkspaceServers: (servers) =>
        set({ mcpWorkspaceServers: servers }),

      // ============================================================================
      // MOBILE DRAWER
      // ============================================================================

      toggleMobilePrompts: () =>
        set((state) => ({ mobilePromptsOpen: !state.mobilePromptsOpen })),

      setMobilePromptsMode: (mode) => set({ mobilePromptsMode: mode }),

      toggleMobileSettings: () =>
        set((state) => ({ mobileSettingsOpen: !state.mobileSettingsOpen })),

      closeMobilePrompts: () => set({ mobilePromptsOpen: false }),

      closeMobileSettings: () => set({ mobileSettingsOpen: false }),

      // ============================================================================
      // GLOBAL SETTINGS DRAWER
      // ============================================================================

      toggleGlobalSettings: () =>
        set((state) => ({ globalSettingsOpen: !state.globalSettingsOpen })),

      closeGlobalSettings: () => set({ globalSettingsOpen: false }),

      setGlobalSettingsTab: (tab) => set({ globalSettingsActiveTab: tab }),

      // ============================================================================
      // STARTUP OVERLAY
      // ============================================================================

      setStartupReady: (ready) =>
        set({
          startupReady: ready,
          ...(ready ? { devRestarting: false } : {}),
        }),
      setDevRestarting: (restarting) =>
        set({ devRestarting: restarting, startupReady: !restarting }),
      setMyClientId: (clientId) => set({ myClientId: clientId }),

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
          footerOpenPicker: null,
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
