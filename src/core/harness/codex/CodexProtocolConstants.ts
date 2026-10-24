/**
 * `type` values from Codex's headless **stdout** stream, which is a different
 * vocabulary from the response-item log protocol below — do not merge them.
 */
export const CODEX_STDOUT_EVENT_TYPES = {
  THREAD_STARTED: "thread.started",
  /** Fatal stream error: `{ type, message }`. */
  ERROR: "error",
  /** Failed turn: `{ type, error: { message } }`. */
  TURN_FAILED: "turn.failed",
  /** Completed turn; supersedes earlier retried stream `error` events. */
  TURN_COMPLETED: "turn.completed",
} as const;

/** Wire-level values from Codex's response-item log protocol. */
export const CODEX_EVENT_TYPES = {
  RESPONSE_ITEM: "response_item",
  EVENT_MSG: "event_msg",
  SESSION_META: "session_meta",
  TURN_CONTEXT: "turn_context",
  COMPACTED: "compacted",
  TEXT: "text",
  /** Per-response usage, written as soon as the response ends. */
  TOKEN_USAGE_RECORD: "token_usage_record",
} as const;

export const CODEX_PAYLOAD_TYPES = {
  TASK_STARTED: "task_started",
  TASK_COMPLETE: "task_complete",
  TOKEN_COUNT: "token_count",
  PATCH_APPLY_END: "patch_apply_end",
  ITEM_COMPLETED: "item_completed",
  TURN_COMPLETED: "turn.completed",
  USER_MESSAGE: "user_message",
  AGENT_MESSAGE: "agent_message",
  TODO_LIST: "todo_list",
  REASONING: "reasoning",
  FUNCTION_CALL: "function_call",
  FUNCTION_CALL_OUTPUT: "function_call_output",
  CUSTOM_TOOL_CALL: "custom_tool_call",
  CUSTOM_TOOL_CALL_OUTPUT: "custom_tool_call_output",
  /** Built-in web tool call; its result goes to the model, not the log. */
  WEB_SEARCH_CALL: "web_search_call",
} as const;

/** `action.type` values on a `web_search_call` response item. */
export const CODEX_WEB_SEARCH_ACTION_TYPES = {
  SEARCH: "search",
  OPEN_PAGE: "open_page",
  FIND_IN_PAGE: "find_in_page",
} as const;

/** `status` values on a `web_search_call` response item. */
export const CODEX_WEB_SEARCH_STATUSES = {
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

export const CODEX_ITEM_TYPES = {
  MCP_TOOL_CALL: "McpToolCall",
} as const;

export const CODEX_MESSAGE_ROLES = {
  USER: "user",
  ASSISTANT: "assistant",
} as const;

export const CODEX_CONTENT_BLOCK_TYPES = {
  INPUT_TEXT: "input_text",
  OUTPUT_TEXT: "output_text",
  THINKING: "thinking",
  TOOL_USE: "tool_use",
} as const;

export const CODEX_TOOL_NAMES = {
  SPAWN_AGENT: "spawn_agent",
  EXEC: "exec",
  APPLY_PATCH: "apply_patch",
  TODO_LIST: "todo_list",
  UPDATE_PLAN: "update_plan",
  WRITE_STDIN: "write_stdin",
  SHELL_COMMAND: "shell_command",
  EXEC_COMMAND: "exec_command",
} as const;

export const CODEX_COLLABORATION_NAMESPACES = {
  COLLABORATION: "collaboration",
} as const;

export const CODEX_AGENT_MESSAGE_MARKERS = {
  FINAL_ANSWER: "FINAL_ANSWER",
} as const;

export const CODEX_ROLLOUT_FILE_PREFIX = "rollout-";
export const CODEX_ROLLOUT_FILE_SUFFIX = ".jsonl";

export const CODEX_EXEC_OPERATION_KINDS = {
  SHELL: "shell",
  PATCH: "patch",
  MCP: "mcp",
  PLAN: "plan",
  CONTINUE: "continue",
} as const;

export const CODEX_TODO_ITEM_STATUS = {
  COMPLETED: "completed",
} as const;

export const CODEX_HOOK_EVENTS = {
  PRE_TOOL_USE: "PreToolUse",
  PERMISSION_REQUEST: "PermissionRequest",
  POST_TOOL_USE: "PostToolUse",
  PRE_COMPACT: "PreCompact",
  POST_COMPACT: "PostCompact",
  SESSION_START: "SessionStart",
  USER_PROMPT_SUBMIT: "UserPromptSubmit",
  STOP: "Stop",
} as const;

export const CODEX_HOOK_HANDLER_TYPES = {
  COMMAND: "command",
} as const;
