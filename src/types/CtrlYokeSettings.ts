import {
  AUTO_DETECT_HARNESS,
  BROWSER_NOTIFICATION_MODES,
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  CONTEXT_RESOLUTION_FAILURE_MODES,
  DEFAULT_MODELS,
  NOTIFICATION_EVENT_MODES,
  TERMINAL_CURSOR_STYLES,
  TERMINAL_MOBILE_CONTROL_BAR,
  type HarnessId,
  type TerminalCursorStyle,
  type TerminalMobileControlBar,
  type NotificationEventMode,
  type BrowserNotificationMode,
  type ContextResolutionFailureMode,
  type CodexApprovalPolicy,
  type CodexSandboxMode,
  type HookEvent,
  type ExecutionMode,
  type PermissionMode,
  type CtrlYokeMcpMode,
  CTRLYOKE_MCP_MODES,
  RUN_HISTORY_LOCATIONS,
  DEFAULT_TRASH_RETENTION_DAYS,
  STATUS_LINE_HARNESS_IDS,
  STEP_COLOR_MODES,
  TOAST_LEVEL_MODES,
  type StepColorMode,
  type StatusLineHarnessId,
  type ToastLevelMode,
  DEFAULT_MAX_STEPS,
  EDITOR_FONT_SIZE_VSCODE,
  type EditorFontSize,
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
  WorktreeConfig,
  PriorContext,
} from "./CtrlYokeTypes";
import {
  DEFAULT_STATUS_LINE_FORMAT,
  type StatusLineSegment,
  type UsagePercentDirection,
} from "../utils/StatuslineFormat";
import { DEFAULT_TERMINAL_BAR_LAYOUT } from "../utils/TerminalControlBarFormat";

export type { WorktreeConfig } from "./CtrlYokeTypes";
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

/** Pixel bounds for the font-size settings; mirrored in settings-schema.json. */
export const FONT_SIZE_LIMITS = {
  terminal: { min: 8, max: 24 },
  output: { min: 10, max: 24 },
  editor: { min: 8, max: 32 },
} as const satisfies Record<string, { min: number; max: number }>;

export type FontSizeLimits =
  (typeof FONT_SIZE_LIMITS)[keyof typeof FONT_SIZE_LIMITS];

/** Round to a whole pixel and clamp into `limits`; non-numbers yield `fallback`. */
export function clampFontSize(
  value: unknown,
  limits: FontSizeLimits,
  fallback: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(limits.max, Math.max(limits.min, Math.round(value)));
}

export interface StatusLineHarnessSettings {
  enabled: boolean;
  /** Empty string = no custom command detected/configured. */
  customCommand: string;
  /** Whether ctrlyoke's own branded line wins over custom command output. */
  useCtrlyokeStyle: boolean;
  format: StatusLineSegment[];
}

/** Dashboard-only per-harness identity colors for correlating workflow steps across panes. */
export interface HarnessColorSettings {
  byHarness: Partial<Record<HarnessId, string>>;
  script: string;
}

export interface CoordinationSettings {
  readNotesPageSize: number;
  maxNoteLength: number;
  maxEntries: number;
  maxBoardBytes: number;
  maxEntryAgeDays: number;
  cliParticipantTtlMinutes: number;
  allowExternalParticipants: boolean;
}

/** User or workspace definition for an LSP executable. */
export interface LanguageServerDefinition {
  command: string[];
  languages: string[];
  extensions: string[];
  rootMarkers: string[];
  env?: Record<string, string>;
}

export interface LanguageServersSettings {
  /** Server id → executable definition. Workspace entries require approval before launch. */
  definitions: Record<string, LanguageServerDefinition>;
  /** Language id → selected server id, or false to disable language intelligence. */
  use: Record<string, string | false>;
  /** Server id → LSP initialization/configuration settings. */
  settings: Record<string, Record<string, unknown>>;
  /** User-only idle timeout in minutes. */
  idleShutdownMinutes: number;
  /** User-only maximum number of concurrently running servers. */
  maxRunning: number;
  /** User-only opt-in to start selected servers when the host launches. */
  startOnLaunch: boolean;
}

