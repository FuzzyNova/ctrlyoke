import {
  BROWSER_NOTIFICATION_MODES,
  CONTEXT_RESOLUTION_FAILURE_MODES,
  NOTIFICATION_EVENT_MODES,
  TERMINAL_CURSOR_STYLES,
  TERMINAL_MOBILE_CONTROL_BAR,
  type HarnessId,
  type TerminalCursorStyle,
  type TerminalMobileControlBar,
  type NotificationEventMode,
  type BrowserNotificationMode,
  type ContextResolutionFailureMode,
  type HookEvent,
  type ExecutionMode,
  RUN_HISTORY_LOCATIONS,
  STATUS_LINE_TRACKING_PROVIDERS,
  type StatusLineTrackingProvider,
  WORKTREE_MODES,
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
  WorktreeDefaultConfig,
} from "./CtrlYokeTypes";
import {
  DEFAULT_STATUS_LINE_FORMAT,
  type StatusLineSegment,
  type UsagePercentDirection,
} from "../utils/StatuslineFormat";
import { DEFAULT_TERMINAL_BAR_LAYOUT } from "../utils/TerminalControlBarFormat";

export type { WorktreeDefaultConfig } from "./CtrlYokeTypes";

export type RunHistoryLocation =
  (typeof RUN_HISTORY_LOCATIONS)[keyof typeof RUN_HISTORY_LOCATIONS];

/** User-supplied per-million-token pricing for a harness/model pair. */
export interface ModelPricingOverride {
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok?: number;
  cacheWritePerMTok?: number;
  reasoningPerMTok?: number;
}

/** Default number of lines shown before a tool result is collapsed. */
export const DEFAULT_COLLAPSED_TOOL_OUTPUT_LINE_COUNT = 3;

export interface StatusLineTrackingSettings {
  enabled: boolean;
  /** Empty string = no custom command detected/configured. */
  customCommand: string;
  /** Whether ctrlyoke's own branded line wins over custom command output. */
  useCtrlyokeStyle: boolean;
  format: StatusLineSegment[];
}

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
    additionalArgs: Partial<Record<HarnessId, string>>;
    agent: string;
    skills: string[];
    /** Secret names granted to newly created workflows. */
    secrets?: string[];
    executionMode: ExecutionMode;
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
    /** Default worktree behavior for workflows that omit a root worktree value. */
    worktree: WorktreeDefaultConfig;
  };

  /** User-only machine/repository placement configuration. */
  worktrees: {
    root: string;
  };

  /** User-only location for persisted workflow run history. */
  storage: {
    runHistoryLocation: RunHistoryLocation;
  };

  // Permissions (harness-specific advanced settings)
  permissions: {
    // Codex CLI-specific
    codexSandboxMode: "read-only" | "workspace-write" | "danger-full-access";
    codexApprovalPolicy: "untrusted" | "on-request" | "never";
    /** Settings for providers that install a global statusline command. */
    statusLineTracking: Record<
      StatusLineTrackingProvider,
      StatusLineTrackingSettings
    > & {
      useDifferentFormatPerHarness: boolean;
      sharedFormat: StatusLineSegment[];
    };
    /**
     * Absolute directory paths outside the workspace that ctrlyoke may read for
     * prompt attachments and open from file links. Workspace files are always
     * allowed regardless of this list. User-scope entries are trusted
     * immediately; workspace-scope entries require a one-time batch approval
     * (see `ExternalRootsTrustStore`) before they take effect. See
     * `dev/backlog/ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md`.
     */
    allowedExternalFileRoots: string[];
    /**
     * Apply pattern-based heuristics (e.g. `token=...`, `Bearer ...`,
     * private-key blocks) during secret redaction, in addition to exact
     * matches of resolved managed/env secret values. Exact-value redaction
     * always stays on regardless of this setting — only the broader,
     * false-positive-prone heuristic matching is affected.
     */
    heuristicSecretRedactionEnabled: boolean;
  };

  /** Workspace-local provider quota and observed-usage collection controls. */
  usageTracking: {
    enabled: boolean;
    providerRefreshEnabled: boolean;
    persistObservedUsage: boolean;
    warningPercentUsed: number;
    percentDirection: UsagePercentDirection;
  };

  /** Explicit price overrides for models absent from the bundled table. */
  modelPricing: Partial<
    Record<HarnessId, Record<string, ModelPricingOverride>>
  >;

  // Execution
  execution: {
    /** When true, keep the TUI alive and write follow-up prompts directly into the PTY. */
    injectMode: boolean;
    maxPromptTimeout: number; // seconds, -1 = unlimited
    scriptTimeout: number; // seconds
    closeTerminalOnComplete: boolean;
    autoDeleteTempFiles: boolean;
    strictContextResolution: ContextResolutionFailureMode;
  };

  // Queue
  queue: {
    maxSize: number;
    maxWorkflowExecutionTime: number; // seconds; -1 = unlimited
    unlimitedMode: boolean;
    notifyOnExtension: boolean;
  };

  // Runs (always-on execution history)
  runs: {
    maxRuns: number;
  };

  // Terminal
  terminal: TerminalSettings;

  // UI
  ui: {
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
    /** Approximate number of wrapped result lines shown before Bash and generic tool output collapses. */
    collapsedToolOutputLineCount: number;
    confirmDeleteOperations: boolean;
    confirmResetOperations: boolean;
    confirmContinuationDiscardOperations: boolean;
    hideGitIgnoredFiles: boolean;
    /**
     * Treat `@file`/`#symbol`/`~git`/`$context` references in the prompt editor
     * as atomic units: cursor motion skips over them and Backspace/Delete
     * removes the whole reference at once (no character-by-character editing
     * inside a reference). Clicking/long-pressing a reference still opens it.
     */
    atomicContextReferences: boolean;
    /**
     * Allow an AI-generated file link outside trusted roots to offer a "Trust
     * Parent Folder" action. When false, untrusted external links are still
     * blocked outright — this only controls whether the trust offer appears.
     * Trusted roots (workspace or `permissions.allowedExternalFileRoots`)
     * always open directly regardless of this setting.
     */
    offerTrustForUntrustedFileLinks: boolean;
    /** Hide token cost estimates from dashboard and CLI presentation. */
    hideCost: boolean;
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
    /** Background color for the SVG favicon and PWA icon (hex, e.g. '#3994BC'). */
    iconBgColor: string;
    /** Foreground (path/stroke) color for the SVG favicon and PWA icon (hex, e.g. '#051923'). */
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
  mobileBarLayout: TerminalMobileBarLayout;
  mobileCustomShortcuts: TerminalShortcut[];
}

