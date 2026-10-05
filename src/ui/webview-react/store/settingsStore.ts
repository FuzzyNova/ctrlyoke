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
  type ServerPortFallbackInfo,
  type BindAddressFallbackInfo,
  type LicenseAccessState,
  type LicenseActionResultMessage,
  type LicenseMachineSummary,
} from "../types/messages";
import {
  CLAUDE_CLI_MODELS as CLAUDE_CLI_MODEL_LIST,
  CODEX_CLI_MODELS as CODEX_CLI_MODEL_LIST,
  ANTIGRAVITY_CLI_MODELS as ANTIGRAVITY_CLI_MODEL_LIST,
  DEFAULT_MODELS,
  HARNESS_DISPLAY_ORDER,
  PERMISSION_MODES,
  TERMINAL_CURSOR_STYLES,
  TERMINAL_MOBILE_CONTROL_BAR,
  WORKTREE_MODES,
  COMPARE_SOURCES,
  TOAST_LEVEL_MODES,
  type StepColorMode,
  type ToastLevelMode,
} from "@root/types/DashboardConstants";
import type {
  CommitMessageGenerationRecord,
  DevStatus,
  ExternalFileRootsByScope,
  FullGlobalSettings,
  PreCondition,
  TerminalSettings,
  WorktreeManagementState,
} from "@root/types/WebviewMessageTypes";
import type {
  EndCondition,
  ErrorBehavior,
  UserHookConfig,
  WorktreeConfig,
} from "@root/types/CtrlYokeTypes";
import {
  CTRLYOKE_SETTINGS_DEFAULTS,
  DEFAULT_COLLAPSED_TOOL_OUTPUT_LINE_COUNT,
  type HarnessColorSettings,
  type WorktreeDefaultConfig,
} from "@root/types/CtrlYokeSettings";
import type { WorktreeObjectConfig } from "@root/types/CtrlYokeTypes";
import { DEFAULT_TERMINAL_BAR_LAYOUT } from "@root/utils/TerminalControlBarFormat";

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
  /** User-facing name from agent metadata, or a formatted filename fallback. */
  displayName?: string;
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
  installHint?: string;
}

export interface DevBuildState {
  isBuilding: boolean;
  script: "compile:extension" | "compile:webview" | "compile" | "test" | null;
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
  secrets?: string[];
  executionMode: ExecutionMode;
  /** Raw global workflow step cap; -1 means unlimited. */
  maxSteps: number;
  /** Effective queue fan-out width, available before the settings drawer opens. */
  effectiveParallelGroupWidth: number;
  resumeSession: boolean;
  mcpServers: (string | object)[];
  hooks: UserHookConfig[];
  autoFocusOutputOnExecution: boolean;
  toolPermissions: {
    mode: string;
    allowedTools: string[];
    deniedTools: string[];
  };
  respectGitignore: boolean;
  autoExpandEditorWhenTyping: boolean;
  atomicContextReferences: boolean;
  outputVirtualizationRowThreshold: number;
  collapsedToolOutputLineCount: number;
  stepColorMode?: StepColorMode;
  harnessColors?: HarnessColorSettings;
  confirmDeleteOperations: boolean;
  confirmResetOperations: boolean;
  confirmContinuationDiscardOperations: boolean;
  hideGitIgnoredFiles: boolean;
  isMultiRoot: boolean;
  priorContext: string;
  workspaceRoot: string;
  defaultErrorBehavior: ErrorBehavior | null;
  defaultEndCondition: EndCondition | null;
  defaultPreCondition: PreCondition | null;
  worktree?: WorktreeDefaultConfig;
  externalFileRootsByScope?: ExternalFileRootsByScope;
  terminal?: TerminalSettings;
  /** Minimum severity for operational toast; mirrored from `notifications.toastLevel`. */
  toastLevel: ToastLevelMode;
  /** Per-leaf-path source map: "workspace" if a workspace file owns the setting, "user" if a user file does, absent if at default */
  settingSources: Record<string, string>;
}

/**
 * Workflow properties (from working file, can override global settings)
 */
