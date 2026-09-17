/**
 * `type` values from Codex's headless **stdout** stream, which is a different
 * vocabulary from the response-item log protocol below — do not merge them.
 */
export const CODEX_STDOUT_EVENT_TYPES = {
  THREAD_STARTED: "thread.started",
} as const;

/** Wire-level values from Codex's response-item log protocol. */
export const CODEX_EVENT_TYPES = {
  RESPONSE_ITEM: "response_item",
  EVENT_MSG: "event_msg",
  SESSION_META: "session_meta",
  TURN_CONTEXT: "turn_context",
  COMPACTED: "compacted",
  TEXT: "text",
} as const;

export const CODEX_PAYLOAD_TYPES = {
  TOKEN_COUNT: "token_count",
  PATCH_APPLY_END: "patch_apply_end",
  TURN_COMPLETED: "turn.completed",
  USER_MESSAGE: "user_message",
  AGENT_MESSAGE: "agent_message",
  TODO_LIST: "todo_list",
  REASONING: "reasoning",
  FUNCTION_CALL: "function_call",
  FUNCTION_CALL_OUTPUT: "function_call_output",
  CUSTOM_TOOL_CALL: "custom_tool_call",
  CUSTOM_TOOL_CALL_OUTPUT: "custom_tool_call_output",
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
  EXEC: "exec",
  APPLY_PATCH: "apply_patch",
  TODO_LIST: "todo_list",
  UPDATE_PLAN: "update_plan",
  WRITE_STDIN: "write_stdin",
  SHELL_COMMAND: "shell_command",
  EXEC_COMMAND: "exec_command",
} as const;

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
