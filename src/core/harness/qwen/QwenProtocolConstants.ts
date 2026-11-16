import { STREAM_JSON_CONTROL } from "../shared/StreamJsonHeadlessControlChannel";

/** Wire-level message event types from Qwen's Gemini-style log protocol. */
export const QWEN_EVENT_TYPES = {
  USER: STREAM_JSON_CONTROL.USER_TYPE,
  ASSISTANT: "assistant",
  TOOL_RESULT: "tool_result",
  RESULT: STREAM_JSON_CONTROL.RESULT_TYPE,
} as const;

/** Stream-json SDK control protocol vocabulary used by Qwen's headless channel. */
export const QWEN_CONTROL = {
  REQUEST_TYPE: STREAM_JSON_CONTROL.REQUEST_TYPE,
  RESPONSE_TYPE: STREAM_JSON_CONTROL.RESPONSE_TYPE,
  USER_TYPE: STREAM_JSON_CONTROL.USER_TYPE,
  INITIALIZE_SUBTYPE: STREAM_JSON_CONTROL.INITIALIZE_SUBTYPE,
  CAN_USE_TOOL_SUBTYPE: STREAM_JSON_CONTROL.CAN_USE_TOOL_SUBTYPE,
  INTERRUPT_SUBTYPE: STREAM_JSON_CONTROL.INTERRUPT_SUBTYPE,
  SUCCESS_SUBTYPE: STREAM_JSON_CONTROL.SUCCESS_SUBTYPE,
  ERROR_SUBTYPE: STREAM_JSON_CONTROL.ERROR_SUBTYPE,
  USER_ROLE: STREAM_JSON_CONTROL.USER_ROLE,
  DENY_BEHAVIOR: STREAM_JSON_CONTROL.DENY_BEHAVIOR,
} as const;

/** A silent Qwen initialize would otherwise leave the step waiting indefinitely. */
export const QWEN_INITIALIZE_TIMEOUT_MS = 10_000;

/**
 * Start of the error Qwen 0.27+ returns, without running the tool, when the
 * model calls a deferred MCP tool before loading its schema with
 * `tool_search`. The model then loads it and calls the tool again, so one
 * intended call can appear as a refused attempt followed by the real one.
 */
export const QWEN_DEFERRED_TOOL_REFUSAL_PREFIX = "[tool_call bridge refused]";

/** Qwen's flags that choose the model (`-m, --model`). */
export const QWEN_MODEL_FLAGS: ReadonlySet<string> = new Set(["--model", "-m"]);

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
 * output line; those wake a turn but do not finish the task. A subagent's
 * `<agent>.meta.json` `status` uses the same terminal values (and `running` /
 * `paused` otherwise).
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

/**
 * File names beside each other in `<project>/subagents/<sessionId>/`: a
 * subagent's transcript and the lifecycle sidecar Qwen patches to a terminal
 * `status` only after the transcript's last record is written.
 */
export const QWEN_SUBAGENT_FILES = {
  TRANSCRIPT_SUFFIX: ".jsonl",
  META_SUFFIX: ".meta.json",
} as const;

/**
 * Qwen's sandbox switch. It outranks `--sandbox` and `tools.sandbox` (Qwen
 * 0.26.0 docs, "Enable sandboxing (in order of precedence)"), so Sandbox Off
 * sets it as well as passing `--sandbox=false`.
 */
export const QWEN_SANDBOX_ENV = "QWEN_SANDBOX";

/** `systemPayload.uiEvent["event.name"]` values in Qwen's chat JSONL telemetry. */
export const QWEN_TELEMETRY_EVENTS = {
  API_ERROR: "qwen-code.api_error",
} as const;

/**
 * HTTP statuses on a `qwen-code.api_error` that Qwen never retries, so the
 * turn has failed. Qwen's outer retry (`retryWithBackoff`'s
 * `shouldRetryOnError` in `packages/core/src/core/llm-chat.ts`) retries 429,
 * 5xx and transport-wrapped 400s, and through `isRetryableUpstreamError` /
 * `classifyRetryError` (`packages/core/src/utils/retryErrorClassification.ts`)
 * also 408/409 and any bodyless or network-wrapped 4xx. Only 401 and 403 are
 * classified `fail-fast` (`auth-error`) unconditionally. A user's Qwen
 * `retryErrorCodes` setting, or a provider body code Qwen reads as a rate
 * limit, can make even these retryable.
 */
export const QWEN_FAIL_FAST_HTTP_STATUSES: ReadonlySet<number> = new Set([
  401, 403,
]);

/**
 * A main-session prompt id is `<sessionId>########<n>`; a subagent's is
 * `<sessionId>#<subagentId>#<n>` (`agent-core.ts`). Qwen's internal background
 * prompts (`isInternalPromptId` in `packages/core/src/utils/internalPromptIds.ts`)
 * are never written to the chat JSONL.
 */
export const QWEN_MAIN_TURN_PROMPT_ID_PATTERN = /^[^#]+########\d+$/;

/** Failure text when a Qwen `api_error` carries neither a message nor a type. */
export const QWEN_API_ERROR_FALLBACK = "Qwen API request failed";