export interface WorkflowProperties {
  maxSteps?: number;
  harness?: string;
  model?: string;
  executionMode?: ExecutionMode;
  agent?: string | null;
  skills?: string[] | null;
  secrets?: string[] | null;
  vars?: Record<string, string>;
  resumeSession?: boolean;
  sessionId?: string | number; // UUID string or prompt number reference
  mcpServers?: (string | object)[] | null;
  hooks?: UserHookConfig[] | null;
  errorBehavior?: ErrorBehavior | null;
  // Both conditions use the canonical shapes. This one used to be an inline
  // copy and had drifted badly: it still carried the removed `returns` field
  // and knew nothing about the comparison set (`compareSource`, `operator`,
  // `expected`, `ignoreCase`, `shell`), so every one of those was untypeable
  // at the call sites that write them.
  endCondition?: EndCondition | null;
  preCondition?: PreCondition | null;
  priorContext?: PriorContext;
  additionalArgs?: string | null;
  toolPermissions?: {
    mode?: ToolPermissionMode;
    allowedTools?: string[];
    deniedTools?: string[];
  } | null;
  worktree?: WorktreeConfig;
  trustedExternalRoots?: string[] | null;
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
  workflowExternalRootsApprovalRequired: boolean;

  // Full global settings (from configService, loaded on demand)
  fullGlobalSettings: FullGlobalSettings | null;
  globalSettingsReadOnly: boolean;

  // Server running state (toggled by ENABLE_SERVER / DISABLE_SERVER)
  serverRunning: boolean;

  // Pro entitlement and remote-access trial state from the extension host
  licenseAccess: LicenseAccessState;

  // Client-scoped license-management replies consumed by the License tab.
  licenseMachines: LicenseMachineSummary[];
  licenseActionResult: Omit<LicenseActionResultMessage, "type"> | null;

  // Server URL (set when server starts, cleared when stopped)
  serverUrl: string | null;

  // Available LAN IPs when binding to 0.0.0.0 (empty when binding to localhost)
  availableIps: string[];

  // The IP currently selected for display in the URL/QR code (null = use serverUrl as-is)
  selectedDisplayIp: string | null;

  // Set when the last server start couldn't bind the configured server.port
  // (EADDRINUSE) and fell back to an OS-assigned port instead. Cleared on
  // SERVER_STOPPED or once a start succeeds on the configured port.
  portFallback: ServerPortFallbackInfo | null;

  // Set when a non-loopback bind was coerced to localhost at server start.
  bindAddressFallback: BindAddressFallbackInfo | null;

  // Last generated self-signed cert metadata (generatedAt/expiresAt are ISO strings)
  lastCertGenerated: {
    generatedAt: string;
    expiresAt: string;
    sans: string[];
  } | null;

  // Incremented each time a cert is actually generated — drives the flash without triggering on settings load
  certFlashCount: number;

  // Timestamp (ms) of the last server token regeneration — persists until server restarts
  lastTokenRegenerated: number | null;

  // Incremented each time the token is regenerated — drives the flash without triggering on remount
  tokenFlashCount: number;

  // Whether the last completed cert-download round trip (VS Code panel's
  // native Save dialog flow) actually wrote a file — false if the user
  // cancelled the dialog or the write failed.
  lastCertDownloadSaved: boolean;

  // Incremented each time a cert-download round trip finishes (saved or
  // cancelled) — drives the download button's pending-clear.
  certDownloadFlashCount: number;

  // Developer dashboard controls (dev builds only)
  dev: DevStatus | null;
  devBuild: DevBuildState;
  lastCommitMessageGeneration: CommitMessageGenerationRecord | null;
  worktreeManagement: WorktreeManagementState | null;

  // Round-trip results for worktree management actions/sync/refresh requests,
  // keyed by the requestId the webview generated when it sent the request.
  // Consumers clear their own entry once they've displayed it.
  worktreeActionResults: Record<string, { success: boolean; message: string }>;
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
  getEffectiveSecrets: () => string[];

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
  setWorkflowExternalRootsApprovalRequired: (required: boolean) => void;

  // Full global settings
  setFullGlobalSettings: (settings: FullGlobalSettings) => void;
  setGlobalSettingsReadOnly: (readOnly: boolean) => void;

