import { create } from "zustand";
import {
  HARNESS_IDS,
  HARNESS_STATUS_STRINGS,
  type HarnessId,
  type HarnessStatusString,
} from "../types/messages";

/**
 * Model option for dropdowns
 */
export interface ModelOption {
  value: string;
  label: string;
}

/**
 * Agent option for dropdowns
 */
export interface AgentOption {
  name: string;
  path: string;
  description?: string;
}

/**
 * Harness status information
 */
export interface HarnessStatus {
  available: boolean;
  status: HarnessStatusString;
  message?: string;
}

/**
 * Global settings (from VS Code settings, read-only in webview)
 */
export interface GlobalSettings {
  harness: HarnessId;
  model: string;
  harnessDefaultModels: Record<string, string>;
  agent: string;
  executionMode: "interactive" | "headless";
  resumeSession: boolean;
  allowDynamicExtension: boolean;
  respectGitignore: boolean;
}

/**
 * Workflow properties (from working file, can override global settings)
 */
export interface WorkflowProperties {
  harness?: string;
  model?: string;
  agent?: string;
  resumeSession?: boolean;
  sessionId?: string | number; // UUID string or prompt number reference
  allowDynamicExtension?: boolean;
  endCondition?: {
    script?: string; // Made optional - fields can be set incrementally
    returns?: string;
    timeout?: number;
    maxRetries?: number;
    retryPrompt?: string;
  } | null;
}

/**
 * Settings state - Harness/model configuration and global settings
 */
interface SettingsState {
  // Model options per harness (populated from ModelRegistry)
  modelOptions: Record<HarnessId, ModelOption[]>;

  // Available agents (from workspace discovery)
  availableAgents: AgentOption[];

  // Harness status (checking/available/unavailable)
  harnessStatus: Record<HarnessId, HarnessStatus>;

  // Global settings (from VS Code)
  globalSettings: GlobalSettings;

  // Workflow-level properties (can override global settings)
  workflowProperties: WorkflowProperties;

  // Whether workflow is loaded (enables settings panel)
  workflowLoaded: boolean;
}

/**
 * Settings actions
 */
interface SettingsActions {
  // Model options
  setModelOptions: (options: Record<string, ModelOption[]>) => void;
  getModelsForHarness: (harness: HarnessId) => ModelOption[];

  // Agents
  setAvailableAgents: (agents: AgentOption[]) => void;

  // Harness status
  setHarnessStatus: (harness: HarnessId, status: HarnessStatus) => void;
  setAllHarnessStatuses: (statuses: Record<string, HarnessStatus>) => void;
  isHarnessAvailable: (harness: HarnessId) => boolean;

  // Global settings
  setGlobalSettings: (settings: GlobalSettings) => void;
  updateGlobalSetting: <K extends keyof GlobalSettings>(
    key: K,
    value: GlobalSettings[K]
  ) => void;

  // Workflow properties
  setWorkflowProperties: (properties: WorkflowProperties) => void;
  updateWorkflowProperty: <K extends keyof WorkflowProperties>(
    key: K,
    value: WorkflowProperties[K]
  ) => void;
  clearWorkflowProperties: () => void;

  // Workflow loaded state
  setWorkflowLoaded: (loaded: boolean) => void;

  // Effective value resolution (workflow > global)
  getEffectiveHarness: () => HarnessId;
  getEffectiveModel: () => string;
  getEffectiveAgent: () => string;
  getEffectiveResumeSession: () => boolean;
  getEffectiveAllowDynamicExtension: () => boolean;

  // Reset
  resetSettings: () => void;
}

/**
 * Claude CLI static models (no programmatic way to query)
 */
const CLAUDE_CLI_MODELS: ModelOption[] = [
  { value: "sonnet", label: "Sonnet" },
  { value: "sonnet[1m]", label: "Sonnet 1M Context" },
  { value: "opus", label: "Opus" },
  { value: "haiku", label: "Haiku" },
];

/**
 * Codex CLI static models
 */
const CODEX_CLI_MODELS: ModelOption[] = [
  { value: "gpt-5.2-codex", label: "GPT 5.2 Codex" },
  { value: "gpt-5.1-codex-max", label: "GPT 5.1 Codex Max" },
  { value: "gpt-5.1-codex-mini", label: "GPT 5.1 Codex Mini" },
  { value: "gpt-5.2", label: "GPT 5.2" },
];

const initialGlobalSettings: GlobalSettings = {
  harness: HARNESS_IDS.COPILOT_CLI as HarnessId,
  model: "claude-sonnet-4.5",
  harnessDefaultModels: {},
  agent: "",
  executionMode: "interactive",
  resumeSession: false,
  allowDynamicExtension: false,
  respectGitignore: true,
};

