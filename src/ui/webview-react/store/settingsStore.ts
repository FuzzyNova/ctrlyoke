import { create } from "zustand";
import {
  HARNESS_IDS,
  HARNESS_STATUS_STRINGS,
  EXECUTION_MODES,
  type HarnessId,
  type HarnessStatusString,
  type PriorContext,
  type ExecutionMode,
  type ToolPermissionMode,
} from "../types/messages";
import {
  CLAUDE_CLI_MODELS as CLAUDE_CLI_MODEL_LIST,
  CODEX_CLI_MODELS as CODEX_CLI_MODEL_LIST,
  GEMINI_CLI_MODELS as GEMINI_CLI_MODEL_LIST,
  PERMISSION_MODES,
  TERMINAL_CURSOR_STYLES,
  TERMINAL_MOBILE_CONTROL_BAR,
} from "@root/types/DashboardConstants";
import type {
  DevStatus,
  FullGlobalSettings,
  PreCondition,
  TerminalSettings,
} from "@root/types/WebviewMessageTypes";
import type { EndCondition } from "@root/types/FlightPathTypes";

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

export interface DevBuildState {
  isBuilding: boolean;
  script: "compile:extension" | "compile" | null;
  command: string | null;
  output: string;
  lastResult: {
    success: boolean;
    exitCode: number | null;
    signal?: string | null;
    durationMs: number;
    errorSummary?: string;
  } | null;
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
  executionMode: ExecutionMode;
  resumeSession: boolean;
  mcpServers: (string | object)[];
  hooks: object[];
  toolPermissions: {
    mode: string;
    allowedTools: string[];
    deniedTools: string[];
  };
  respectGitignore: boolean;
  confirmDeleteOperations: boolean;
  confirmResetOperations: boolean;
  priorContext: string;
  workspaceRoot: string;
  defaultEndCondition: EndCondition | null;
  defaultPreCondition: PreCondition | null;
  terminal?: TerminalSettings;
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
  mcpServers?: (string | object)[] | null;
  hooks?: object[] | null;
  endCondition?: {
    script?: string; // Made optional - fields can be set incrementally
    returns?: string;
    timeout?: number;
    maxRetries?: number;
    retryPrompt?: string;
    onPass?: string;
    onFail?: string;
  } | null;
  preCondition?: PreCondition | null;
  priorContext?: PriorContext;
  additionalArgs?: string | null;
  toolPermissions?: {
    mode?: ToolPermissionMode;
    allowedTools?: string[];
    deniedTools?: string[];
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

  // Full global settings (from configService, loaded on demand)
  fullGlobalSettings: FullGlobalSettings | null;

  // Server running state (toggled by ENABLE_SERVER / DISABLE_SERVER)
  serverRunning: boolean;

  // Server URL (set when server starts, cleared when stopped)
  serverUrl: string | null;

  // Available LAN IPs when binding to 0.0.0.0 (empty when binding to localhost)
  availableIps: string[];

  // The IP currently selected for display in the URL/QR code (null = use serverUrl as-is)
  selectedDisplayIp: string | null;

  // Developer dashboard controls (dev builds only)
  dev: DevStatus | null;
  devBuild: DevBuildState;
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

  // Full global settings
  setFullGlobalSettings: (settings: FullGlobalSettings) => void;

  // Server running state
  setServerRunning: (running: boolean) => void;

  // Server URL
  setServerUrl: (url: string | null) => void;

  // Available IPs + selected display IP
  setAvailableIps: (ips: string[]) => void;
  setSelectedDisplayIp: (ip: string | null) => void;

  // Developer dashboard
  setDevStatus: (dev: DevStatus | null) => void;
  startDevBuild: (
    script: "compile:extension" | "compile",
    command: string
  ) => void;
  appendDevBuildOutput: (stream: "stdout" | "stderr", chunk: string) => void;
  completeDevBuild: (result: DevBuildState["lastResult"]) => void;
  clearDevBuildOutput: () => void;

  // Effective value resolution (workflow > global)
  getEffectiveHarness: () => HarnessId;
  getEffectiveModel: () => string;
  getEffectiveAgent: () => string;
  getEffectiveResumeSession: () => boolean;
  getEffectiveMcpServers: () => (string | object)[] | null;
  getEffectiveHooks: () => object[] | null;
  getEffectivePriorContext: () => PriorContext;
  getEffectiveAdditionalArgs: () => string;
  getEffectiveToolPermissions: () => WorkflowProperties["toolPermissions"];

  // Reset
  resetSettings: () => void;
}

// Model lists imported from DashboardConstants (single source of truth)
const CLAUDE_CLI_MODELS: ModelOption[] = [...CLAUDE_CLI_MODEL_LIST];
const CODEX_CLI_MODELS: ModelOption[] = [...CODEX_CLI_MODEL_LIST];
const GEMINI_CLI_MODELS: ModelOption[] = [...GEMINI_CLI_MODEL_LIST];

const initialGlobalSettings: GlobalSettings = {
  harness: HARNESS_IDS.COPILOT_CLI as HarnessId,
  model: "claude-sonnet-4.5",
  harnessDefaultModels: {},
  harnessDefaultAdditionalArgs: {},
  agent: "",
  skills: [],
  executionMode: EXECUTION_MODES.INTERACTIVE,
  resumeSession: false,
  mcpServers: [],
  hooks: [],
  toolPermissions: {
    mode: PERMISSION_MODES.ALLOW_ALL,
    allowedTools: [],
    deniedTools: [],
  },
  respectGitignore: true,
  confirmDeleteOperations: true,
  confirmResetOperations: true,
  priorContext: "none",
  workspaceRoot: "",
  defaultEndCondition: null,
  defaultPreCondition: null,
  terminal: {
    fontSize: 14,
    lineHeight: 1.2,
    scrollback: 5000,
    cursorStyle: TERMINAL_CURSOR_STYLES.BLOCK,
    cursorBlink: true,
    macOptionIsMeta: false,
    wordSeparators: " ()[]{}',\"`",
    replayBufferKb: 50,
    shellExecutable: "",
    mobileControlBar: TERMINAL_MOBILE_CONTROL_BAR.AUTO,
    mobileCustomShortcuts: [],
  },
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
    [HARNESS_IDS.QWEN_CLI]: [],
    [HARNESS_IDS.GEMINI_CLI]: GEMINI_CLI_MODELS,
  },
  availableAgents: [],
  availableSkills: [],
  harnessStatus: initialHarnessStatus,
  globalSettings: initialGlobalSettings,
  workflowProperties: {},
  workflowLoaded: false,
  fullGlobalSettings: null,
  serverRunning: false,
  serverUrl: null,
  availableIps: [],
  selectedDisplayIp: null,
  dev: null,
  devBuild: {
    isBuilding: false,
    script: null,
    command: null,
    output: "",
    lastResult: null,
  },
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

