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
  TASK_STARTED: "task_started",
  TASK_PROGRESS: "task_progress",
  TASK_NOTIFICATION: "task_notification",
  TASK_UPDATED: "task_updated",
} as const;

/** Spawn tools emitted by Claude Code; `Task` is the legacy name for `Agent`. */
export const CLAUDE_SUBAGENT_TOOL_NAMES = {
  AGENT: "Agent",
  LEGACY_TASK: "Task",
} as const;

/** Tool-result text that confirms an asynchronous (background) launch. */
export const CLAUDE_ASYNC_LAUNCH_RESULT_MARKERS = {
  AGENT: "Async agent launched successfully",
  MONITOR: "Monitor started",
} as const;

/** `toolUseResult.status` of a tool call that started an asynchronous task. */
export const CLAUDE_TOOL_RESULT_STATUSES = {
  ASYNC_LAUNCHED: "async_launched",
} as const;

/**
 * Claude Code's multi-agent `Workflow` tool. It always runs in the background:
 * its result is `{status: "async_launched", taskId, runId, ...}` and its agents
 * write transcripts under `<sessionId>/subagents/workflows/<runId>/`.
 */
export const CLAUDE_WORKFLOW_TOOL_NAME = "Workflow";

/** Spawn-card agent type shown for a `Workflow` call. */
export const CLAUDE_WORKFLOW_AGENT_TYPE = "workflow";

/** Directory and file names of a workflow run under the session's `subagents/`. */
export const CLAUDE_WORKFLOW_PATHS = {
  SUBAGENTS_DIRECTORY: "subagents",
  WORKFLOWS_DIRECTORY: "workflows",
  JOURNAL_FILE: "journal.jsonl",
} as const;

/** `type` values in a workflow run's `journal.jsonl` that ctrlyoke reads. */
export const CLAUDE_WORKFLOW_JOURNAL_TYPES = {
  /** An agent started: carries `agentId`, `label` and `phase`. */
  STARTED: "started",
  /** An agent finished: carries `agentId` and its structured result. */
  RESULT: "result",
} as const;

/** Whether a Claude tool name spawns a subagent (`Agent`, or the older `Task`). */
export function isClaudeSubagentToolName(name: unknown): boolean {
  return (
    name === CLAUDE_SUBAGENT_TOOL_NAMES.AGENT ||
    name === CLAUDE_SUBAGENT_TOOL_NAMES.LEGACY_TASK
  );
}

/** Terminal status values Claude reports in `task_notification` records. */
export const CLAUDE_TASK_STATUSES = {
  COMPLETED: "completed",
  FAILED: "failed",
  STOPPED: "stopped",
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
  END_TURN: "end_turn",
} as const;