export interface CtrlYokeGlobalSettings {
  /** Published schema URL used by editors to validate this settings file. */
  $schema?: string;
  /** Settings format version; omitted on hand-authored legacy files (format 1). */
  schemaVersion?: number;
  // General (format/template/behavior toggles)
  general: {
    defaultFormat: "yaml" | "json";
    defaultTemplate: string;
    autoLoadRecentSession: boolean;
    omitPreviouslyAttachedAgentsSkillsOnResume: boolean;
  };

  /** Saved per-variable defaults keyed by template id and variable name. */
  templates: {
    variableDefaults: Record<string, Record<string, string>>;
  };

  // Defaults (mirrors executionProperties 1:1)
  defaults: {
    /** Empty ({@link AUTO_DETECT_HARNESS}) means the first installed harness. */
    harness: HarnessId | typeof AUTO_DETECT_HARNESS;
    models: Partial<Record<HarnessId, string>>;
    additionalArgs: Partial<Record<HarnessId, string>>;
    agent: string;
    skills: string[];
    /** Secret names granted to newly created workflows. */
    secrets?: string[];
    executionMode: ExecutionMode;
    resumeSession: boolean;
    priorContext: PriorContext;
    mcpServers: (string | McpServerConfig)[];
    hooks: UserHookConfig[];
    errorBehavior?: ErrorBehavior | null;
    toolPermissions: {
      mode: PermissionMode;
      allowedTools: string[];
      deniedTools: string[];
    } | null;
    /** Default end condition applied to all new workflows. null/undefined = disabled. */
    endCondition?: EndCondition | null;
    /** Default pre-condition applied to all new workflows. null/undefined = disabled. */
    preCondition?: PreCondition | null;
    /** Default worktree behavior for workflows that omit a root worktree value. */
    worktree: WorktreeConfig;
  };

  /** User-only machine/repository placement configuration. */
  worktrees: {
    root: string;
  };

  /** Cross-workflow, execution-root coordination board settings. */
  coordination: CoordinationSettings;

  /** Managed language server definitions, selections, and lifecycle settings. */
  languageServers: LanguageServersSettings;

  /** User-only location for persisted workflow run history. */
  storage: {
    runHistoryLocation: RunHistoryLocation;
    /** Days a deleted run stays in Recently deleted before it is purged. */
    trashRetentionDays: number;
  };

