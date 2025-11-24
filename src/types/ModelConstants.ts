/**
 * Single source of truth for Copilot model support
 *
 * IMPORTANT: When updating model lists, also update:
 * - schemas/prompt-schema.json (model field enum - must be kept in sync manually)
 *
 * See docs/AGENT_CHAT_COMMANDS.md for latest model availability
 */

// Models supported by Copilot CLI (limited set verified working)
export const CLI_SUPPORTED_MODELS = [
  "claude-sonnet-4.5",
  "claude-sonnet-4",
  "claude-haiku-4.5",
  "gpt-5",
] as const;

// All models supported by Copilot Chat window (superset)
// Source: docs/AGENT_CHAT_COMMANDS.md (verified Nov 23, 2025)
export const CHAT_SUPPORTED_MODELS = [
  "claude-sonnet-4.5",
  "claude-sonnet-4",
  "claude-haiku-4.5",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5-codex",
  "gpt-4.1",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4",
  "gpt-4-0125-preview",
  "gpt-3.5-turbo",
  "gemini-2.5-pro",
  "gemini-3-pro-preview",
  "grok-code-fast-1",
  "copilot-fast",
  "oswe-vscode-secondary",
  "auto",
] as const;

// All supported models (Chat is superset of CLI)
export const ALL_SUPPORTED_MODELS = CHAT_SUPPORTED_MODELS;

// Type exports for TypeScript validation
export type CliSupportedModel = (typeof CLI_SUPPORTED_MODELS)[number];
export type ChatSupportedModel = (typeof CHAT_SUPPORTED_MODELS)[number];
export type SupportedModel = (typeof ALL_SUPPORTED_MODELS)[number];
