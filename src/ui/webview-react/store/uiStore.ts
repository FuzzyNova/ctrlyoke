import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { vsCodeRawStorage } from "@utils/vsCodeStateStorage";
import type { WorkflowSummary } from "../types/messages";
import { type FooterPicker } from "../types/messages";
import type { OutputExecutionTarget } from "@root/types/OutputHistoryTypes";
import type {
  HistorySearchIndexState,
  HistorySearchResult,
} from "@root/types/WorkflowTimelineTypes";
import { DEFAULT_DESKTOP_SIZES, DEFAULT_MOBILE_SIZES } from "../constants";

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
  workflowName: string;
  filePath: string;
  executionState: string;
  lastModifiedAt?: number;
  startedAt?: number;
  isFavorite?: boolean;
}

/** Panel size snapshot for the desktop layout (steps/settings/editor in px; output as %). */
export interface DesktopPanelSizes {
  steps: number;
  output: number;
  editor: number;
  settings: number;
}

/** Panel size snapshot for the mobile layout (editor in px; output as %). */
export interface MobilePanelSizes {
  output: number;
  editor: number;
}

export type OutputScrollTarget =
  | { kind: "row"; rowKey: string; viewportOffsetPx: number }
  | { kind: "bottom" };

export interface PendingOutputFindRequest {
  query: string;
  preferredTarget?: OutputExecutionTarget;
}

