/** Wire-level values from Copilot CLI's JSONL and ACP protocols. */
export interface CopilotMcpToolIdentity {
  mcpServerName?: string;
  mcpConfigServerName?: string;
  mcpToolName?: string;
}

export const COPILOT_CLI_FLAGS = {
  ACP: "--acp",
  ASSISTED_APPROVAL: "--assisted-approval",
  RESUME: "--resume",
  OUTPUT_FORMAT: "--output-format",
  PRINT_PROMPT: "-p",
  PROMPT: "--prompt",
  INTERACTIVE: "-i",
} as const;

export const COPILOT_ACP_METHODS = {
  INITIALIZE: "initialize",
  SESSION_NEW: "session/new",
  SESSION_LOAD: "session/load",
  SESSION_PROMPT: "session/prompt",
  SESSION_REQUEST_PERMISSION: "session/request_permission",
} as const;

export const COPILOT_ACP_PERMISSION_KINDS = {
  ALLOW_ONCE: "allow_once",
  ALLOW_ALWAYS: "allow_always",
  REJECT_ONCE: "reject_once",
} as const;

export const COPILOT_ACP_PERMISSION_OUTCOMES = {
  SELECTED: "selected",
} as const;

export const COPILOT_ACP_CONTENT_TYPES = {
  TEXT: "text",
  IMAGE: "image",
} as const;

export const COPILOT_ACP_SESSION_EVENT_CAPABILITY =
  "github.com/copilot/sessionEvent";

export const COPILOT_ACP_SESSION_EVENTS = [
  "assistant.turn_start",
  "assistant.idle",
  "session.idle",
] as const;

export const COPILOT_EVENT_TYPES = {
  RESULT: "result",
  SESSION_INFO: "session.info",
  SUBAGENT_STARTED: "subagent.started",
  SUBAGENT_COMPLETED: "subagent.completed",
  SUBAGENT_FAILED: "subagent.failed",
} as const;

export const COPILOT_SESSION_INFO_TYPES = {
  MCP: "mcp",
} as const;

export const COPILOT_USER_MESSAGE_DELIVERIES = {
  IDLE: "idle",
} as const;

export const COPILOT_TOOL_NAMES = {
  APPLY_PATCH: "apply_patch",
  TASK: "task",
} as const;