export interface TerminalMobileBarLayout {
  bar: string[];
  popup: string[];
  hidden: string[];
}

export interface TerminalShortcut {
  id: string;
  label: string;
  sequence: string;
}

/** Partial version of CtrlYokeGlobalSettings for sparse config file contents. */
type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export type PartialCtrlYokeSettings = DeepPartial<CtrlYokeGlobalSettings>;

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
      "claude-cli": "sonnet",
      "codex-cli": "gpt-5.5",
      "opencode-cli": "opencode/big-pickle",
      "qwen-cli": "qwen3.5-plus",
      "antigravity-cli": "gemini-3.6-flash-medium",
    },
    additionalArgs: {},
    agent: "",
    skills: [],
    secrets: [],
    executionMode: "interactive",
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
    worktree: {
      mode: WORKTREE_MODES.NONE,
    },
  },
  worktrees: {
    root: "",
  },
  storage: {
    runHistoryLocation: RUN_HISTORY_LOCATIONS.USER,
  },
  permissions: {
    codexSandboxMode: "workspace-write",
    codexApprovalPolicy: "on-request",
    statusLineTracking: {
      useDifferentFormatPerHarness: false,
      sharedFormat: DEFAULT_STATUS_LINE_FORMAT.map((segment) => ({ ...segment })),
      [STATUS_LINE_TRACKING_PROVIDERS.CLAUDE]: {
        enabled: true,
        customCommand: "",
        useCtrlyokeStyle: true,
        format: DEFAULT_STATUS_LINE_FORMAT.map((segment) => ({ ...segment })),
      },
      [STATUS_LINE_TRACKING_PROVIDERS.ANTIGRAVITY]: {
        enabled: true,
        customCommand: "",
        useCtrlyokeStyle: true,
        format: DEFAULT_STATUS_LINE_FORMAT.map((segment) => ({ ...segment })),
      },
    },
    allowedExternalFileRoots: [],
    heuristicSecretRedactionEnabled: true,
  },
  usageTracking: {
    enabled: true,
    providerRefreshEnabled: true,
    persistObservedUsage: true,
    warningPercentUsed: 80,
    percentDirection: "used",
  },
  modelPricing: {},
  execution: {
    injectMode: true,
    maxPromptTimeout: -1,
    scriptTimeout: 3600,
    closeTerminalOnComplete: false,
    autoDeleteTempFiles: true,
    strictContextResolution: CONTEXT_RESOLUTION_FAILURE_MODES.WARN,
  },
  queue: {
    maxSize: 100,
    maxWorkflowExecutionTime: -1,
    unlimitedMode: false,
    notifyOnExtension: true,
  },
  runs: {
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
    mobileBarLayout: {
      bar: [...DEFAULT_TERMINAL_BAR_LAYOUT.bar],
      popup: [...DEFAULT_TERMINAL_BAR_LAYOUT.popup],
      hidden: [...DEFAULT_TERMINAL_BAR_LAYOUT.hidden],
    },
    mobileCustomShortcuts: [],
  },
  ui: {
    showCliCommand: true,
    logRawCliOutput: false,
    showHeadlessPermissionWarning: true,
    autoFocusOutputOnExecution: true,
    openPromptsInSecondGroup: false,
    respectGitignoreForCompletions: true,
    autoExpandEditorWhenTyping: true,
    useAbsolutePathReferences: false,
    outputVirtualizationRowThreshold: 200,
    collapsedToolOutputLineCount: DEFAULT_COLLAPSED_TOOL_OUTPUT_LINE_COUNT,
    confirmDeleteOperations: true,
    confirmResetOperations: true,
    confirmContinuationDiscardOperations: true,
    hideGitIgnoredFiles: false,
    atomicContextReferences: true,
    offerTrustForUntrustedFileLinks: true,
    hideCost: false,
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