export function areOutputScrollTargetsEqual(
  left: OutputScrollTarget | undefined,
  right: OutputScrollTarget | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "bottom") {
    return true;
  }
  if (right.kind !== "row") {
    return false;
  }

  return (
    left.rowKey === right.rowKey &&
    Math.abs(left.viewportOffsetPx - right.viewportOffsetPx) < 0.5
  );
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

  // Separate persisted preference for the undo/redo dialog's expand/collapse state.
  // Kept independent from diffsCollapsed so users can configure each independently.
  undoDialogDiffsCollapsed: boolean;

  // Persisted panel sizes — restored to useRef on mount, written back on resize
  lastDesktopSizes: DesktopPanelSizes;
  lastMobileSizes: MobilePanelSizes;

  // Drawer state
  propertiesDrawerOpen: boolean;

  // Settings panel collapse
  settingsCollapsed: boolean;

  // Output panel state
  selectedOutputStep: number | null; // Which step's output to show (null = current)
  outputScrollTargets: Record<string, OutputScrollTarget>; // transient per-workflow output scroll memory
  pendingFindRequest: PendingOutputFindRequest | null;

  // History search drawer state (transient, not persisted)
  isHistorySearchOpen: boolean;
  historySearchResults: HistorySearchResult[];
  historySearchQuery: string;
  historySearchLoading: boolean;
  historySearchLoadingMore: boolean;
  historySearchTotalCount: number;
  historySearchNextCursor?: string;
  historySearchHasMore: boolean;
  historySearchIndexState: HistorySearchIndexState;
  pendingHistorySearchNavigation: {
    workflowId: string;
    workflowFilePath: string;
    runIndex: number;
    findQuery: string;
    target: OutputExecutionTarget;
  } | null;

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

  // Content preview modal (git diff / prior-context XML) — transient, not persisted
  contentPreviewModal: {
    title: string;
    content: string;
    language: "diff" | "xml";
    ref: string;
  } | null;

  // Footer quick picker state (transient, not persisted)
  footerOpenPicker: FooterPicker | null;

  // Mobile drawer/overlay state — persisted so user preference survives restarts
  mobileStepsOpen: boolean;
  mobileStepsMode: "sidebar" | "fullwidth";
  mobileWorkflowPropsOpen: boolean;
  horizontalPanelResizeActive: boolean;

  // Global settings drawer state
  globalSettingsOpen: boolean;
  globalSettingsActiveTab: string;

  // Startup overlay — true once STARTUP_COMPLETE (or WORKFLOW_LOADED) is received.
  // NOT persisted: every panel open should show the overlay until startup settles.
  startupReady: boolean;
  devRestarting: boolean;
  /** True when FlightPath has not yet been initialized in this workspace and the user must approve before startup proceeds. */
  workspaceInitRequired: boolean;
  /** True after workspace init when the user should choose a panel layout preference (first install only). */
  showLayoutPreference: boolean;

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
  setUndoDialogDiffsCollapsed: (collapsed: boolean) => void;

  // Panel sizes (persisted, written from App.tsx resize handlers)
  setLastDesktopSizes: (sizes: Partial<DesktopPanelSizes>) => void;
  setLastMobileSizes: (sizes: Partial<MobilePanelSizes>) => void;

  // Drawer toggles
  togglePropertiesDrawer: () => void;
  openPropertiesDrawer: () => void;
  closePropertiesDrawer: () => void;

  // Settings panel
  toggleSettingsCollapse: () => void;
  setSettingsCollapsed: (collapsed: boolean) => void;

  // Output panel
  selectOutputStep: (stepIndex: number | null) => void;
  setOutputScrollTarget: (
    workflowId: string,
    target: OutputScrollTarget
  ) => void;
  setPendingFindRequest: (request: PendingOutputFindRequest | null) => void;
  openHistorySearch: () => void;
  closeHistorySearch: () => void;
  setHistorySearchQuery: (query: string) => void;
  setHistorySearchResults: (
    results: HistorySearchResult[],
    loading: boolean,
    options?: {
      append?: boolean;
      totalCount?: number;
      nextCursor?: string;
      hasMore?: boolean;
      indexState?: HistorySearchIndexState;
      loadingMore?: boolean;
    }
  ) => void;
  setPendingHistorySearchNavigation: (
    nav: {
      workflowId: string;
      workflowFilePath: string;
      runIndex: number;
      findQuery: string;
      target: OutputExecutionTarget;
    } | null
  ) => void;

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

  // Content preview modal
  setContentPreviewModal: (
    modal: {
      title: string;
      content: string;
      language: "diff" | "xml";
      ref: string;
    } | null
  ) => void;

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

  // Mobile drawer actions
  toggleMobileSteps: () => void;
  setMobileStepsMode: (mode: "sidebar" | "fullwidth") => void;
  toggleMobileWorkflowProps: () => void;
  closeMobileSteps: () => void;
  closeMobileWorkflowProps: () => void;
  setHorizontalPanelResizeActive: (active: boolean) => void;

  // Global settings drawer actions
  toggleGlobalSettings: () => void;
  closeGlobalSettings: () => void;
  setGlobalSettingsTab: (tab: string) => void;

  // Startup overlay
  setStartupReady: (ready: boolean) => void;
  setDevRestarting: (restarting: boolean) => void;
  setWorkspaceInitRequired: (required: boolean) => void;
  setShowLayoutPreference: (show: boolean) => void;

  // Client identity
  setMyClientId: (clientId: string) => void;

  // Reset UI to defaults
  resetUi: () => void;
  // Reset persisted layout state to initial defaults (for dev testing)
  resetLayoutState: () => void;
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
  undoDialogDiffsCollapsed: true, // dialog defaults collapsed independently
  lastDesktopSizes: { ...DEFAULT_DESKTOP_SIZES },
  lastMobileSizes: { ...DEFAULT_MOBILE_SIZES },
  propertiesDrawerOpen: false,
  settingsCollapsed: false,
  selectedOutputStep: null,
  outputScrollTargets: {},
  pendingFindRequest: null,
  isHistorySearchOpen: false,
  historySearchResults: [],
  historySearchQuery: "",
  historySearchLoading: false,
  historySearchLoadingMore: false,
  historySearchTotalCount: 0,
  historySearchNextCursor: undefined,
  historySearchHasMore: false,
  historySearchIndexState: "ready",
  pendingHistorySearchNavigation: null,
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
  contentPreviewModal: null,
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
  mobileStepsOpen: false,
  mobileStepsMode: "fullwidth",
  mobileWorkflowPropsOpen: false,
  horizontalPanelResizeActive: false,
  globalSettingsOpen: false,
  globalSettingsActiveTab: "general",
  startupReady: false,
  devRestarting: false,
  workspaceInitRequired: false,
  showLayoutPreference: false,
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
  "undoDialogDiffsCollapsed",
  "outputFontSize",
  "terminalFontSize",
  "terminalRailCollapsed",
  "terminalRailSizePx",
  "globalSettingsActiveTab",
  "activeWorkflowWorkingFilePath",
  "mobileStepsOpen",
  "mobileStepsMode",
] as const;

