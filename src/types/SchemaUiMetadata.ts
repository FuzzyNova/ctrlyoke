import type { SelectOption } from "./SelectOption";
import {
  BROWSER_NOTIFICATION_MODES,
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  COMPARE_SOURCES,
  CONDITION_ACTIONS,
  CONTEXT_RESOLUTION_FAILURE_MODES,
  EXECUTION_MODES,
  HARNESS_IDS,
  HARNESS_INFO,
  HOOK_EVENT_NAMES,
  NOTIFICATION_EVENT_MODES,
  PERMISSION_MODES,
  PRIOR_CONTEXT_KEYWORDS,
  PRIOR_CONTEXT_SELECTION_MODES,
  INHERIT_DEFAULT_OPTION,
  NONE_OPTION,
  PROPERTY_EDITOR_MODES,
  RESUME_SESSION_SELECTIONS,
  RUN_HISTORY_LOCATIONS,
  SESSION_ID_SENTINELS,
  SCRIPT_OPERATORS,
  STEP_COLOR_MODES,
  TERMINAL_CURSOR_STYLES,
  TERMINAL_MOBILE_CONTROL_BAR,
  TOAST_LEVEL_MODES,
  WORKTREE_MODES,
  WORKTREE_MODE_SELECTIONS,
  TRUSTED_ROOTS_MODES,
  WORKFLOW_FILE_FORMATS,
  type BrowserNotificationMode,
  type CodexApprovalPolicy,
  type CodexSandboxMode,
  type ContextResolutionFailureMode,
  type ExecutionMode,
  type HarnessId,
  type HookEvent,
  type NotificationEventMode,
  type PermissionMode,
  type StepColorMode,
  type TerminalCursorStyle,
  type TerminalMobileControlBar,
  type ToastLevelMode,
  type WorktreeMode,
  type WorkflowFileFormat,
} from "./DashboardConstants";

export interface SchemaFieldMeta {
  path: string;
  label: string;
  alias?: { reason: string };
}

export const SCHEMA_FIELD_META = {
  color: { path: "color", label: "Step Color" },
  failFast: { path: "steps[].failFast", label: "Fail Fast" },
} as const satisfies Record<string, SchemaFieldMeta>;

export interface SchemaOptionMeta<V extends string> {
  value: V;
  label: string;
  alias?: { reason: string };
  visual?: {
    codicon: string;
    color: string;
    hoverColor?: string;
    activeColor?: string;
  };
  short?: string;
  pseudo?: { writes: string } | { omit: true };
}

export function toSelectOptions<
  T extends Record<string, SchemaOptionMeta<string>>,
>(meta: T, path: string): SelectOption[] {
  return Object.values(meta).map((option) => ({
    value: option.value,
    label: option.label,
    ...(option.short ? { short: option.short } : {}),
    schemaPath: path,
    ...(option.pseudo
      ? {
          pseudo:
            "writes" in option.pseudo
              ? { writes: option.pseudo.writes.replace(/\{path\}/g, path) }
              : option.pseudo,
        }
      : {}),
  }));
}

export const PERMISSION_MODE_OPTIONS_META: Record<
  PermissionMode,
  SchemaOptionMeta<PermissionMode>
