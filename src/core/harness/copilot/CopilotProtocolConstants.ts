/** Wire-level values from Copilot CLI's JSONL event protocol. */
export interface CopilotMcpToolIdentity {
  mcpServerName?: string;
  mcpConfigServerName?: string;
  mcpToolName?: string;
}

export const COPILOT_EVENT_TYPES = {
  RESULT: "result",
  SESSION_INFO: "session.info",
} as const;

export const COPILOT_SESSION_INFO_TYPES = {
  MCP: "mcp",
} as const;

export const COPILOT_USER_MESSAGE_DELIVERIES = {
  IDLE: "idle",
} as const;

export const COPILOT_TOOL_NAMES = {
  APPLY_PATCH: "apply_patch",
} as const;