    setFullGlobalSettings: (settings) => set({ fullGlobalSettings: settings }),

    setServerRunning: (running) => set({ serverRunning: running }),

    setServerUrl: (url) => set({ serverUrl: url }),

    setAvailableIps: (ips) => set({ availableIps: ips }),

    setSelectedDisplayIp: (ip) => set({ selectedDisplayIp: ip }),

    setDevStatus: (dev) => set({ dev }),

    startDevBuild: (script, command) =>
      set({
        devBuild: {
          isBuilding: true,
          script,
          command,
          output: "",
          lastResult: null,
        },
      }),

    appendDevBuildOutput: (stream, chunk) =>
      set((state) => ({
        devBuild: {
          ...state.devBuild,
          output: `${state.devBuild.output}${stream === "stderr" ? "[stderr] " : ""}${chunk}`,
        },
      })),

    completeDevBuild: (result) =>
      set((state) => ({
        devBuild: {
          ...state.devBuild,
          isBuilding: false,
          lastResult: result,
        },
      })),

    clearDevBuildOutput: () =>
      set((state) => ({
        devBuild: {
          ...state.devBuild,
          output: "",
          lastResult: null,
        },
      })),

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

    getEffectiveMcpServers: () => {
      const { workflowProperties, globalSettings } = get();
      return workflowProperties.mcpServers !== undefined
        ? workflowProperties.mcpServers
        : globalSettings.mcpServers;
    },

    getEffectiveHooks: () => {
      const { workflowProperties, globalSettings } = get();
      return workflowProperties.hooks !== undefined
        ? workflowProperties.hooks
        : globalSettings.hooks;
    },

    getEffectivePriorContext: () => {
      const { workflowProperties, globalSettings } = get();
      return (
        (workflowProperties.priorContext as PriorContext) ??
        (globalSettings.priorContext as PriorContext)
      );
    },

    getEffectiveAdditionalArgs: () => {
      const { workflowProperties, globalSettings } = get();
      if (workflowProperties.additionalArgs !== undefined) {
        return workflowProperties.additionalArgs ?? "";
      }
      const effectiveHarness =
        (workflowProperties.harness as HarnessId) ?? globalSettings.harness;
      return (
        globalSettings.harnessDefaultAdditionalArgs[effectiveHarness] ?? ""
      );
    },

    getEffectiveToolPermissions: () => {
      const { workflowProperties } = get();
      return workflowProperties.toolPermissions;
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