> = {
  [PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL]: {
    value: PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL,
    label: "Dangerously Allow All (yolo)",
    short: "allow all!",
    alias: {
      reason: "Yolo is a widely recognized nickname for this risky mode.",
    },
    visual: {
      codicon: "workspace-untrusted",
      color: "text-error-fg",
      hoverColor: "hover:text-terminal-ansiBrightRed",
      activeColor: "text-terminal-ansiBrightRed",
    },
  },
  [PERMISSION_MODES.ALLOW_ALL]: {
    value: PERMISSION_MODES.ALLOW_ALL,
    label: "Allow All",
    short: "allow all",
    visual: {
      codicon: "workspace-trusted",
      color: "text-warning-fg",
      hoverColor: "hover:text-terminal-ansiBrightYellow",
      activeColor: "text-terminal-ansiBrightYellow",
    },
  },
  [PERMISSION_MODES.CUSTOM]: {
    value: PERMISSION_MODES.CUSTOM,
    label: "Custom",
    short: "custom",
    visual: {
      codicon: "workspace-trusted",
      color: "text-terminal-ansiGreen",
      hoverColor: "hover:text-terminal-ansiBrightGreen",
      activeColor: "text-terminal-ansiBrightGreen",
    },
  },
  [PERMISSION_MODES.NONE]: {
    value: PERMISSION_MODES.NONE,
    label: "None",
    short: "none",
    visual: {
      codicon: "workspace-trusted",
      color: "text-description-fg",
      hoverColor: "hover:text-foreground",
      activeColor: "text-foreground",
    },
  },
};

export const HARNESS_OPTIONS_META: Record<
  HarnessId,
  SchemaOptionMeta<HarnessId>
> = {
  [HARNESS_IDS.COPILOT_CLI]: {
    value: HARNESS_IDS.COPILOT_CLI,
    label: HARNESS_INFO[HARNESS_IDS.COPILOT_CLI].name,
    short: HARNESS_INFO[HARNESS_IDS.COPILOT_CLI].shortName,
    alias: { reason: "Uses the harness's established product name." },
  },
  [HARNESS_IDS.CLAUDE_CLI]: {
    value: HARNESS_IDS.CLAUDE_CLI,
    label: HARNESS_INFO[HARNESS_IDS.CLAUDE_CLI].name,
    short: HARNESS_INFO[HARNESS_IDS.CLAUDE_CLI].shortName,
    alias: { reason: "Uses the harness's established product name." },
  },
  [HARNESS_IDS.CODEX_CLI]: {
    value: HARNESS_IDS.CODEX_CLI,
    label: HARNESS_INFO[HARNESS_IDS.CODEX_CLI].name,
    short: HARNESS_INFO[HARNESS_IDS.CODEX_CLI].shortName,
    alias: { reason: "Uses the harness's established product name." },
  },
  [HARNESS_IDS.OPENCODE_CLI]: {
    value: HARNESS_IDS.OPENCODE_CLI,
    label: HARNESS_INFO[HARNESS_IDS.OPENCODE_CLI].name,
    short: HARNESS_INFO[HARNESS_IDS.OPENCODE_CLI].shortName,
    alias: { reason: "Uses the harness's established product name." },
  },
  [HARNESS_IDS.QWEN_CLI]: {
    value: HARNESS_IDS.QWEN_CLI,
    label: HARNESS_INFO[HARNESS_IDS.QWEN_CLI].name,
    short: HARNESS_INFO[HARNESS_IDS.QWEN_CLI].shortName,
    alias: { reason: "Uses the harness's established product name." },
  },
  [HARNESS_IDS.ANTIGRAVITY_CLI]: {
    value: HARNESS_IDS.ANTIGRAVITY_CLI,
    label: HARNESS_INFO[HARNESS_IDS.ANTIGRAVITY_CLI].name,
    short: HARNESS_INFO[HARNESS_IDS.ANTIGRAVITY_CLI].shortName,
    alias: { reason: "Uses the harness's established product name." },
  },
};

export const WORKTREE_MODE_OPTIONS_META: Record<
  WorktreeMode,
  SchemaOptionMeta<WorktreeMode>
> = {
  [WORKTREE_MODES.MANAGED]: {
    value: WORKTREE_MODES.MANAGED,
    label: "Managed",
  },
  [WORKTREE_MODES.NAMED]: {
    value: WORKTREE_MODES.NAMED,
    label: "Named",
  },
};