  // Server running state
  setServerRunning: (running: boolean) => void;

  // Pro entitlement and remote-access trial state
  setLicenseAccess: (access: LicenseAccessState) => void;
  setLicenseMachines: (machines: LicenseMachineSummary[]) => void;
  setLicenseActionResult: (
    result: Omit<LicenseActionResultMessage, "type">
  ) => void;
  clearLicenseActionResult: () => void;

  // Server URL
  setServerUrl: (url: string | null) => void;

  // Available IPs + selected display IP
  setAvailableIps: (ips: string[]) => void;
  setSelectedDisplayIp: (ip: string | null) => void;

  // Port-fallback warning (null clears it)
  setPortFallback: (info: ServerPortFallbackInfo | null) => void;
  setBindAddressFallback: (info: BindAddressFallbackInfo | null) => void;

  // Cert / token feedback signals
  setLastCertGenerated: (
    info: { generatedAt: string; expiresAt: string; sans: string[] } | null
  ) => void;
  bumpCertFlashCount: () => void;
  setLastTokenRegenerated: (timestamp: number | null) => void;
  bumpTokenFlashCount: () => void;
  setLastCertDownloadSaved: (saved: boolean) => void;
  bumpCertDownloadFlashCount: () => void;

  // Developer dashboard
  setDevStatus: (dev: DevStatus | null) => void;
  startDevBuild: (
    script: "compile:extension" | "compile:webview" | "compile" | "test",
    command: string
  ) => void;
  appendDevBuildOutput: (stream: "stdout" | "stderr", chunk: string) => void;
  completeDevBuild: (result: DevBuildState["lastResult"]) => void;
  clearDevBuildOutput: () => void;

  // Commit message generation
  setLastCommitMessageGeneration: (
    record: CommitMessageGenerationRecord | null
  ) => void;
  setWorktreeManagement: (state: WorktreeManagementState | null) => void;
  setWorktreeActionResult: (
    requestId: string,
    result: { success: boolean; message: string }
  ) => void;
  clearWorktreeActionResult: (requestId: string) => void;

  // Effective value resolution (workflow > global)
  getEffectiveHarness: () => HarnessId;
  getEffectiveModel: () => string;
  getEffectiveExecutionMode: () => ExecutionMode;
  getEffectiveWorktree: () => WorktreeObjectConfig | false;
  getEffectiveAgent: () => string;
  getEffectiveResumeSession: () => boolean;
  getEffectiveMcpServers: () => (string | object)[] | null;
  getEffectiveHooks: () => UserHookConfig[] | null;
  getEffectivePriorContext: () => PriorContext;
  getEffectiveAdditionalArgs: () => string;
  getEffectiveToolPermissions: () => WorkflowProperties["toolPermissions"];

  // Reset
  resetSettings: () => void;
}

// Model lists imported from DashboardConstants (single source of truth)
const CLAUDE_CLI_MODELS: ModelOption[] = [...CLAUDE_CLI_MODEL_LIST];
const CODEX_CLI_MODELS: ModelOption[] = [...CODEX_CLI_MODEL_LIST];
const ANTIGRAVITY_CLI_MODELS: ModelOption[] = [...ANTIGRAVITY_CLI_MODEL_LIST];

