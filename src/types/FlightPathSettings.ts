import type { HarnessId } from "./DashboardConstants";
import type {
  EndCondition,
  McpServerConfig,
  PreCondition,
  UserHookConfig,
} from "./FlightPathTypes";

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
    // Shared across copilot-cli, claude-cli, codex-cli, qwen-cli (not supported by gemini-cli, opencode-cli, copilot-chat)
    allowedDirs: string[];
    // Copilot CLI-specific
    copilotAllowAllPaths: boolean;
    // Codex CLI-specific
    codexSandboxMode: "read-only" | "workspace-write" | "danger-full-access";
    codexApprovalPolicy: "untrusted" | "on-request" | "never";
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
    omitAgentsSkillsOnResume: boolean;
    /** Default end condition applied to all new workflows. null/undefined = disabled. */
    defaultEndCondition?: EndCondition | null;
    /** Default pre-condition applied to all new workflows. null/undefined = disabled. */
    defaultPreCondition?: PreCondition | null;
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
    allowed: [
      "write",
      "shell(git status)",
      "shell(git diff)",
      "shell(git add:*)",
      "shell(git commit:*)",
      "shell(git log:*)",
      "shell(npm:*)",
      "shell(yarn:*)",
      "shell(pnpm:*)",
      "shell(node:*)",
      "shell(npx:*)",
    ],
    denied: [
      "shell(rm:*)",
      "shell(del:*)",
      "shell(Remove-Item:*)",
      "shell(rd:*)",
      "shell(rmdir:*)",
      "shell(sudo:*)",
      "shell(chmod:*)",
      "shell(chown:*)",
      "shell(git push:*)",
      "shell(git reset:*)",
      "shell(git checkout:*)",
      "shell(git clean:*)",
      "shell(docker rm:*)",
      "shell(docker rmi:*)",
      "shell(kubectl delete:*)",
    ],
    allowedDirs: [],
    copilotAllowAllPaths: true,
    codexSandboxMode: "workspace-write",
    codexApprovalPolicy: "on-request",
  },
  workflow: {
    defaultFormat: "yaml",
    defaultTemplate: "blank",
    defaultAgent: "",
    defaultSkills: [],
    resumeExistingSession: false,
    priorContext: "none",
    autoLoadRecentSession: true,
    omitAgentsSkillsOnResume: true,
    defaultEndCondition: null,
    defaultPreCondition: null,
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
    port: 4747,
    standalonePort: 4748,
    theme: "auto",
  },
  enableDiagnosticLogs: false,
};