/** UI modes for the workflow worktree selector, including its false sentinel. */
export const WORKTREE_SELECTION_OPTIONS_META = {
  [WORKTREE_MODE_SELECTIONS.NONE]: {
    value: WORKTREE_MODE_SELECTIONS.NONE,
    label: "None",
    pseudo: { writes: "{path}: false" },
  },
  [WORKTREE_MODE_SELECTIONS.MANAGED]: {
    value: WORKTREE_MODE_SELECTIONS.MANAGED,
    label: "Managed",
    pseudo: { writes: "{path}: true" },
  },
  [WORKTREE_MODE_SELECTIONS.NAMED]: {
    value: WORKTREE_MODE_SELECTIONS.NAMED,
    label: "Named",
    pseudo: { writes: "{path}: { mode: named, ... }" },
  },
} as const;

export const AGENT_SELECTION_OPTIONS_META = {
  [INHERIT_DEFAULT_OPTION]: {
    value: INHERIT_DEFAULT_OPTION,
    label: "Inherit",
    pseudo: { omit: true },
  },
  [NONE_OPTION]: {
    value: NONE_OPTION,
    label: "None",
    pseudo: { writes: "agent: null" },
  },
} as const;

/** The workflow editor encodes an explicit no-agent selection as an empty string. */
export const WORKFLOW_AGENT_SELECTION_OPTIONS_META = {
  "": {
    value: "",
    label: "None",
    pseudo: { writes: 'agent: ""' },
  },
} as const;

export const SKILLS_SELECTION_OPTIONS_META = {
  [INHERIT_DEFAULT_OPTION]: {
    value: INHERIT_DEFAULT_OPTION,
    label: "Inherit",
    pseudo: { omit: true },
  },
  [NONE_OPTION]: {
    value: NONE_OPTION,
    label: "None",
    pseudo: { writes: "skills: null" },
  },
} as const;

export const ADDITIONAL_ARGS_SELECTION_OPTIONS_META = {
  [INHERIT_DEFAULT_OPTION]: {
    value: INHERIT_DEFAULT_OPTION,
    label: "Inherit",
    pseudo: { omit: true },
  },
  [NONE_OPTION]: {
    value: NONE_OPTION,
    label: "None",
    pseudo: { writes: "additionalArgs: null" },
  },
  [PROPERTY_EDITOR_MODES.CUSTOM]: {
    value: PROPERTY_EDITOR_MODES.CUSTOM,
    label: "Custom",
    pseudo: { writes: 'additionalArgs: "<value>"' },
  },
} as const;

export const CONDITION_SELECTION_OPTIONS_META = {
  [PROPERTY_EDITOR_MODES.INHERIT]: {
    value: PROPERTY_EDITOR_MODES.INHERIT,
    label: "Inherit",
    pseudo: { omit: true },
  },
  [NONE_OPTION]: {
    value: NONE_OPTION,
    label: "None",
    pseudo: { writes: "null" },
  },
  [PROPERTY_EDITOR_MODES.CUSTOM]: {
    value: PROPERTY_EDITOR_MODES.CUSTOM,
    label: "Custom",
    pseudo: { writes: '{ script: "<value>" }' },
  },
} as const;

export const ERROR_BEHAVIOR_SELECTION_OPTIONS_META = {
  [PROPERTY_EDITOR_MODES.INHERIT]: {
    value: PROPERTY_EDITOR_MODES.INHERIT,
    label: "Inherit",
    pseudo: { omit: true },
  },
  [PROPERTY_EDITOR_MODES.CUSTOM]: {
    value: PROPERTY_EDITOR_MODES.CUSTOM,
    label: "Custom",
    pseudo: { writes: '{ errorBehavior: { onError: "stopWorkflow" } }' },
  },
} as const;

