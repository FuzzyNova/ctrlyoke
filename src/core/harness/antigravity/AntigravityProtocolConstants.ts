/** Wire-level `source`/`status` values from Antigravity's transcript protocol. */
export const ANTIGRAVITY_WIRE_VALUES = {
  MODEL: "MODEL",
  SYSTEM: "SYSTEM",
  USER_EXPLICIT: "USER_EXPLICIT",
  SYSTEM_MESSAGE: "SYSTEM_MESSAGE",
  GENERIC: "GENERIC",
  RUNNING: "RUNNING",
  DONE: "DONE",
} as const;

/**
 * `entry.type` values from Antigravity's transcript protocol (SCREAMING_SNAKE_CASE).
 * Distinct vocabulary from `ANTIGRAVITY_TOOL_NAMES` below: a planner tool call's
 * `name` (e.g. "call_mcp_tool", "list_dir") is not a case-folded version of its
 * result's entry type (e.g. "MCP_TOOL", "LIST_DIRECTORY") — several pairs use
 * unrelated words entirely, so the two vocabularies cannot be merged into one
 * case-insensitive comparison without risking a false match.
 */
export const ANTIGRAVITY_ENTRY_TYPES = {
  PLANNER_RESPONSE: "PLANNER_RESPONSE",
  RUN_COMMAND: "RUN_COMMAND",
  VIEW_FILE: "VIEW_FILE",
  CODE_ACTION: "CODE_ACTION",
  LIST_DIRECTORY: "LIST_DIRECTORY",
  GREP_SEARCH: "GREP_SEARCH",
  MCP_TOOL: "MCP_TOOL",
  LIST_RESOURCES: "LIST_RESOURCES",
  READ_RESOURCE: "READ_RESOURCE",
  SEARCH_WEB: "SEARCH_WEB",
  ASK_QUESTION: "ASK_QUESTION",
  USER_INPUT: "USER_INPUT",
  CHECKPOINT: "CHECKPOINT",
  ERROR_MESSAGE: "ERROR_MESSAGE",
} as const;

/** Planner tool-call `name` values (lower snake_case), as invoked by the model. */
export const ANTIGRAVITY_TOOL_NAMES = {
  RUN_COMMAND: "run_command",
  VIEW_FILE: "view_file",
  WRITE_TO_FILE: "write_to_file",
  REPLACE_FILE_CONTENT: "replace_file_content",
  MULTI_REPLACE_FILE_CONTENT: "multi_replace_file_content",
  CALL_MCP_TOOL: "call_mcp_tool",
  LIST_RESOURCES: "list_resources",
  READ_RESOURCE: "read_resource",
  SEARCH_WEB: "search_web",
  LIST_DIR: "list_dir",
  GREP_SEARCH: "grep_search",
  ASK_QUESTION: "ask_question",
} as const;
