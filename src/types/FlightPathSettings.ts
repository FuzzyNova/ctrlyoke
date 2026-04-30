import {
  BROWSER_NOTIFICATION_MODES,
  NOTIFICATION_EVENT_MODES,
  TERMINAL_CURSOR_STYLES,
  TERMINAL_MOBILE_CONTROL_BAR,
  type HarnessId,
  type TerminalCursorStyle,
  type TerminalMobileControlBar,
  type NotificationEventMode,
  type BrowserNotificationMode,
} from "./DashboardConstants";
import type {
  EndCondition,
  McpServerConfig,
  PreCondition,
  UserHookConfig,
} from "./FlightPathTypes";

type CliAdditionalArgsHarnessId = Exclude<HarnessId, "copilot-chat">;

export interface FlightPathGlobalSettings {
  // Core
  harness: HarnessId;

  // Models (per-harness)
  models: Partial<Record<HarnessId, string>>;

  // Additional args (per-harness) — replaces 6 separate VS Code settings
  additionalArgs: Partial<Record<CliAdditionalArgsHarnessId, string>>;

  // Execution
  execution: {
    mode: "interactive" | "headless";
    /** When true, keep the TUI alive and write follow-up prompts directly into the PTY. */
    injectMode: boolean;
    maxPromptTimeout: number; // seconds, -1 = unlimited
    scriptTimeout: number; // seconds
    closeTerminalOnComplete: boolean;
    autoDeleteTempFiles: boolean;
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

  // Terminal
  terminal: TerminalSettings;

  // UI
  ui: {
    showCliOutput: boolean;
    showCliCommand: boolean;
    logRawCliOutput: boolean;
    showHeadlessPermissionWarning: boolean;
    autoFocusOutputOnExecution: boolean;
    openPromptsInSecondGroup: boolean;
    respectGitignoreForCompletions: boolean;
    confirmDeleteOperations: boolean;
    confirmResetOperations: boolean;
    showHiddenFiles: boolean;
  };

  // Server (new)
  server: {
    enabled: boolean;
    port: number;
    standalonePort: number;
    theme: "auto" | "light" | "dark";
    bindAddress: string; // "127.0.0.1" = localhost only; "0.0.0.0" = all interfaces
    tls: {
      enabled: boolean;
      certPath: string;
      keyPath: string;
    };
  };

  // Notifications
  notifications: FlightPathNotificationSettings;

  // Advanced
  enableDiagnosticLogs: boolean;
}

export interface FlightPathNotificationSettings {
  vscode: {
    enabled: boolean;
  };
  browser: {
    mode: BrowserNotificationMode;
  };
  events: {
    workflowComplete: NotificationEventMode;
    promptComplete: NotificationEventMode;
  };
  includeWorkflowName: boolean;
  includePromptName: boolean;
  onlyWhenWindowUnfocused: boolean;
}

export interface TerminalSettings {
  fontSize: number;
  lineHeight: number;
  scrollback: number;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  macOptionIsMeta: boolean;
  wordSeparators: string;
  replayBufferKb: number;
  shellExecutable: string;
  mobileControlBar: TerminalMobileControlBar;
  mobileCustomShortcuts: TerminalShortcut[];
}

export interface TerminalShortcut {
  label: string;
  sequence: string;
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
    injectMode: false,
    maxPromptTimeout: 10800,
    scriptTimeout: 30,
    closeTerminalOnComplete: false,
    autoDeleteTempFiles: true,
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
  ui: {
    showCliOutput: true,
    showCliCommand: true,
    logRawCliOutput: false,
    showHeadlessPermissionWarning: true,
    autoFocusOutputOnExecution: true,
    openPromptsInSecondGroup: false,
    respectGitignoreForCompletions: true,
    confirmDeleteOperations: true,
    confirmResetOperations: true,
    showHiddenFiles: true,
  },
  server: {
    enabled: false,
    port: 4747,
    standalonePort: 4748,
    theme: "auto",
    bindAddress: "127.0.0.1",
    tls: {
      enabled: false,
      certPath: "",
      keyPath: "",
    },
  },
  notifications: {
    vscode: {
      enabled: true,
    },
    browser: {
      mode: BROWSER_NOTIFICATION_MODES.NEVER,
    },
    events: {
      workflowComplete: NOTIFICATION_EVENT_MODES.ALL,
      promptComplete: NOTIFICATION_EVENT_MODES.NEVER,
    },
    includeWorkflowName: true,
    includePromptName: true,
    onlyWhenWindowUnfocused: true,
  },
  enableDiagnosticLogs: false,
};
