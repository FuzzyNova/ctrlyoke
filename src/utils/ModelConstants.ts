/**
 * ModelConstants - Single source of truth for model definitions
 *
 * This file defines all supported AI models with their display names.
 * Other files (ModelRegistry.ts, ValidationUtils.ts, FlightPathSettingsProvider.ts)
 * import from here instead of maintaining duplicate lists.
 *
 * package.json enums are synced via: `npm run sync-models`
 *
 * IMPORTANT: There are THREE different model sets:
 * 1. COPILOT_MODELS - All models available via Copilot Chat (superset)
 * 2. COPILOT_CLI_MODEL_IDS - Models supported by `copilot` CLI (subset of above)
 * 3. CLAUDE_CLI_MODELS - Models for Anthropic's `claude` CLI (separate)
 *
 * To add a new model:
 * 1. Add entry to COPILOT_MODELS (display names)
 * 2. If CLI-supported, add to COPILOT_CLI_MODEL_IDS
 * 3. Run `npm run sync-models` to update package.json
 * 4. Commit both files
 *
 * To discover new CLI models:
 * - Run `copilot help config` and look for model options
 */

/**
 * All Copilot-supported models with display names (Chat superset)
 * Key: model ID (used in API calls)
 * Value: human-readable display name (shown in UI)
 *
 * This includes ALL models available via Copilot Chat.
 * Some of these may NOT be available via Copilot CLI.
 */
export const COPILOT_MODELS: Record<string, string> = {
  // Claude models (Anthropic via Copilot)
  "claude-sonnet-4.5": "Claude Sonnet 4.5",
  "claude-haiku-4.5": "Claude Haiku 4.5",
  "claude-opus-4.5": "Claude Opus 4.5",
  "claude-sonnet-4": "Claude Sonnet 4",

  // GPT-5 family (OpenAI)
  "gpt-5": "GPT-5",
  "gpt-5.1": "GPT-5.1",
  "gpt-5.1-codex-mini": "GPT-5.1 Codex Mini",
  "gpt-5.1-codex": "GPT-5.1 Codex",
  "gpt-5-codex": "GPT-5 Codex",
  "gpt-5-mini": "GPT-5 Mini",

  // GPT-4 family (OpenAI)
  "gpt-4.1": "GPT-4.1",
  "gpt-4o": "GPT-4o",
  "gpt-4o-mini": "GPT-4o Mini",
  "gpt-4": "GPT-4",
  "gpt-4-0125-preview": "GPT-4 Turbo",

  // Legacy models
  "gpt-3.5-turbo": "GPT-3.5 Turbo",

  // Gemini models (Google)
  "gemini-3-pro-preview": "Gemini 3 Pro",
  "gemini-2.5-pro": "Gemini 2.5 Pro",

  // Special models (internal IDs differ from public names)
  "oswe-vscode-prime": "Raptor Mini",
  "grok-code-fast-1": "Grok Code Fast",

  // Auto model (let provider decide)
  auto: "Auto",
};

/**
 * Copilot CLI supported models (subset of COPILOT_MODELS)
 *
 * This list comes from `copilot help config` output.
 * Update this when new CLI models become available.
 *
 * Last updated: 2025-11-30
 * Command: copilot help config
 */
export const COPILOT_CLI_MODEL_IDS = [
  "claude-sonnet-4.5",
  "claude-haiku-4.5",
  "claude-opus-4.5",
  "claude-sonnet-4",
  "gpt-5",
  "gpt-5.1",
  "gpt-5.1-codex-mini",
  "gpt-5.1-codex",
  "gpt-5-mini",
  "gpt-4.1",
  "gemini-3-pro-preview",
] as const;

/**
 * Claude Code CLI models (Anthropic's direct CLI)
 *
 * These are simpler aliases used by the `claude` CLI.
 * Unlike Copilot models, these are not discovered dynamically.
 *
 * See: https://github.com/anthropics/claude-code
 */
export const CLAUDE_CLI_MODELS = ["sonnet", "sonnet[1m]", "opus", "haiku"] as const;

/**
 * Claude CLI model display names
 */
export const CLAUDE_CLI_MODEL_LABELS: Record<string, string> = {
  sonnet: "Sonnet (Recommended)",
  "sonnet[1m]": "Sonnet 1M Context (Extended)",
  opus: "Opus (Most Capable)",
  haiku: "Haiku (Fastest)",
};

// Derived exports for convenience

/**
 * All Copilot Chat model IDs as an array (superset)
 * Used for Chat mode enum validation and fallback lists
 */
export const COPILOT_CHAT_MODEL_IDS = Object.keys(COPILOT_MODELS);

/**
 * Get display name for a model ID
 * Falls back to formatted ID if not in map
 */
export function getModelDisplayName(modelId: string): string {
  if (COPILOT_MODELS[modelId]) {
    return COPILOT_MODELS[modelId];
  }

  // Fallback: capitalize and format the ID
  return modelId
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Check if a model ID is a known Copilot model
 */
export function isKnownCopilotModel(modelId: string): boolean {
  return modelId in COPILOT_MODELS;
}

/**
 * Get Claude CLI model name from various input formats
 * Handles aliases like "sonnet", full names like "claude-sonnet-4.5", etc.
 */
export function getClaudeModelName(
  model: string
): (typeof CLAUDE_CLI_MODELS)[number] {
  const normalized = model.toLowerCase();

  // Direct alias match
  if (
    CLAUDE_CLI_MODELS.includes(normalized as (typeof CLAUDE_CLI_MODELS)[number])
  ) {
    return normalized as (typeof CLAUDE_CLI_MODELS)[number];
  }

  // Map Copilot-style names to Claude aliases
  if (normalized.includes("sonnet")) return "sonnet";
  if (normalized.includes("opus")) return "opus";
  if (normalized.includes("haiku")) return "haiku";

  // Default to sonnet
  return "sonnet";
}