export const RESUME_SESSION_OPTIONS_META = {
  [INHERIT_DEFAULT_OPTION]: {
    value: INHERIT_DEFAULT_OPTION,
    label: "Inherit",
    pseudo: { omit: true },
  },
  [RESUME_SESSION_SELECTIONS.YES]: {
    value: RESUME_SESSION_SELECTIONS.YES,
    label: "Resume",
    pseudo: { writes: "resumeSession: true" },
  },
  [RESUME_SESSION_SELECTIONS.NO]: {
    value: RESUME_SESSION_SELECTIONS.NO,
    label: "New Session",
    pseudo: { writes: "resumeSession: false" },
  },
  [SESSION_ID_SENTINELS.FINAL_STEP]: {
    value: SESSION_ID_SENTINELS.FINAL_STEP,
    label: "Final Step Session",
    pseudo: {
      writes: "resumeSession: true, sessionId: <FINAL_STEP sentinel>",
    },
  },
} as const;

export const TRUSTED_ROOTS_SELECTION_OPTIONS_META = {
  [TRUSTED_ROOTS_MODES.INHERIT]: {
    value: TRUSTED_ROOTS_MODES.INHERIT,
    label: "Inherit",
    pseudo: { omit: true },
  },
  [TRUSTED_ROOTS_MODES.NONE]: {
    value: TRUSTED_ROOTS_MODES.NONE,
    label: "None",
    pseudo: { writes: "trustedExternalRoots: null" },
  },
  [TRUSTED_ROOTS_MODES.CUSTOM]: {
    value: TRUSTED_ROOTS_MODES.CUSTOM,
    label: "Custom",
    pseudo: { writes: "trustedExternalRoots: [<paths>]" },
  },
} as const;

export const EXECUTION_MODE_OPTIONS_META: Record<
  ExecutionMode,
  SchemaOptionMeta<ExecutionMode>
> = {
  [EXECUTION_MODES.INTERACTIVE]: {
    value: EXECUTION_MODES.INTERACTIVE,
    label: "Interactive",
  },
  [EXECUTION_MODES.HEADLESS]: {
    value: EXECUTION_MODES.HEADLESS,
    label: "Headless",
  },
};

export const PRIOR_CONTEXT_KEYWORD_OPTIONS_META: Record<
  (typeof PRIOR_CONTEXT_KEYWORDS)[keyof typeof PRIOR_CONTEXT_KEYWORDS],
  SchemaOptionMeta<
    (typeof PRIOR_CONTEXT_KEYWORDS)[keyof typeof PRIOR_CONTEXT_KEYWORDS]
  >
> = {
  [PRIOR_CONTEXT_KEYWORDS.ALL]: {
    value: PRIOR_CONTEXT_KEYWORDS.ALL,
    label: "All",
    short: "all",
  },
  [PRIOR_CONTEXT_KEYWORDS.PREVIOUS]: {
    value: PRIOR_CONTEXT_KEYWORDS.PREVIOUS,
    label: "Previous",
    short: "prev",
  },
  [PRIOR_CONTEXT_KEYWORDS.NONE]: {
    value: PRIOR_CONTEXT_KEYWORDS.NONE,
    label: "None",
    short: "none",
  },
  [PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_ALL]: {
    value: PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_ALL,
    label: "Final Step All",
    short: "fs-all",
  },
  [PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_PREVIOUS]: {
    value: PRIOR_CONTEXT_KEYWORDS.FINAL_STEP_PREVIOUS,
    label: "Final Step Previous",
    short: "fs-prev",
  },
};

export const PRIOR_CONTEXT_SELECT_OPTIONS_META = {
  ...PRIOR_CONTEXT_KEYWORD_OPTIONS_META,
  [INHERIT_DEFAULT_OPTION]: {
    value: INHERIT_DEFAULT_OPTION,
    label: "Inherit",
    pseudo: { omit: true },
  },
  [PRIOR_CONTEXT_SELECTION_MODES.RUN]: {
    value: PRIOR_CONTEXT_SELECTION_MODES.RUN,
    label: "Completed run output",
    pseudo: { writes: "priorContext: { workflowKey: ..., runRef: ... }" },
  },
  [PRIOR_CONTEXT_SELECTION_MODES.CUSTOM]: {
    value: PRIOR_CONTEXT_SELECTION_MODES.CUSTOM,
    label: "Custom",
    pseudo: { writes: "priorContext: [1,2]" },
  },
} as const;