  // Permissions (harness-specific advanced settings)
  permissions: {
    // Codex CLI-specific
    codexSandboxMode: CodexSandboxMode;
    codexApprovalPolicy: CodexApprovalPolicy;
    /**
     * Absolute directory paths outside the workspace that ctrlyoke may read for
     * prompt attachments and open from file links. Workspace files are always
     * allowed regardless of this list. User-scope entries are trusted
     * immediately; workspace-scope entries require a one-time batch approval
     * (see `ExternalRootsTrustStore`) before they take effect. See
     * `dev/backlog/ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md`.
     */
    trustedExternalRoots: string[];
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

  statusLine: {
    useDifferentFormatPerHarness: boolean;
    sharedFormat: StatusLineSegment[];
    byHarness: Record<StatusLineHarnessId, StatusLineHarnessSettings>;
  };

  // Execution
  execution: {
    /** When true, keep the TUI alive and write follow-up prompts directly into the PTY. */
    injectMode: boolean;
    maxPromptTimeoutSec: number; // seconds, -1 = unlimited
    scriptTimeoutSec: number; // seconds
    closeTerminalOnComplete: boolean;
    autoDeleteTempFiles: boolean;
    contextResolutionFailure: ContextResolutionFailureMode;
    ctrlyokeMcpMode: CtrlYokeMcpMode;
  };

  // Queue
  queue: {
    maxSteps: number;
    maxParallelSteps: number;
    maxWorkflowExecutionTimeSec: number; // seconds; -1 = unlimited
  };

  // Runs (always-on execution history)
  runs: {
    maxRuns: number;
    /**
     * Approximate working-set budget, in MB, for caching parsed
     * history-search documents from the most recently run workflows in
     * memory. This bounds the extension host's real process memory (RSS),
     * not the literal byte count `estimateHistorySearchDocumentBytes` sums —
     * V8/GC overhead untracked by that estimate makes actual RSS run well
     * above the accounted heap bytes, so the default is calibrated from RSS
     * measured against a real 1,560-run index
     * (`scripts/bench-history-search-document-cache.mjs`), not derived from
     * the byte math alone. Raising this value does not scale RSS 1:1 —
     * re-measure before trusting a large increase. The cache is a bounded
     * prefix of the existing recency-ordered search scan, not a second data
     * path — a miss just falls back to the streamed disk scan. 0 disables
     * the cache entirely.
     */
    historySearchCacheMb: number;
  };

  // Terminal
  terminal: TerminalSettings;

  // UI
  ui: {
    showCliCommand: boolean;
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
     * Wrap long lines in code views (workspace file editor, script/condition
     * editors, diffs). When false they scroll horizontally. The prompt editor
     * always wraps.
     */
    wordWrap: boolean;
    /** Output pane font size in pixels (`FONT_SIZE_LIMITS.output`). */
    outputFontSize: number;
    /**
     * Font size of the prompt and code editors: the prompt editor, retry
     * prompts, condition and script-step scripts, and the workspace file
     * editor. `EDITOR_FONT_SIZE_VSCODE` follows the host editor; one-line form
     * fields keep their own control size either way.
     */
    editorFontSize: EditorFontSize;
    /**
     * Treat `@file`/`#symbol`/`~git`/`$context` references in the prompt editor
     * as atomic units: cursor motion skips over them and Backspace/Delete
     * removes the whole reference at once (no character-by-character editing
     * inside a reference). Clicking a chip opens it; right-click/long-press
     * opens its context menu.
     */
    atomicContextReferences: boolean;
    /**
     * Allow an AI-generated file link outside trusted roots to offer a "Trust
     * Parent Folder" action. When false, untrusted external links are still
     * blocked outright — this only controls whether the trust offer appears.
     * Trusted roots (workspace or `permissions.trustedExternalRoots`)
     * always open directly regardless of this setting.
     */
    offerTrustForUntrustedFileLinks: boolean;
    /** Show token cost estimates in dashboard and CLI presentation. */
    showCostEstimates: boolean;
    /** Dashboard step identity color mode. */
    stepColorMode: StepColorMode;
    /** Dashboard-only per-harness identity color controls. */
    harnessColors: HarnessColorSettings;
  };

  diagnostics: {
    verboseLogging: boolean;
    logRawCliOutput: boolean;
  };

  // Server (new)
  server: {
    autoStart: boolean;
    port: number;
    /**
     * Ordered ports to try, in order, if `port` is already in use, before
     * falling back to an OS-assigned port. Lets a workspace pin a stable,
     * bookmarkable URL even when the primary port is often taken by another
     * running instance (e.g. a daily-driver window).
     */
    fallbackPorts: number[];
    theme: "auto" | "light" | "dark";
    bindAddress: string; // "127.0.0.1" = localhost only; "0.0.0.0" = all interfaces
    /**
     * Name other devices use to reach this computer from outside the local
     * network (dynamic DNS, Tailscale MagicDNS, or a public IPv4 address).
     * Empty when unused. See `src/utils/ServerPublicHostname.ts`.
     */
    publicHostname: string;
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
    systemPrompt: string;
  };
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
  toastLevel: ToastLevelMode;
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
  schemaVersion: 1,
  general: {
    defaultFormat: "yaml",
    defaultTemplate: "blank",
    autoLoadRecentSession: true,
    omitPreviouslyAttachedAgentsSkillsOnResume: true,
  },
  templates: {
    variableDefaults: {},
  },
  defaults: {
    harness: AUTO_DETECT_HARNESS,
    models: { ...DEFAULT_MODELS },
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
    worktree: false,
  },
  worktrees: {
    root: "",
  },
  coordination: {
    readNotesPageSize: 50,
    maxNoteLength: 2_000,
    maxEntries: 1_000,
    maxBoardBytes: 5 * 1024 * 1024,
    maxEntryAgeDays: 7,
    cliParticipantTtlMinutes: 30,
    allowExternalParticipants: true,
  },
  languageServers: {
    definitions: {},
    use: {},
    settings: {},
    idleShutdownMinutes: 10,
    maxRunning: 4,
    startOnLaunch: false,
  },
  storage: {
    runHistoryLocation: RUN_HISTORY_LOCATIONS.USER,
    trashRetentionDays: DEFAULT_TRASH_RETENTION_DAYS,
  },
  permissions: {
    codexSandboxMode: CODEX_SANDBOX_MODES.WORKSPACE_WRITE,
    codexApprovalPolicy: CODEX_APPROVAL_POLICIES.ON_REQUEST,
    trustedExternalRoots: [],
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
  statusLine: {
    useDifferentFormatPerHarness: false,
    sharedFormat: DEFAULT_STATUS_LINE_FORMAT.map((segment) => ({ ...segment })),
    byHarness: {
      [STATUS_LINE_HARNESS_IDS.CLAUDE]: {
        enabled: true,
        customCommand: "",
        useCtrlyokeStyle: true,
        format: DEFAULT_STATUS_LINE_FORMAT.map((segment) => ({ ...segment })),
      },
      [STATUS_LINE_HARNESS_IDS.ANTIGRAVITY]: {
        enabled: true,
        customCommand: "",
        useCtrlyokeStyle: true,
        format: DEFAULT_STATUS_LINE_FORMAT.map((segment) => ({ ...segment })),
      },
      [STATUS_LINE_HARNESS_IDS.COPILOT]: {
        enabled: true,
        customCommand: "",
        useCtrlyokeStyle: true,
        format: DEFAULT_STATUS_LINE_FORMAT.map((segment) => ({ ...segment })),
      },
      [STATUS_LINE_HARNESS_IDS.QWEN]: {
        enabled: true,
        customCommand: "",
        useCtrlyokeStyle: true,
        format: DEFAULT_STATUS_LINE_FORMAT.map((segment) => ({ ...segment })),
      },
    },
  },
  execution: {
    injectMode: true,
    maxPromptTimeoutSec: -1,
    scriptTimeoutSec: 3600,
    ctrlyokeMcpMode: CTRLYOKE_MCP_MODES.NATIVE,
    closeTerminalOnComplete: false,
    autoDeleteTempFiles: true,
    contextResolutionFailure: CONTEXT_RESOLUTION_FAILURE_MODES.WARN,
  },
  queue: {
    maxSteps: DEFAULT_MAX_STEPS,
    maxParallelSteps: 6,
    maxWorkflowExecutionTimeSec: -1,
  },
  runs: {
    maxRuns: -1,
    historySearchCacheMb: 320,
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
    wordWrap: true,
    outputFontSize: 13,
    editorFontSize: EDITOR_FONT_SIZE_VSCODE,
    atomicContextReferences: true,
    offerTrustForUntrustedFileLinks: true,
    showCostEstimates: true,
    stepColorMode: STEP_COLOR_MODES.NONE,
    harnessColors: {
      byHarness: {},
      script: "#808080",
    },
  },
  server: {
    autoStart: false,
    port: 4747,
    fallbackPorts: [],
    theme: "auto",
    bindAddress: "127.0.0.1",
    publicHostname: "",
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
      promptComplete: NOTIFICATION_EVENT_MODES.NONE,
      hookEvents: {
        stop: false,
        sessionStart: false,
        preToolUse: false,
        postToolUse: false,
        userPromptSubmit: false,
        permissionRequest: false,
        notification: false,
        error: false,
      },
    },
    toastLevel: TOAST_LEVEL_MODES.ALL,
    includeWorkflowName: true,
    includePromptName: true,
    onlyWhenWindowUnfocused: true,
  },
  commit: {
    harness: "",
    model: "",
    systemPrompt:
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
  diagnostics: { verboseLogging: false, logRawCliOutput: false },
};
