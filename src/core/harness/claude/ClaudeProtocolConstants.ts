/** Wire-level values shared by Claude's Anthropic message and content blocks. */
export const CLAUDE_EVENT_TYPES = {
  USER: "user",
  ASSISTANT: "assistant",
  SYSTEM: "system",
  RESULT: "result",
  PROGRESS: "progress",
  ATTACHMENT: "attachment",
} as const;

/** `attachment.type` values Claude writes on `attachment` log events. */
export const CLAUDE_ATTACHMENT_TYPES = {
  /** A queued message Claude delivered mid-turn (human steer or task notification). */
  QUEUED_COMMAND: "queued_command",
} as const;

/** `attachment.commandMode` values on a `queued_command` attachment. */
export const CLAUDE_QUEUED_COMMAND_MODES = {
  PROMPT: "prompt",
  TASK_NOTIFICATION: "task-notification",
} as const;

/** `attachment.origin.kind` values on a `queued_command` attachment. */
export const CLAUDE_QUEUED_COMMAND_ORIGINS = {
  HUMAN: "human",
} as const;

export const CLAUDE_MODEL_SENTINELS = {
  SYNTHETIC: "<synthetic>",
} as const;

export const CLAUDE_CONTENT_BLOCK_TYPES = {
  TEXT: "text",
  TOOL_USE: "tool_use",
  THINKING: "thinking",
  TOOL_RESULT: "tool_result",
} as const;

export const CLAUDE_SYSTEM_SUBTYPES = {
  INIT: "init",
  TURN_DURATION: "turn_duration",
  COMPACT_BOUNDARY: "compact_boundary",
} as const;

export const CLAUDE_PROGRESS_TYPES = {
  BASH: "bash_progress",
} as const;

export const CLAUDE_TOOL_RESULT_TYPES = {
  CREATE: "create",
} as const;

export const CLAUDE_HOOK_CONFIG_TYPES = {
  JSON_STRING: "json-string",
} as const;

export const CLAUDE_STOP_REASONS = {
  TOOL_USE: "tool_use",
} as const;