export const CONDITION_ACTION_OPTIONS_META: Record<
  (typeof CONDITION_ACTIONS)[keyof typeof CONDITION_ACTIONS],
  SchemaOptionMeta<(typeof CONDITION_ACTIONS)[keyof typeof CONDITION_ACTIONS]>
> = {
  [CONDITION_ACTIONS.CONTINUE]: {
    value: CONDITION_ACTIONS.CONTINUE,
    label: "Continue",
  },
  [CONDITION_ACTIONS.STOP_WORKFLOW]: {
    value: CONDITION_ACTIONS.STOP_WORKFLOW,
    label: "Stop Workflow",
  },
  [CONDITION_ACTIONS.RETRY]: { value: CONDITION_ACTIONS.RETRY, label: "Retry" },
  [CONDITION_ACTIONS.SKIP_PROMPT]: {
    value: CONDITION_ACTIONS.SKIP_PROMPT,
    label: "Skip Prompt",
  },
};

/** Actions available to a prompt script step's onPass/onFail fields. */
export const SCRIPT_STEP_CONDITION_ACTION_OPTIONS_META = {
  [CONDITION_ACTIONS.CONTINUE]:
    CONDITION_ACTION_OPTIONS_META[CONDITION_ACTIONS.CONTINUE],
  [CONDITION_ACTIONS.STOP_WORKFLOW]:
    CONDITION_ACTION_OPTIONS_META[CONDITION_ACTIONS.STOP_WORKFLOW],
};

/** Shared labels for the subset accepted by errorBehavior.onError. */
export const ERROR_BEHAVIOR_ACTION_OPTIONS_META = {
  [CONDITION_ACTIONS.STOP_WORKFLOW]:
    CONDITION_ACTION_OPTIONS_META[CONDITION_ACTIONS.STOP_WORKFLOW],
  [CONDITION_ACTIONS.RETRY]:
    CONDITION_ACTION_OPTIONS_META[CONDITION_ACTIONS.RETRY],
  [CONDITION_ACTIONS.CONTINUE]:
    CONDITION_ACTION_OPTIONS_META[CONDITION_ACTIONS.CONTINUE],
};

export const COMPARE_SOURCE_OPTIONS_META: Record<
  (typeof COMPARE_SOURCES)[keyof typeof COMPARE_SOURCES],
  SchemaOptionMeta<(typeof COMPARE_SOURCES)[keyof typeof COMPARE_SOURCES]>
> = {
  [COMPARE_SOURCES.STDOUT]: { value: COMPARE_SOURCES.STDOUT, label: "Stdout" },
  [COMPARE_SOURCES.STDERR]: { value: COMPARE_SOURCES.STDERR, label: "Stderr" },
  [COMPARE_SOURCES.EXIT_CODE]: {
    value: COMPARE_SOURCES.EXIT_CODE,
    label: "Exit Code",
  },
};

export const SCRIPT_OPERATOR_OPTIONS_META: Record<
  (typeof SCRIPT_OPERATORS)[keyof typeof SCRIPT_OPERATORS],
  SchemaOptionMeta<(typeof SCRIPT_OPERATORS)[keyof typeof SCRIPT_OPERATORS]>
