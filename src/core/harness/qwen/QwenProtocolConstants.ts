/** Wire-level message event types from Qwen's Gemini-style log protocol. */
export const QWEN_EVENT_TYPES = {
  USER: "user",
  ASSISTANT: "assistant",
  TOOL_RESULT: "tool_result",
  RESULT: "result",
} as const;

export const QWEN_CONTENT_PART_TYPES = {
  TEXT: "text",
  TOOL_USE: "tool_use",
  THINKING: "thinking",
} as const;

/** `subtype` values Qwen stamps on `user` records it writes on its own behalf. */
export const QWEN_USER_RECORD_SUBTYPES = {
  /** A background task's `<task-notification>` (shell, agent, monitor, ...). */
  NOTIFICATION: "notification",
  /** A scheduled (`cron_create` / loop) prompt firing. */
  CRON: "cron",
} as const;

/** `provenance` of a `user` record a human actually typed. */
export const QWEN_REAL_USER_PROVENANCE = "real_user";

export const QWEN_TOOL_NAMES = {
  MCP_CALL_WRAPPER: "tool_call",
  MCP_TOOL_PREFIX: "mcp__",
  AGENT: "agent",
  SHELL: "run_shell_command",
  MONITOR: "monitor",
  TASK_STOP: "task_stop",
} as const;

/**
 * Tool-result text that confirms a background launch, keyed by the launching
 * tool; group 1 is the task id that the later `<task-notification>` echoes.
 * The result text is the only place Qwen reports the id.
 */
export const QWEN_BACKGROUND_LAUNCH_RESULTS: ReadonlyMap<string, RegExp> =
  new Map([
    [QWEN_TOOL_NAMES.SHELL, /^Background shell started\.\r?\nid: (\S+)/],
    [
      QWEN_TOOL_NAMES.AGENT,
      /^Background agent launched successfully\.\r?\ntask_id: (\S+)/,
    ],
    [QWEN_TOOL_NAMES.MONITOR, /^Monitor started\.\r?\nid: (\S+)/],
  ]);

/**
 * `task_stop`'s result for a monitor. Qwen cancels a monitor with
 * `notify: false`, so no `<task-notification>` follows; a stopped shell or
 * agent still gets its terminal notification.
 */
export const QWEN_MONITOR_STOPPED_RESULT = /^Monitor "([^"]+)" cancelled\./;

/** Matches one `<task-notification>` envelope (shell, agent, monitor, workflow). */
export const QWEN_TASK_NOTIFICATION_PATTERN =
  /<task-notification>([\s\S]*?)<\/task-notification>/g;

/**
 * Terminal `<status>` values. A monitor also sends `running` pulses for each
 * output line; those wake a turn but do not finish the task.
 */
export const QWEN_TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export const QWEN_AGENT_ARGUMENTS = {
  DESCRIPTION: "description",
  TYPE: "subagent_type",
  PROMPT: "prompt",
} as const;
