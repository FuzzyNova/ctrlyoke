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

// ============================================================
// CLAUDE CODE CLI MODEL SUPPORT
// ============================================================

/**
 * Claude Code CLI model aliases (user-friendly short names)
 * These map to full model names for Claude CLI execution
 */
export const CLAUDE_CLI_MODEL_ALIASES = ["sonnet", "opus", "haiku"] as const;

/**
 * Claude Code CLI full model names (official naming convention)
 * Used for validation and CLI command execution
 */
export const CLAUDE_CLI_MODELS = [
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-20250514",
  "claude-haiku-4-20250514",
] as const;

/**
 * Default model for Claude Code CLI
 * Uses alias format for user-friendliness
 */
export const CLAUDE_CLI_DEFAULT_MODEL = "sonnet" as const;

/**
 * Map of aliases to full model names for Claude CLI
 * Note: Use aliases (sonnet, opus, haiku) in production - full names may change
 */
export const CLAUDE_CLI_MODEL_MAP: Record<string, string> = {
  sonnet: "claude-sonnet-4-5-20250929",
  opus: "claude-opus-4-20250514",
  haiku: "claude-haiku-4-5-20251001",
};

// Type exports for Claude CLI
export type ClaudeCliModelAlias = (typeof CLAUDE_CLI_MODEL_ALIASES)[number];
export type ClaudeCliModel = (typeof CLAUDE_CLI_MODELS)[number];

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