> = {
  [SCRIPT_OPERATORS.EQ]: {
    value: SCRIPT_OPERATORS.EQ,
    label: "==",
    alias: {
      reason:
        "Symbol notation is compact and familiar for an equality operator; the YAML token remains eq.",
    },
  },
  [SCRIPT_OPERATORS.NE]: {
    value: SCRIPT_OPERATORS.NE,
    label: "!=",
    alias: {
      reason:
        "Symbol notation is compact and familiar for an inequality operator; the YAML token remains ne.",
    },
  },
  [SCRIPT_OPERATORS.CONTAINS]: {
    value: SCRIPT_OPERATORS.CONTAINS,
    label: "Contains",
  },
  [SCRIPT_OPERATORS.NOT_CONTAINS]: {
    value: SCRIPT_OPERATORS.NOT_CONTAINS,
    label: "Does Not Contain",
    alias: {
      reason:
        "Natural-language phrasing makes the negative operator easier to scan.",
    },
  },
  [SCRIPT_OPERATORS.GTE]: {
    value: SCRIPT_OPERATORS.GTE,
    label: ">=",
    alias: {
      reason:
        "Symbol notation is compact and familiar for a numeric comparison; the YAML token remains gte.",
    },
  },
  [SCRIPT_OPERATORS.GT]: {
    value: SCRIPT_OPERATORS.GT,
    label: ">",
    alias: {
      reason:
        "Symbol notation is compact and familiar for a numeric comparison; the YAML token remains gt.",
    },
  },
  [SCRIPT_OPERATORS.LTE]: {
    value: SCRIPT_OPERATORS.LTE,
    label: "<=",
    alias: {
      reason:
        "Symbol notation is compact and familiar for a numeric comparison; the YAML token remains lte.",
    },
  },
  [SCRIPT_OPERATORS.LT]: {
    value: SCRIPT_OPERATORS.LT,
    label: "<",
    alias: {
      reason:
        "Symbol notation is compact and familiar for a numeric comparison; the YAML token remains lt.",
    },
  },
  [SCRIPT_OPERATORS.MATCHES]: {
    value: SCRIPT_OPERATORS.MATCHES,
    label: "Matches Regex",
    alias: {
      reason:
        "Regex clarifies that matches uses a regular expression rather than a literal substring.",
    },
  },
  [SCRIPT_OPERATORS.IS_EMPTY]: {
    value: SCRIPT_OPERATORS.IS_EMPTY,
    label: "Is Empty",
  },
  [SCRIPT_OPERATORS.IS_NOT_EMPTY]: {
    value: SCRIPT_OPERATORS.IS_NOT_EMPTY,
    label: "Is Not Empty",
  },
};

export const HOOK_EVENT_OPTIONS_META: Record<
  HookEvent,
  SchemaOptionMeta<HookEvent>
> = {
  [HOOK_EVENT_NAMES.STOP]: { value: HOOK_EVENT_NAMES.STOP, label: "Stop" },
  [HOOK_EVENT_NAMES.SESSION_START]: {
    value: HOOK_EVENT_NAMES.SESSION_START,
    label: "Session Start",
  },
  [HOOK_EVENT_NAMES.PRE_TOOL_USE]: {
    value: HOOK_EVENT_NAMES.PRE_TOOL_USE,
    label: "Pre Tool Use",
  },
  [HOOK_EVENT_NAMES.POST_TOOL_USE]: {
    value: HOOK_EVENT_NAMES.POST_TOOL_USE,
    label: "Post Tool Use",
  },
  [HOOK_EVENT_NAMES.USER_PROMPT_SUBMIT]: {
    value: HOOK_EVENT_NAMES.USER_PROMPT_SUBMIT,
    label: "User Prompt Submit",
  },
  [HOOK_EVENT_NAMES.PERMISSION_REQUEST]: {
    value: HOOK_EVENT_NAMES.PERMISSION_REQUEST,
    label: "Permission Request",
  },
  [HOOK_EVENT_NAMES.NOTIFICATION]: {
    value: HOOK_EVENT_NAMES.NOTIFICATION,
    label: "Notification",
  },
  [HOOK_EVENT_NAMES.ERROR]: { value: HOOK_EVENT_NAMES.ERROR, label: "Error" },
};

export const MCP_TRANSPORT_OPTIONS_META = {
  "streamable-http": { value: "streamable-http", label: "streamable-http" },
  sse: { value: "sse", label: "sse" },
} as const;