const initialHarnessStatus: Record<HarnessId, HarnessStatus> = {
  [HARNESS_IDS.COPILOT_CLI]: {
    available: false,
    status: HARNESS_STATUS_STRINGS.CHECKING,
  },
  [HARNESS_IDS.COPILOT_CHAT]: {
    available: false,
    status: HARNESS_STATUS_STRINGS.CHECKING,
  },
  [HARNESS_IDS.CLAUDE_CLI]: {
    available: false,
    status: HARNESS_STATUS_STRINGS.CHECKING,
  },
  [HARNESS_IDS.CODEX_CLI]: {
    available: false,
    status: HARNESS_STATUS_STRINGS.CHECKING,
  },
};

const initialState: SettingsState = {
  modelOptions: {
    [HARNESS_IDS.COPILOT_CLI]: [],
    [HARNESS_IDS.COPILOT_CHAT]: [],
    [HARNESS_IDS.CLAUDE_CLI]: CLAUDE_CLI_MODELS,
    [HARNESS_IDS.CODEX_CLI]: CODEX_CLI_MODELS,
  },
  availableAgents: [],
  harnessStatus: initialHarnessStatus,
  globalSettings: initialGlobalSettings,
  workflowProperties: {},
  workflowLoaded: false,
};

export const useSettingsStore = create<SettingsState & SettingsActions>(
  (set, get) => ({
    ...initialState,

    // ============================================================================
    // MODEL OPTIONS
    // ============================================================================

    setModelOptions: (options) =>
      set((state) => ({
        modelOptions: {
          ...state.modelOptions,
          ...options,
        } as Record<HarnessId, ModelOption[]>,
      })),

    getModelsForHarness: (harness) => {
      const { modelOptions } = get();
      return modelOptions[harness] ?? [];
    },

    // ============================================================================
    // AGENTS
    // ============================================================================

    setAvailableAgents: (agents) => set({ availableAgents: agents }),

    // ============================================================================
    // HARNESS STATUS
    // ============================================================================

    setHarnessStatus: (harness, status) =>
      set((state) => ({
        harnessStatus: {
          ...state.harnessStatus,
          [harness]: status,
        },
      })),

    setAllHarnessStatuses: (statuses) =>
      set((state) => ({
        harnessStatus: {
          ...state.harnessStatus,
          ...statuses,
        } as Record<HarnessId, HarnessStatus>,
      })),

    isHarnessAvailable: (harness) => {
      const { harnessStatus: harnessStatus } = get();
      return harnessStatus[harness]?.available ?? false;
    },

    // ============================================================================
    // GLOBAL SETTINGS
    // ============================================================================

    setGlobalSettings: (settings) => set({ globalSettings: settings }),

    updateGlobalSetting: (key, value) =>
      set((state) => ({
        globalSettings: { ...state.globalSettings, [key]: value },
      })),

    // ============================================================================
    // WORKFLOW PROPERTIES
    // ============================================================================

    setWorkflowProperties: (properties) =>
      set({ workflowProperties: properties }),

    updateWorkflowProperty: (key, value) =>
      set((state) => ({
        workflowProperties: { ...state.workflowProperties, [key]: value },
      })),

    clearWorkflowProperties: () => set({ workflowProperties: {} }),

    // ============================================================================
    // WORKFLOW LOADED STATE
    // ============================================================================

    setWorkflowLoaded: (loaded) => set({ workflowLoaded: loaded }),

    // ============================================================================
    // EFFECTIVE VALUE RESOLUTION (Workflow > Global)
    // ============================================================================

    getEffectiveHarness: () => {
      const { workflowProperties, globalSettings } = get();
      return (
        (workflowProperties.harness as HarnessId) ?? globalSettings.harness
      );
    },

    getEffectiveModel: () => {
      const { workflowProperties, globalSettings } = get();
      return workflowProperties.model ?? globalSettings.model;
    },

    getEffectiveAgent: () => {
      const { workflowProperties, globalSettings } = get();
      return workflowProperties.agent ?? globalSettings.agent;
    },

    getEffectiveResumeSession: () => {
      const { workflowProperties, globalSettings } = get();
      return workflowProperties.resumeSession ?? globalSettings.resumeSession;
    },

    getEffectiveAllowDynamicExtension: () => {
      const { workflowProperties, globalSettings } = get();
      return (
        workflowProperties.allowDynamicExtension ??
        globalSettings.allowDynamicExtension
      );
    },

    // ============================================================================
    // RESET
    // ============================================================================

    resetSettings: () =>
      set({
        workflowProperties: {},
        workflowLoaded: false,
        // Keep model options, agents, and harness status (they're global)
      }),
  })
);
