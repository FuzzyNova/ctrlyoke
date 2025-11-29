/**
 * Model Constants for FlightPath - Claude Code CLI Support
 *
 * DYNAMIC MODELS: Copilot models are queried at runtime via:
 * - vscode.lm.selectChatModels({ vendor: "copilot" }) for Chat models
 * - 'copilot --help' output for CLI-supported models
 *
 * See ModelRegistry.ts for runtime model access.
 *
 * This file contains ONLY Claude Code CLI constants, which require
 * model name mapping between generic names and Claude's specific format.
 */

// ============================================================
// CLAUDE CODE CLI MODEL SUPPORT
// ============================================================

/**
 * Claude Code CLI model aliases (user-friendly short names)
 * These map to full model names for Claude CLI execution
 */
export const CLAUDE_CLI_MODEL_ALIASES = ["sonnet", "opus", "haiku"] as const;

/**
 * Default model for Claude Code CLI
 * Uses alias format for user-friendliness
 */
export const CLAUDE_CLI_DEFAULT_MODEL = "sonnet" as const;

/**
 * Comprehensive map of model names to Claude CLI full names
 *
 * Accepts:
 * - Aliases: "sonnet", "opus", "haiku"
 * - Generic Copilot-style names: "claude-sonnet-4.5", "claude-sonnet-4", "claude-haiku-4.5"
 * - Full Claude names: "claude-sonnet-4-5-20250929" (pass-through)
 *
 * Note: Full names may change with new model versions. Check Claude CLI docs for latest.
 */
export const CLAUDE_CLI_MODEL_MAP: Record<string, string> = {
  // Short aliases (recommended for stability)
  sonnet: "claude-sonnet-4-5-20250929",
  opus: "claude-opus-4-20250514",
  haiku: "claude-haiku-4-5-20251001",

  // Generic Copilot-style names (for cross-provider compatibility)
  "claude-sonnet-4.5": "claude-sonnet-4-5-20250929",
  "claude-sonnet-4": "claude-sonnet-4-20250514",
  "claude-haiku-4.5": "claude-haiku-4-5-20251001",
  "claude-opus-4": "claude-opus-4-20250514",

  // Full names (pass-through for explicit specification)
  "claude-sonnet-4-5-20250929": "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-20250514": "claude-sonnet-4-20250514",
  "claude-opus-4-20250514": "claude-opus-4-20250514",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001",
};

/**
 * Get the Claude CLI model name for a given model identifier
 * Accepts aliases, generic names, or full names
 *
 * @param modelId The model identifier (alias, generic name, or full name)
 * @returns The full Claude CLI model name, or undefined if not recognized
 */
export function getClaudeModelName(modelId: string): string | undefined {
  return CLAUDE_CLI_MODEL_MAP[modelId];
}

/**
 * Check if a model identifier is valid for Claude CLI
 *
 * @param modelId The model identifier to check
 * @returns true if the model is valid for Claude CLI
 */
export function isValidClaudeModel(modelId: string): boolean {
  return modelId in CLAUDE_CLI_MODEL_MAP;
}

// Type exports for Claude CLI
export type ClaudeCliModelAlias = (typeof CLAUDE_CLI_MODEL_ALIASES)[number];
