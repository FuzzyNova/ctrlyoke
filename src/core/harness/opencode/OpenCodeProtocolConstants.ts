import { TOOL_PERMISSION_CATEGORIES } from "../../../types/DashboardConstants";

/** Wire-level values from OpenCode's exported message/part protocol. */
export const OPENCODE_MESSAGE_ROLES = {
  USER: "user",
  ASSISTANT: "assistant",
} as const;

export const OPENCODE_EVENT_TYPES = {
  TEXT: "text",
  TOOL_USE: "tool_use",
  USER_TEXT: "user_text",
  RETRY: "retry",
  STEP_START: "step_start",
  STEP_FINISH: "step_finish",
  COMPACTION: "compaction",
  SUBTASK: "subtask",
} as const;

export const OPENCODE_PART_TYPES = {
  TOOL: "tool",
  TEXT: "text",
  REASONING: "reasoning",
  STEP_START: "step-start",
  STEP_FINISH: "step-finish",
  COMPACTION: "compaction",
  SUBTASK: "subtask",
} as const;

export const OPENCODE_TOOL_NAMES = {
  BASH: TOOL_PERMISSION_CATEGORIES.BASH,
  WRITE: TOOL_PERMISSION_CATEGORIES.WRITE,
  EDIT: TOOL_PERMISSION_CATEGORIES.EDIT,
  READ: TOOL_PERMISSION_CATEGORIES.READ,
} as const;

export const OPENCODE_STEP_FINISH_REASONS = {
  STOP: "stop",
} as const;