export const NOTIFICATION_EVENT_MODE_OPTIONS_META: Record<
  NotificationEventMode,
  SchemaOptionMeta<NotificationEventMode>
> = {
  [NOTIFICATION_EVENT_MODES.ALL]: {
    value: NOTIFICATION_EVENT_MODES.ALL,
    label: "All",
  },
  [NOTIFICATION_EVENT_MODES.FAILURES_ONLY]: {
    value: NOTIFICATION_EVENT_MODES.FAILURES_ONLY,
    label: "Failures Only",
  },
  [NOTIFICATION_EVENT_MODES.NONE]: {
    value: NOTIFICATION_EVENT_MODES.NONE,
    label: "None",
  },
};

export const TOAST_LEVEL_OPTIONS_META: Record<
  ToastLevelMode,
  SchemaOptionMeta<ToastLevelMode>
> = {
  [TOAST_LEVEL_MODES.ALL]: { value: TOAST_LEVEL_MODES.ALL, label: "All" },
  [TOAST_LEVEL_MODES.WARNING_AND_ERROR]: {
    value: TOAST_LEVEL_MODES.WARNING_AND_ERROR,
    label: "Warning and Error",
  },
  [TOAST_LEVEL_MODES.ERROR_ONLY]: {
    value: TOAST_LEVEL_MODES.ERROR_ONLY,
    label: "Error Only",
  },
  [TOAST_LEVEL_MODES.NONE]: { value: TOAST_LEVEL_MODES.NONE, label: "None" },
};

export const BROWSER_NOTIFICATION_MODE_OPTIONS_META: Record<
  BrowserNotificationMode,
  SchemaOptionMeta<BrowserNotificationMode>
> = {
  [BROWSER_NOTIFICATION_MODES.CONNECTED_ONLY]: {
    value: BROWSER_NOTIFICATION_MODES.CONNECTED_ONLY,
    label: "Connected Only",
  },
  [BROWSER_NOTIFICATION_MODES.PUSH]: {
    value: BROWSER_NOTIFICATION_MODES.PUSH,
    label: "Push",
  },
  [BROWSER_NOTIFICATION_MODES.NEVER]: {
    value: BROWSER_NOTIFICATION_MODES.NEVER,
    label: "Never",
  },
};

export const STEP_COLOR_MODE_OPTIONS_META: Record<
  StepColorMode,
  SchemaOptionMeta<StepColorMode>
> = {
  [STEP_COLOR_MODES.NONE]: { value: STEP_COLOR_MODES.NONE, label: "None" },
  [STEP_COLOR_MODES.HARNESS]: {
    value: STEP_COLOR_MODES.HARNESS,
    label: "Harness",
  },
  [STEP_COLOR_MODES.UNIQUE]: {
    value: STEP_COLOR_MODES.UNIQUE,
    label: "Unique",
  },
};

export const CONTEXT_RESOLUTION_FAILURE_OPTIONS_META: Record<
  ContextResolutionFailureMode,
  SchemaOptionMeta<ContextResolutionFailureMode>
> = {
  [CONTEXT_RESOLUTION_FAILURE_MODES.WARN]: {
    value: CONTEXT_RESOLUTION_FAILURE_MODES.WARN,
    label: "Warn",
  },
  [CONTEXT_RESOLUTION_FAILURE_MODES.FAIL]: {
    value: CONTEXT_RESOLUTION_FAILURE_MODES.FAIL,
    label: "Fail",
  },
};

export const CODEX_SANDBOX_MODE_OPTIONS_META: Record<
  CodexSandboxMode,
  SchemaOptionMeta<CodexSandboxMode>
