/** Wire-level values from Copilot CLI's JSONL event protocol. */
export interface CopilotMcpToolIdentity {
  mcpServerName?: string;
  mcpConfigServerName?: string;
  mcpToolName?: string;
}

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

export const COPILOT_SUBAGENT_EXECUTION_MODES = {
  SYNC: "sync",
} as const;
