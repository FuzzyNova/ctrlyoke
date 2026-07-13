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
  ErrorBehavior,
  EndCondition,
  McpServerConfig,
  PreCondition,
  UserHookConfig,
} from "./CtrlYokeTypes";

type CliAdditionalArgsHarnessId = Exclude<HarnessId, "copilot-chat">;

export interface CtrlYokeGlobalSettings {
  // General (format/template/behavior toggles)
  general: {
    defaultFormat: "yaml" | "json";
    defaultTemplate: string;
    autoLoadRecentSession: boolean;
    omitPreviouslyAttachedAgentsSkillsOnResume: boolean;
    includeFullDiffsInPriorContext: boolean;
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
    errorBehavior?: ErrorBehavior | null;
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
    // Shared across copilot-cli, claude-cli, codex-cli, qwen-cli, antigravity-cli (not supported by opencode-cli or copilot-chat)
    allowedDirs: string[];
    // Copilot CLI-specific
    copilotAllowAllPaths: boolean;
    // Codex CLI-specific
    codexSandboxMode: "read-only" | "workspace-write" | "danger-full-access";
    codexApprovalPolicy: "untrusted" | "on-request" | "never";
    /**
     * Absolute directory paths outside the workspace that ctrlyoke may read for
     * prompt attachments and open from file links. Workspace files are always
     * allowed regardless of this list. User-scope entries are trusted
     * immediately; workspace-scope entries require a one-time batch approval
     * (see `ExternalRootsTrustStore`) before they take effect. See
     * `dev/backlog/ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md`.
     */
    allowedExternalFileRoots: string[];
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
    autoExpandEditorWhenTyping: boolean;
    /**
     * Render `@file` references as absolute paths in the final prompt sent to
     * the harness/model, instead of the as-typed relative path. Stored
     * workflow text is always relative regardless of this setting — this only
     * affects render-time output. Forced on in multi-root workspaces and by
     * providers that hard-require it (e.g. Antigravity) regardless of this
     * value; see `resolveEffectiveAbsoluteReferences`.
     */
    useAbsolutePathReferences: boolean;
    /**
     * Minimum projected output row count required before TanStack virtualization
     * is used. 0 = always virtualize, -1 = never virtualize.
     */
    outputVirtualizationRowThreshold: number;
    confirmDeleteOperations: boolean;
    confirmResetOperations: boolean;
    hideGitIgnoredFiles: boolean;
    /**
     * Allow an AI-generated file link outside trusted roots to offer a "Trust
     * Parent Folder" action. When false, untrusted external links are still
     * blocked outright — this only controls whether the trust offer appears.
     * Trusted roots (workspace or `permissions.allowedExternalFileRoots`)
     * always open directly regardless of this setting.
     */
    offerTrustForUntrustedFileLinks: boolean;
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
  notifications: CtrlYokeNotificationSettings;

  // Commit message generation
  commit: {
    harness: HarnessId | "";
    model: string;
    prompt: string;
  };

  // Advanced
  enableDiagnosticLogs: boolean;
}

export interface CtrlYokeNotificationSettings {
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

/** Partial version of CtrlYokeGlobalSettings for config file contents (3-level deep partial) */
export type PartialCtrlYokeSettings = {
  [K in keyof CtrlYokeGlobalSettings]?: CtrlYokeGlobalSettings[K] extends object
    ? {
        [J in keyof CtrlYokeGlobalSettings[K]]?: CtrlYokeGlobalSettings[K][J] extends object
          ? Partial<CtrlYokeGlobalSettings[K][J]>
          : CtrlYokeGlobalSettings[K][J];
      }
    : CtrlYokeGlobalSettings[K];
};

/** Default values for all settings */
export const CTRLYOKE_SETTINGS_DEFAULTS: CtrlYokeGlobalSettings = {
  general: {
    defaultFormat: "yaml",
    defaultTemplate: "blank",
    autoLoadRecentSession: true,
    omitPreviouslyAttachedAgentsSkillsOnResume: true,
    includeFullDiffsInPriorContext: true,
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
      "antigravity-cli": "Claude Sonnet 4.6 (Thinking)",
    },
    additionalArgs: {},
    agent: "",
    skills: [],
    resumeSession: false,
    priorContext: "none",
    mcpServers: [],
    hooks: [],
    errorBehavior: null,
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
    allowedExternalFileRoots: [],
  },
  execution: {
    mode: "interactive",
    injectMode: false,
    maxPromptTimeout: -1,
    scriptTimeout: 300,
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
    maxSize: 100,
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
    autoExpandEditorWhenTyping: true,
    useAbsolutePathReferences: false,
    outputVirtualizationRowThreshold: 200,
    confirmDeleteOperations: true,
    confirmResetOperations: true,
    hideGitIgnoredFiles: false,
    offerTrustForUntrustedFileLinks: true,
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
        error: false,
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
