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
  type HookEvent,
} from "./DashboardConstants";
import {
  ICON_BG_COLOR_DEFAULT,
  ICON_FG_COLOR_DEFAULT,
} from "./IconColorDefaults";
import type {
  EndCondition,
  McpServerConfig,
  PreCondition,
  UserHookConfig,
} from "./FlightPathTypes";

type CliAdditionalArgsHarnessId = Exclude<HarnessId, "copilot-chat">;

export interface FlightPathGlobalSettings {
  // General (format/template/behavior toggles)
  general: {
    defaultFormat: "yaml" | "json";
    defaultTemplate: string;
    autoLoadRecentSession: boolean;
    omitAgentsSkillsOnResume: boolean;
  };

  // Defaults (mirrors executionProperties 1:1)
  defaults: {
    harness: HarnessId;
    models: Partial<Record<HarnessId, string>>;
    additionalArgs: Partial<Record<CliAdditionalArgsHarnessId, string>>;
    agent: string;
    skills: string[];
    resumeSession: boolean;
    priorContext: string;
    mcpServers: (string | McpServerConfig)[];
    hooks: UserHookConfig[];
    toolPermissions: {
      mode: "dangerouslyAllowAll" | "allowAll" | "custom";
      allowedTools: string[];
      deniedTools: string[];
    };
    /** Default end condition applied to all new workflows. null/undefined = disabled. */
    endCondition?: EndCondition | null;
    /** Default pre-condition applied to all new workflows. null/undefined = disabled. */
    preCondition?: PreCondition | null;
  };

  // Permissions (harness-specific advanced settings)
  permissions: {
    // Shared across copilot-cli, claude-cli, codex-cli, qwen-cli (not supported by gemini-cli, opencode-cli, copilot-chat)
    allowedDirs: string[];
    // Copilot CLI-specific
    copilotAllowAllPaths: boolean;
    // Codex CLI-specific
    codexSandboxMode: "read-only" | "workspace-write" | "danger-full-access";
    codexApprovalPolicy: "untrusted" | "on-request" | "never";
  };

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

  // Chat
  chat: {
    windowLocation: "chatPanel" | "newTab" | "newWindow";
    inactivityTimeout: number; // seconds
    treatTimeoutAsSuccess: boolean;
    forceAgentMode: boolean;
    useNativeAttachments: boolean;
  };

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
    /** Background color for the SVG favicon and PWA icon (hex, e.g. '#1076ba'). */
    iconBgColor: string;
    /** Foreground (path/stroke) color for the SVG favicon and PWA icon (hex, e.g. '#ffffff'). */
    iconFgColor: string;
  };

  // Notifications
  notifications: FlightPathNotificationSettings;

  // Commit message generation
  commit: {
    harness: HarnessId | "";
    model: string;
    prompt: string;
  };

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
    hookEvents: { [key in HookEvent]: boolean };
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

/** Partial version of FlightPathGlobalSettings for config file contents (3-level deep partial) */
export type PartialFlightPathSettings = {
  [K in keyof FlightPathGlobalSettings]?: FlightPathGlobalSettings[K] extends object
    ? {
        [J in keyof FlightPathGlobalSettings[K]]?: FlightPathGlobalSettings[K][J] extends object
          ? Partial<FlightPathGlobalSettings[K][J]>
          : FlightPathGlobalSettings[K][J];
      }
    : FlightPathGlobalSettings[K];
};

/** Default values for all settings */
export const FLIGHTPATH_SETTINGS_DEFAULTS: FlightPathGlobalSettings = {
  general: {
    defaultFormat: "yaml",
    defaultTemplate: "blank",
    autoLoadRecentSession: true,
    omitAgentsSkillsOnResume: true,
  },
  defaults: {
    harness: "copilot-cli",
    models: {
      "copilot-cli": "claude-sonnet-4.6",
      "copilot-chat": "claude-sonnet-4.6",
      "claude-cli": "sonnet",
      "codex-cli": "gpt-5.5",
      "opencode-cli": "opencode/big-pickle",
      "qwen-cli": "qwen3.5-plus",
      "gemini-cli": "gemini-3-flash-preview",
    },
    additionalArgs: {},
    agent: "",
    skills: [],
    resumeSession: false,
    priorContext: "none",
    mcpServers: [],
    hooks: [],
    toolPermissions: {
      mode: "allowAll",
      allowedTools: [
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
      deniedTools: [
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
    },
    endCondition: null,
    preCondition: null,
  },
  permissions: {
    allowedDirs: [],
    copilotAllowAllPaths: true,
    codexSandboxMode: "workspace-write",
    codexApprovalPolicy: "on-request",
  },
  execution: {
    mode: "interactive",
    injectMode: false,
    maxPromptTimeout: -1,
    scriptTimeout: 30,
    closeTerminalOnComplete: false,
    autoDeleteTempFiles: true,
  },
  chat: {
    windowLocation: "chatPanel",
    inactivityTimeout: 300,
    treatTimeoutAsSuccess: true,
    forceAgentMode: false,
    useNativeAttachments: false,
  },
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
    iconBgColor: ICON_BG_COLOR_DEFAULT,
    iconFgColor: ICON_FG_COLOR_DEFAULT,
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
      hookEvents: {
        stop: false,
        sessionStart: false,
        preToolUse: false,
        postToolUse: false,
        userPromptSubmit: false,
        permissionRequest: false,
      },
    },
    includeWorkflowName: true,
    includePromptName: true,
    onlyWhenWindowUnfocused: true,
  },
  commit: {
    harness: "",
    model: "",
    prompt:
      "Generate a conventional commit message based on the included git diff. " +
      "Return ONLY the final commit message content based on the included diff — no explanation, no code fences, no author or co-author attribution lines. " +
      "Treat the provided diff and any optional user draft as the complete context for composing the message; do not read extra instruction files or inspect other workspace files unless explicitly instructed. " +
      "Follow the Conventional Commits format: one or more 'type(scope): short description' header lines (use multiple headers if the change covers multiple distinct features or fixes), " +
      "followed by a blank line, then one or more body paragraphs explaining the implementation details of what changed and why. " +
      "Use markdown formatting in the body to improve readability where appropriate. Use bullet points for lists where necessary. " +
      "If you are explicitly instructed to submit the message with a tool, call that tool with the complete commit message and do not repeat the message outside the tool call.\n\n" +
      "Example format:\n" +
      "feat(auth): add OAuth2 login support\n\n" +
      "Implemented OAuth2 authorization code flow using the existing HTTP client. " +
      "Token refresh is handled automatically on 401 responses. " +
      "Session state is persisted to localStorage to survive page reloads\n\n" +
      "Only return or submit the commit message, no extra text. Here is the git diff to generate the commit message for:\n",
  },
  enableDiagnosticLogs: false,
};
