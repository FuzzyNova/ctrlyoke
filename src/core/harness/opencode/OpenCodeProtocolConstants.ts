/** Wire-level values from OpenCode's exported message/part protocol. */
export const OPENCODE_MESSAGE_ROLES = {
  USER: "user",
  ASSISTANT: "assistant",
} as const;

export const OPENCODE_EVENT_TYPES = {
  STEP_START: "step_start",
  STEP_FINISH: "step_finish",
  TEXT: "text",
  THINKING: "thinking",
  TOOL_USE: "tool_use",
  COMPACTION: "compaction",
  USER_TEXT: "user_text",
  RETRY: "retry",
} as const;

/** Durable event tags returned by the interactive history endpoint. */
export const OPENCODE_DURABLE_EVENT_TYPES = {
  PROMPT_ADMITTED: "session.next.prompt.admitted",
  PROMPTED: "session.next.prompted",
  STEP_STARTED: "session.next.step.started",
  STEP_ENDED: "session.next.step.ended",
  STEP_FAILED: "session.next.step.failed",
  TEXT_STARTED: "session.next.text.started",
  TEXT_ENDED: "session.next.text.ended",
  TOOL_CALLED: "session.next.tool.called",
  TOOL_PROGRESS: "session.next.tool.progress",
  TOOL_SUCCESS: "session.next.tool.success",
  TOOL_FAILED: "session.next.tool.failed",
  REASONING_STARTED: "session.next.reasoning.started",
  REASONING_ENDED: "session.next.reasoning.ended",
  RETRIED: "session.next.retried",
  COMPACTION_STARTED: "session.next.compaction.started",
  COMPACTION_ENDED: "session.next.compaction.ended",
  SHELL_STARTED: "session.next.shell.started",
  SHELL_ENDED: "session.next.shell.ended",
} as const;
