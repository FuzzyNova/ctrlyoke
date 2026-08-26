/** Wire-level values from Codex's response-item log protocol. */
export const CODEX_EVENT_TYPES = {
  RESPONSE_ITEM: "response_item",
  TEXT: "text",
} as const;

export const CODEX_MESSAGE_ROLES = {
  USER: "user",
  ASSISTANT: "assistant",
} as const;

export const CODEX_CONTENT_BLOCK_TYPES = {
  TOOL_USE: "tool_use",
} as const;