export const useUiStore = create<UiState & UiActions>()(
  persist(
    (set) => ({
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

      setUndoDialogDiffsCollapsed: (collapsed) =>
        set({ undoDialogDiffsCollapsed: collapsed }),

      // ============================================================================
      // PANEL SIZES
      // ============================================================================

      setLastDesktopSizes: (sizes) =>
        set((state) => {
          const next = { ...state.lastDesktopSizes, ...sizes };
          if (
            next.steps === state.lastDesktopSizes.steps &&
            next.output === state.lastDesktopSizes.output &&
            next.editor === state.lastDesktopSizes.editor &&
            next.settings === state.lastDesktopSizes.settings
          ) {
            return state;
          }
          return { lastDesktopSizes: next };
        }),

      setLastMobileSizes: (sizes) =>
        set((state) => {
          const next = { ...state.lastMobileSizes, ...sizes };
          if (
            next.output === state.lastMobileSizes.output &&
            next.editor === state.lastMobileSizes.editor
          ) {
            return state;
          }
          return { lastMobileSizes: next };
        }),

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

      setOutputScrollTarget: (workflowId, target) =>
        set((state) => {
          const previous = state.outputScrollTargets[workflowId];
          if (areOutputScrollTargetsEqual(previous, target)) {
            return state;
          }

          return {
            outputScrollTargets: {
              ...state.outputScrollTargets,
              [workflowId]: target,
            },
          };
        }),

      setPendingFindRequest: (request) => set({ pendingFindRequest: request }),

      openHistorySearch: () =>
        set({ isHistorySearchOpen: true, globalSettingsOpen: false }),

      closeHistorySearch: () =>
        set({
          isHistorySearchOpen: false,
          historySearchLoading: false,
          historySearchLoadingMore: false,
        }),

      setHistorySearchQuery: (query) =>
        set({
          historySearchQuery: query,
          historySearchNextCursor: undefined,
          historySearchHasMore: false,
          historySearchTotalCount: 0,
        }),

      setHistorySearchResults: (results, loading, options) =>
        set((state) => ({
          historySearchResults: options?.append
            ? [...state.historySearchResults, ...results]
            : results,
          historySearchLoading: loading,
          historySearchLoadingMore: options?.loadingMore ?? false,
          historySearchTotalCount:
            options?.totalCount ??
            (options?.append ? state.historySearchTotalCount : results.length),
          historySearchNextCursor: options?.nextCursor,
          historySearchHasMore: options?.hasMore ?? false,
          historySearchIndexState:
            options?.indexState ?? state.historySearchIndexState,
        })),

      setPendingHistorySearchNavigation: (nav) =>
        set({ pendingHistorySearchNavigation: nav }),

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
        set({ terminalFontSize: Math.min(24, Math.max(8, size)) }),

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

      setContentPreviewModal: (modal) => set({ contentPreviewModal: modal }),

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
      // MOBILE DRAWER
      // ============================================================================

      toggleMobileSteps: () =>
        set((state) => ({ mobileStepsOpen: !state.mobileStepsOpen })),

      setMobileStepsMode: (mode) => set({ mobileStepsMode: mode }),

      toggleMobileWorkflowProps: () =>
        set((state) => ({
          mobileWorkflowPropsOpen: !state.mobileWorkflowPropsOpen,
        })),

      closeMobileSteps: () => set({ mobileStepsOpen: false }),

      closeMobileWorkflowProps: () => set({ mobileWorkflowPropsOpen: false }),

      setHorizontalPanelResizeActive: (active) =>
        set((state) =>
          state.horizontalPanelResizeActive === active
            ? state
            : { horizontalPanelResizeActive: active }
        ),

      // ============================================================================
      // GLOBAL SETTINGS DRAWER
      // ============================================================================

      toggleGlobalSettings: () =>
        set((state) => ({
          globalSettingsOpen: !state.globalSettingsOpen,
          isHistorySearchOpen: false,
          historySearchLoading: false,
        })),

      closeGlobalSettings: () => set({ globalSettingsOpen: false }),

      setGlobalSettingsTab: (tab) => set({ globalSettingsActiveTab: tab }),

      // ============================================================================
      // STARTUP OVERLAY
      // ============================================================================

      setStartupReady: (ready) =>
        set({
          startupReady: ready,
          ...(ready
            ? {
                devRestarting: false,
                workspaceInitRequired: false,
                showLayoutPreference: false,
              }
            : {}),
        }),
      setDevRestarting: (restarting) =>
        set({ devRestarting: restarting, startupReady: !restarting }),

      setWorkspaceInitRequired: (required) =>
        set({ workspaceInitRequired: required }),

      setShowLayoutPreference: (show) => set({ showLayoutPreference: show }),

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
          isHistorySearchOpen: false,
          historySearchResults: [],
          historySearchQuery: "",
          historySearchLoading: false,
          historySearchLoadingMore: false,
          historySearchTotalCount: 0,
          historySearchNextCursor: undefined,
          historySearchHasMore: false,
          historySearchIndexState: "ready",
          pendingHistorySearchNavigation: null,
          pendingFindRequest: null,
          recentWorkflows: [],
          recentWorkflowsDropdownOpen: false,
          isLoading: false,
          loadingMessage: null,
          outputScrollTargets: {},
          toast: null,
          footerOpenPicker: null,
          horizontalPanelResizeActive: false,
        }),

      resetLayoutState: () => {
        // Remove the persisted key from vscode state so the next reload starts fresh.
        // Calling set() immediately after re-persists the defaults, so the current
        // session also reflects the initial values.
        void useUiStore.persist.clearStorage();
        set({
          stepsCollapsed: initialState.stepsCollapsed,
          outputCollapsed: initialState.outputCollapsed,
          editorCollapsed: initialState.editorCollapsed,
          settingsCollapsed: initialState.settingsCollapsed,
          lastDesktopSizes: { ...initialState.lastDesktopSizes },
          lastMobileSizes: { ...initialState.lastMobileSizes },
          mobileStepsOpen: initialState.mobileStepsOpen,
          mobileStepsMode: initialState.mobileStepsMode,
          terminalRailCollapsed: initialState.terminalRailCollapsed,
          terminalRailSizePx: initialState.terminalRailSizePx,
          diffsCollapsed: initialState.diffsCollapsed,
          undoDialogDiffsCollapsed: initialState.undoDialogDiffsCollapsed,
          outputFontSize: initialState.outputFontSize,
          terminalFontSize: initialState.terminalFontSize,
        });
      },
    }),
    {
      name: "flightpath-ui-state",
      // Rehydrated explicitly from main.tsx before App mounts so retained
      // panel reconnects do not call vscode.getState() during module import.
      skipHydration: true,
      storage: createJSONStorage(() => vsCodeRawStorage),
      // Only persist specific fields (layout preferences)
      partialize: (state) =>
        Object.fromEntries(
          persistedFields.map((key) => [key, state[key]])
        ) as Pick<UiState, (typeof persistedFields)[number]>,
    }
  )
);