// Placeholder until the host sends the effective (possibly auto-detected)
// default harness.
const initialGlobalSettings: GlobalSettings = {
  harness: HARNESS_DISPLAY_ORDER[0],
  model: DEFAULT_MODELS[HARNESS_DISPLAY_ORDER[0]],
  harnessDefaultModels: {},
  harnessDefaultAdditionalArgs: {},
  agent: "",
  skills: [],
  secrets: [],
  executionMode: EXECUTION_MODES.INTERACTIVE,
  maxSteps: CTRLYOKE_SETTINGS_DEFAULTS.queue.maxSteps,
  effectiveParallelGroupWidth:
    CTRLYOKE_SETTINGS_DEFAULTS.queue.maxParallelSteps,
  resumeSession: false,
  mcpServers: [],
  hooks: [],
  autoFocusOutputOnExecution: true,
  toolPermissions: {
    mode: PERMISSION_MODES.ALLOW_ALL,
    allowedTools: [],
    deniedTools: [],
  },
  respectGitignore: true,
  autoExpandEditorWhenTyping: true,
  atomicContextReferences: false,
  outputVirtualizationRowThreshold: 200,
  collapsedToolOutputLineCount: DEFAULT_COLLAPSED_TOOL_OUTPUT_LINE_COUNT,
  stepColorMode: CTRLYOKE_SETTINGS_DEFAULTS.ui.stepColorMode,
  harnessColors: CTRLYOKE_SETTINGS_DEFAULTS.ui.harnessColors,
  confirmDeleteOperations: true,
  confirmResetOperations: true,
  confirmContinuationDiscardOperations: true,
  hideGitIgnoredFiles: false,
  isMultiRoot: false,
  priorContext: "none",
  workspaceRoot: "",
  defaultErrorBehavior: null,
  defaultEndCondition: null,
  defaultPreCondition: null,
  worktree: false,
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
    mobileBarLayout: {
      bar: [...DEFAULT_TERMINAL_BAR_LAYOUT.bar],
      popup: [...DEFAULT_TERMINAL_BAR_LAYOUT.popup],
      hidden: [...DEFAULT_TERMINAL_BAR_LAYOUT.hidden],
    },
    mobileCustomShortcuts: [],
  },
  toastLevel: TOAST_LEVEL_MODES.ALL,
  settingSources: {},
};