> = {
  [CODEX_SANDBOX_MODES.READ_ONLY]: {
    value: CODEX_SANDBOX_MODES.READ_ONLY,
    label: "Read Only",
  },
  [CODEX_SANDBOX_MODES.WORKSPACE_WRITE]: {
    value: CODEX_SANDBOX_MODES.WORKSPACE_WRITE,
    label: "Workspace Write",
  },
  [CODEX_SANDBOX_MODES.DANGER_FULL_ACCESS]: {
    value: CODEX_SANDBOX_MODES.DANGER_FULL_ACCESS,
    label: "Danger Full Access",
  },
};

export const CODEX_APPROVAL_POLICY_OPTIONS_META: Record<
  CodexApprovalPolicy,
  SchemaOptionMeta<CodexApprovalPolicy>
> = {
  [CODEX_APPROVAL_POLICIES.UNTRUSTED]: {
    value: CODEX_APPROVAL_POLICIES.UNTRUSTED,
    label: "Untrusted",
  },
  [CODEX_APPROVAL_POLICIES.ON_REQUEST]: {
    value: CODEX_APPROVAL_POLICIES.ON_REQUEST,
    label: "On Request",
  },
  [CODEX_APPROVAL_POLICIES.NEVER]: {
    value: CODEX_APPROVAL_POLICIES.NEVER,
    label: "Never",
  },
};

export const TERMINAL_CURSOR_STYLE_OPTIONS_META: Record<
  TerminalCursorStyle,
  SchemaOptionMeta<TerminalCursorStyle>
> = {
  [TERMINAL_CURSOR_STYLES.BLOCK]: {
    value: TERMINAL_CURSOR_STYLES.BLOCK,
    label: "Block",
  },
  [TERMINAL_CURSOR_STYLES.UNDERLINE]: {
    value: TERMINAL_CURSOR_STYLES.UNDERLINE,
    label: "Underline",
  },
  [TERMINAL_CURSOR_STYLES.BAR]: {
    value: TERMINAL_CURSOR_STYLES.BAR,
    label: "Bar",
  },
};

export const TERMINAL_MOBILE_CONTROL_BAR_OPTIONS_META: Record<
  TerminalMobileControlBar,
  SchemaOptionMeta<TerminalMobileControlBar>
> = {
  [TERMINAL_MOBILE_CONTROL_BAR.AUTO]: {
    value: TERMINAL_MOBILE_CONTROL_BAR.AUTO,
    label: "Auto",
  },
  [TERMINAL_MOBILE_CONTROL_BAR.ALWAYS]: {
    value: TERMINAL_MOBILE_CONTROL_BAR.ALWAYS,
    label: "Always",
  },
  [TERMINAL_MOBILE_CONTROL_BAR.NEVER]: {
    value: TERMINAL_MOBILE_CONTROL_BAR.NEVER,
    label: "Never",
  },
};

export const RUN_HISTORY_LOCATION_OPTIONS_META: Record<
  (typeof RUN_HISTORY_LOCATIONS)[keyof typeof RUN_HISTORY_LOCATIONS],
  SchemaOptionMeta<
    (typeof RUN_HISTORY_LOCATIONS)[keyof typeof RUN_HISTORY_LOCATIONS]
  >
> = {
  [RUN_HISTORY_LOCATIONS.USER]: {
    value: RUN_HISTORY_LOCATIONS.USER,
    label: "User",
  },
  [RUN_HISTORY_LOCATIONS.WORKSPACE]: {
    value: RUN_HISTORY_LOCATIONS.WORKSPACE,
    label: "Workspace",
  },
};

export const DEFAULT_FORMAT_OPTIONS_META: Record<
  WorkflowFileFormat,
  SchemaOptionMeta<WorkflowFileFormat>
> = {
  [WORKFLOW_FILE_FORMATS.YAML]: {
    value: WORKFLOW_FILE_FORMATS.YAML,
    label: "YAML",
  },
  [WORKFLOW_FILE_FORMATS.JSON]: {
    value: WORKFLOW_FILE_FORMATS.JSON,
    label: "JSON",
  },
};
