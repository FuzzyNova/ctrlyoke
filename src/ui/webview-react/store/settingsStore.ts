import { create } from "zustand";
import {
  HARNESS_IDS,
  HARNESS_STATUS_STRINGS,
  type HarnessId,
  type HarnessStatusString,
  type PriorContext,
} from "../types/messages";
import {
  CLAUDE_CLI_MODELS as CLAUDE_CLI_MODEL_LIST,
  CODEX_CLI_MODELS as CODEX_CLI_MODEL_LIST,
  QWEN_CLI_MODELS as QWEN_CLI_MODEL_LIST,
  GEMINI_CLI_MODELS as GEMINI_CLI_MODEL_LIST,
} from "@root/types/DashboardConstants";

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
 * Skill option for multi-select dropdowns
 */
export interface SkillOption {
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
  harnessDefaultAdditionalArgs: Record<string, string>;
  agent: string;
  skills: string[];
  executionMode: "interactive" | "headless";
  resumeSession: boolean;
  allowDynamicExtension: boolean;
  respectGitignore: boolean;
  confirmDeleteOperations: boolean;
  confirmResetOperations: boolean;
  priorContext: string;
  workspaceRoot: string;
}

/**
 * Workflow properties (from working file, can override global settings)
 */
export interface WorkflowProperties {
  harness?: string;
  model?: string;
  agent?: string | null;
  skills?: string[] | null;
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
  priorContext?: PriorContext;
  additionalArgs?: string | null;
}

/**
 * Settings state - Harness/model configuration and global settings
 */
interface SettingsState {
  // Model options per harness (populated from ModelRegistry)
  modelOptions: Record<HarnessId, ModelOption[]>;

  // Available agents (from workspace discovery)
  availableAgents: AgentOption[];

  // Available skills (from workspace and user discovery)
  availableSkills: SkillOption[];

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

  // Skills
  setAvailableSkills: (skills: SkillOption[]) => void;
  getEffectiveSkills: () => string[];

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
  getEffectivePriorContext: () => PriorContext;

  // Reset
  resetSettings: () => void;
}

// Model lists imported from DashboardConstants (single source of truth)
const CLAUDE_CLI_MODELS: ModelOption[] = [...CLAUDE_CLI_MODEL_LIST];
const CODEX_CLI_MODELS: ModelOption[] = [...CODEX_CLI_MODEL_LIST];
const QWEN_CLI_MODELS: ModelOption[] = [...QWEN_CLI_MODEL_LIST];
const GEMINI_CLI_MODELS: ModelOption[] = [...GEMINI_CLI_MODEL_LIST];

const initialGlobalSettings: GlobalSettings = {
  harness: HARNESS_IDS.COPILOT_CLI as HarnessId,
  model: "claude-sonnet-4.5",
  harnessDefaultModels: {},
  harnessDefaultAdditionalArgs: {},
  agent: "",
  skills: [],
  executionMode: "interactive",
  resumeSession: false,
  allowDynamicExtension: false,
  respectGitignore: true,
  confirmDeleteOperations: true,
  confirmResetOperations: true,
  priorContext: "none",
  workspaceRoot: "",
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
  [HARNESS_IDS.OPENCODE_CLI]: {
    available: false,
    status: HARNESS_STATUS_STRINGS.CHECKING,
  },
  [HARNESS_IDS.QWEN_CLI]: {
    available: false,
    status: HARNESS_STATUS_STRINGS.CHECKING,
  },
  [HARNESS_IDS.GEMINI_CLI]: {
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
    [HARNESS_IDS.OPENCODE_CLI]: [],
    [HARNESS_IDS.QWEN_CLI]: QWEN_CLI_MODELS,
    [HARNESS_IDS.GEMINI_CLI]: GEMINI_CLI_MODELS,
  },
  availableAgents: [],
  availableSkills: [],
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
    // SKILLS
    // ============================================================================

    setAvailableSkills: (skills) => set({ availableSkills: skills }),

    getEffectiveSkills: () => {
      const { workflowProperties, globalSettings } = get();
      return workflowProperties.skills === undefined
        ? (globalSettings.skills ?? [])
        : (workflowProperties.skills ?? []);
    },

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
      return workflowProperties.agent === undefined
        ? globalSettings.agent
        : (workflowProperties.agent ?? "");
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

    getEffectivePriorContext: () => {
      const { workflowProperties, globalSettings } = get();
      return (
        (workflowProperties.priorContext as PriorContext) ??
        (globalSettings.priorContext as PriorContext)
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
