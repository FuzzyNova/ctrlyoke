import { create } from "zustand";
import { PROVIDER_IDS, type ProviderId } from "../types/messages";

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
 * Provider status information
 */
export interface ProviderStatus {
  available: boolean;
  status: "checking" | "available" | "not_available";
  message?: string;
}

/**
 * Global settings (from VS Code settings, read-only in webview)
 */
export interface GlobalSettings {
  provider: ProviderId;
  model: string;
  agent: string;
  executionMode: "interactive" | "headless";
  resumeSession: boolean;
  allowDynamicExtension: boolean;
}

/**
 * Workflow properties (from working file, can override global settings)
 */
export interface WorkflowProperties {
  provider?: string;
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
 * Settings state - Provider/model configuration and global settings
 */
interface SettingsState {
  // Model options per provider (populated from ModelRegistry)
  modelOptions: Record<ProviderId, ModelOption[]>;

  // Available agents (from workspace discovery)
  availableAgents: AgentOption[];

  // Provider status (checking/available/unavailable)
  providerStatus: Record<ProviderId, ProviderStatus>;

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
  getModelsForProvider: (provider: ProviderId) => ModelOption[];

  // Agents
  setAvailableAgents: (agents: AgentOption[]) => void;

  // Provider status
  setProviderStatus: (provider: ProviderId, status: ProviderStatus) => void;
  setAllProviderStatuses: (statuses: Record<string, ProviderStatus>) => void;
  isProviderAvailable: (provider: ProviderId) => boolean;

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
  getEffectiveProvider: () => ProviderId;
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
  provider: PROVIDER_IDS.COPILOT_CLI as ProviderId,
  model: "claude-sonnet-4.5",
  agent: "",
  executionMode: "interactive",
  resumeSession: false,
  allowDynamicExtension: false,
};

const initialProviderStatus: Record<ProviderId, ProviderStatus> = {
  [PROVIDER_IDS.COPILOT_CLI]: { available: false, status: "checking" },
  [PROVIDER_IDS.COPILOT_CHAT]: { available: false, status: "checking" },
  [PROVIDER_IDS.CLAUDE_CLI]: { available: false, status: "checking" },
  [PROVIDER_IDS.CODEX_CLI]: { available: false, status: "checking" },
};

const initialState: SettingsState = {
  modelOptions: {
    [PROVIDER_IDS.COPILOT_CLI]: [],
    [PROVIDER_IDS.COPILOT_CHAT]: [],
    [PROVIDER_IDS.CLAUDE_CLI]: CLAUDE_CLI_MODELS,
    [PROVIDER_IDS.CODEX_CLI]: CODEX_CLI_MODELS,
  },
  availableAgents: [],
  providerStatus: initialProviderStatus,
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
        } as Record<ProviderId, ModelOption[]>,
      })),

    getModelsForProvider: (provider) => {
      const { modelOptions } = get();
      return modelOptions[provider] ?? [];
    },

    // ============================================================================
    // AGENTS
    // ============================================================================

    setAvailableAgents: (agents) => set({ availableAgents: agents }),

    // ============================================================================
    // PROVIDER STATUS
    // ============================================================================

    setProviderStatus: (provider, status) =>
      set((state) => ({
        providerStatus: {
          ...state.providerStatus,
          [provider]: status,
        },
      })),

    setAllProviderStatuses: (statuses) =>
      set((state) => ({
        providerStatus: {
          ...state.providerStatus,
          ...statuses,
        } as Record<ProviderId, ProviderStatus>,
      })),

    isProviderAvailable: (provider) => {
      const { providerStatus } = get();
      return providerStatus[provider]?.available ?? false;
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

    getEffectiveProvider: () => {
      const { workflowProperties, globalSettings } = get();
      return (
        (workflowProperties.provider as ProviderId) ?? globalSettings.provider
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
        // Keep model options, agents, and provider status (they're global)
      }),
  })
);
