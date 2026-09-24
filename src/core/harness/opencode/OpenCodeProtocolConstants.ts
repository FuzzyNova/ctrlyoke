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

/** OpenCode CLI flags that ctrlyoke both writes and reads back. */
export const OPENCODE_CLI_FLAGS = {
  MODEL: "-m",
  SESSION: "-s",
  PROMPT: "--prompt",
} as const;

/**
 * How a resumed interactive launch (`--session`) hands its prompt to OpenCode.
 *
 * - `ARGUMENT`: pass `--prompt` alongside `--session`, as for a new session.
 * - `PLUGIN`: omit `--prompt`; the ctrlyoke plugin submits the prompt to the
 *   resumed session through OpenCode's server once that server is up.
 */
export const OPENCODE_RESUMED_PROMPT_DELIVERIES = {
  ARGUMENT: "argument",
  PLUGIN: "plugin",
} as const;

export type OpenCodeResumedPromptDelivery =
  (typeof OPENCODE_RESUMED_PROMPT_DELIVERIES)[keyof typeof OPENCODE_RESUMED_PROMPT_DELIVERIES];

/**
 * Environment the ctrlyoke plugin reads to submit a resumed session's prompt.
 * `src/scripts/ctrlyoke-opencode-plugin.ts` cannot import this module, so it
 * repeats these names; keep the two in step.
 */
export const OPENCODE_RESUME_PROMPT_ENV = {
  PROMPT: "CTRLYOKE_OPENCODE_RESUME_PROMPT",
  SESSION: "CTRLYOKE_OPENCODE_RESUME_SESSION",
  MODEL: "CTRLYOKE_OPENCODE_RESUME_MODEL",
} as const;
