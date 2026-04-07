import type { HarnessId } from "./DashboardConstants";
import type { McpServerConfig, UserHookConfig } from "./FlightPathTypes";

export interface FlightPathGlobalSettings {
  // Core
  harness: HarnessId;

  // Models (per-harness)
  models: Partial<Record<HarnessId, string>>;

  // Additional args (per-harness) — replaces 6 separate VS Code settings
  additionalArgs: Partial<Record<HarnessId, string>>;

  // Execution
  execution: {
    mode: "interactive" | "headless";
    maxPromptTimeout: number; // seconds, -1 = unlimited
    scriptTimeout: number; // seconds
    closeTerminalOnComplete: boolean;
  };

  // Tools
  tools: {
    permissionMode: "dangerouslyAllowAll" | "allowAll" | "custom";
    allowed: string[];
    denied: string[];
    // Copilot CLI-specific
    copilotAllowedDirs: string[];
    copilotAllowAllPaths: boolean;
    // Codex CLI-specific
    codexSandboxMode: "read-only" | "workspace-write" | "danger-full-access";
    codexApprovalPolicy: "untrusted" | "on-request" | "never";
    codexAllowedDirs: string[];
  };

  // Workflow defaults
  workflow: {
    defaultFormat: "yaml" | "json";
    defaultTemplate: string;
    defaultAgent: string;
    defaultSkills: string[];
    resumeExistingSession: boolean;
    priorContext: string;
    autoLoadRecentSession: boolean;
    maxRetries: number;
    retryPrompt: string;
    omitAgentsSkillsOnResume: boolean;
  };

  // Chat
  chat: {
    windowLocation: "chatPanel" | "newTab" | "newWindow";
    inactivityTimeout: number; // seconds
    treatTimeoutAsSuccess: boolean;
    forceAgentMode: boolean;
    useNativeAttachments: boolean;
  };

  // MCP & Hooks
  mcp: {
    defaultServers: (string | McpServerConfig)[];
  };
  hooks: UserHookConfig[];

  // Queue
  queue: {
    maxSize: number;
    maxWorkflowExecutionTime: number; // seconds; -1 = unlimited
    unlimitedMode: boolean;
    notifyOnExtension: boolean;
  };

  // History
  history: {
    saveOutput: boolean;
    maxRuns: number;
  };

  // UI
  ui: {
    showCliOutput: boolean;
    showCliCommand: boolean;
    logRawCliOutput: boolean;
    openPromptsInSecondGroup: boolean;
    respectGitignoreForCompletions: boolean;
    confirmDeleteOperations: boolean;
    confirmResetOperations: boolean;
  };

  // Server (new)
  server: {
    enabled: boolean;
    port: number;
    standalonePort: number;
    theme: "auto" | "light" | "dark";
    tls?: {
      enabled: boolean;
      certPath?: string;
      keyPath?: string;
    };
  };

  // Advanced
  enableDiagnosticLogs: boolean;
}

/** Partial version of FlightPathGlobalSettings for config file contents */
export type PartialFlightPathSettings = {
  [K in keyof FlightPathGlobalSettings]?: FlightPathGlobalSettings[K] extends object
    ? Partial<FlightPathGlobalSettings[K]>
    : FlightPathGlobalSettings[K];
};

/** Default values for all settings */
export const FLIGHTPATH_SETTINGS_DEFAULTS: FlightPathGlobalSettings = {
  harness: "copilot-cli",
  models: {},
  additionalArgs: {},
  execution: {
    mode: "interactive",
    maxPromptTimeout: 10800,
    scriptTimeout: 30,
    closeTerminalOnComplete: false,
  },
  tools: {
    permissionMode: "allowAll",
    allowed: [],
    denied: [],
    copilotAllowedDirs: [],
    copilotAllowAllPaths: true,
    codexSandboxMode: "workspace-write",
    codexApprovalPolicy: "on-request",
    codexAllowedDirs: [],
  },
  workflow: {
    defaultFormat: "yaml",
    defaultTemplate: "blank",
    defaultAgent: "",
    defaultSkills: [],
    resumeExistingSession: false,
    priorContext: "none",
    autoLoadRecentSession: true,
    maxRetries: 3,
    retryPrompt: "",
    omitAgentsSkillsOnResume: true,
  },
  chat: {
    windowLocation: "chatPanel",
    inactivityTimeout: 300,
    treatTimeoutAsSuccess: true,
    forceAgentMode: false,
    useNativeAttachments: false,
  },
  mcp: {
    defaultServers: [],
  },
  hooks: [],
  queue: {
    maxSize: 10,
    maxWorkflowExecutionTime: -1,
    unlimitedMode: false,
    notifyOnExtension: true,
  },
  history: {
    saveOutput: true,
    maxRuns: -1,
  },
  ui: {
    showCliOutput: true,
    showCliCommand: true,
    logRawCliOutput: false,
    openPromptsInSecondGroup: false,
    respectGitignoreForCompletions: true,
    confirmDeleteOperations: true,
    confirmResetOperations: true,
  },
  server: {
    enabled: false,
    port: 3000,
    standalonePort: 3001,
    theme: "auto",
  },
  enableDiagnosticLogs: false,
};