const initialHarnessStatus: Record<HarnessId, HarnessStatus> = {
  [HARNESS_IDS.COPILOT_CLI]: {
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
  [HARNESS_IDS.ANTIGRAVITY_CLI]: {
    available: false,
    status: HARNESS_STATUS_STRINGS.CHECKING,
  },
};

const initialState: SettingsState = {
  modelOptions: {
    [HARNESS_IDS.COPILOT_CLI]: [],
    [HARNESS_IDS.CLAUDE_CLI]: CLAUDE_CLI_MODELS,
    [HARNESS_IDS.CODEX_CLI]: CODEX_CLI_MODELS,
    [HARNESS_IDS.OPENCODE_CLI]: [],
    [HARNESS_IDS.QWEN_CLI]: [],
    [HARNESS_IDS.ANTIGRAVITY_CLI]: ANTIGRAVITY_CLI_MODELS,
  },
  availableAgents: [],
  availableSkills: [],
  harnessStatus: initialHarnessStatus,
  globalSettings: initialGlobalSettings,
  workflowProperties: {},
  workflowLoaded: false,
  workflowExternalRootsApprovalRequired: false,
  fullGlobalSettings: null,
  globalSettingsReadOnly: false,
  serverRunning: false,
  licenseAccess: { isPro: false, hasRemoteAccess: false, trialEndsAt: null },
  licenseMachines: [],
  licenseActionResult: null,
  serverUrl: null,
  availableIps: [],
  selectedDisplayIp: null,
  portFallback: null,
  bindAddressFallback: null,
  lastCertGenerated: null,
  certFlashCount: 0,
  lastTokenRegenerated: null,
  tokenFlashCount: 0,
  lastCertDownloadSaved: false,
  certDownloadFlashCount: 0,
  dev: null,
  devBuild: {
    isBuilding: false,
    script: null,
    command: null,
    output: "",
    lastResult: null,
  },
  lastCommitMessageGeneration: null,
  worktreeManagement: null,
  worktreeActionResults: {},
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

    getEffectiveSecrets: () => {
      const { workflowProperties, globalSettings } = get();
      return workflowProperties.secrets === undefined
        ? (globalSettings.secrets ?? [])
        : (workflowProperties.secrets ?? []);
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

    setWorkflowExternalRootsApprovalRequired: (required) =>
      set({ workflowExternalRootsApprovalRequired: required }),

    setFullGlobalSettings: (settings) => set({ fullGlobalSettings: settings }),
    setGlobalSettingsReadOnly: (globalSettingsReadOnly) =>
      set({ globalSettingsReadOnly }),

    setServerRunning: (running) => set({ serverRunning: running }),

    setLicenseAccess: (access) =>
      set((state) => ({
        licenseAccess: access,
        fullGlobalSettings: state.fullGlobalSettings
          ? { ...state.fullGlobalSettings, licenseAccess: access }
          : state.fullGlobalSettings,
      })),

    setLicenseMachines: (machines) => set({ licenseMachines: machines }),
    setLicenseActionResult: (result) => set({ licenseActionResult: result }),
    clearLicenseActionResult: () => set({ licenseActionResult: null }),

    setServerUrl: (url) => set({ serverUrl: url }),

    setAvailableIps: (ips) => set({ availableIps: ips }),

    setSelectedDisplayIp: (ip) => set({ selectedDisplayIp: ip }),

    setPortFallback: (info) => set({ portFallback: info }),
    setBindAddressFallback: (info) => set({ bindAddressFallback: info }),

    setLastCertGenerated: (info) => set({ lastCertGenerated: info }),
    bumpCertFlashCount: () =>
      set((s) => ({ certFlashCount: s.certFlashCount + 1 })),
    setLastTokenRegenerated: (timestamp) =>
      set({ lastTokenRegenerated: timestamp }),
    bumpTokenFlashCount: () =>
      set((s) => ({ tokenFlashCount: s.tokenFlashCount + 1 })),
    setLastCertDownloadSaved: (saved) => set({ lastCertDownloadSaved: saved }),
    bumpCertDownloadFlashCount: () =>
      set((s) => ({ certDownloadFlashCount: s.certDownloadFlashCount + 1 })),

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
          output: `${state.devBuild.output}${stream === COMPARE_SOURCES.STDERR ? "[stderr] " : ""}${chunk}`,
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

    setLastCommitMessageGeneration: (record) =>
      set({ lastCommitMessageGeneration: record }),
    setWorktreeManagement: (state) => set({ worktreeManagement: state }),
    setWorktreeActionResult: (requestId, result) =>
      set((state) => ({
        worktreeActionResults: {
          ...state.worktreeActionResults,
          [requestId]: result,
        },
      })),
    clearWorktreeActionResult: (requestId) =>
      set((state) => {
        if (!(requestId in state.worktreeActionResults)) return state;
        const next = { ...state.worktreeActionResults };
        delete next[requestId];
        return { worktreeActionResults: next };
      }),

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

    getEffectiveExecutionMode: () => {
      const { workflowProperties, globalSettings } = get();
      return workflowProperties.executionMode ?? globalSettings.executionMode;
    },

    getEffectiveWorktree: () => {
      const { workflowProperties, globalSettings } = get();
      const authored = workflowProperties.worktree;
      if (authored === false) {
        return false;
      }
      if (authored === true) {
        return { mode: WORKTREE_MODES.MANAGED };
      }
      if (authored === undefined) {
        const defaultWorktree = globalSettings.worktree ?? false;
        if (defaultWorktree === false) return false;
        if (defaultWorktree === true) {
          return { mode: WORKTREE_MODES.MANAGED };
        }
        if (typeof defaultWorktree === "string") {
          return { mode: WORKTREE_MODES.NAMED, branch: defaultWorktree };
        }
        return { ...defaultWorktree };
      }
      if (typeof authored === "string") {
        return { mode: WORKTREE_MODES.NAMED, branch: authored };
      }
      return { ...authored };
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

/**
 * Resolve the operational-toast severity threshold.
 *
 * `fullGlobalSettings` is only populated once the global settings drawer has
 * been opened (and is refreshed on every save from it), so it is preferred
 * when present but cannot be relied on alone — after a reload it is `null`.
 * `globalSettings.toastLevel` is mirrored into the `INIT` payload and every
 * `GLOBAL_SETTINGS_UPDATED` push, so it is available from panel load onward.
 * Falls back to `ALL` (fail open) so toasts are never silently swallowed
 * before any settings have arrived.
 */
export function selectToastLevel(): ToastLevelMode {
  const state = useSettingsStore.getState();
  return (
    state.fullGlobalSettings?.settings.notifications.toastLevel ??
    state.globalSettings.toastLevel ??
    TOAST_LEVEL_MODES.ALL
  );
}
