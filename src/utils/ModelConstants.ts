/**
 * ModelConstants - Single source of truth for model definitions
 *
 * This file defines all supported AI models with their display names.
 * Other files (ModelRegistry.ts, ValidationUtils.ts, CtrlYokeWebviewProvider.ts)
 * import from here instead of maintaining duplicate lists.
 *
 * package.json enums are synced via: `npm run sync-models`
 *
 * IMPORTANT: There are FOUR different model sets:
 * 1. COPILOT_MODELS - All models available via Copilot Chat (superset)
 * 2. COPILOT_CLI_MODEL_IDS - Models supported by `copilot` CLI (subset of above)
 * 3. CLAUDE_CLI_MODELS - Models for Anthropic's `claude` CLI (separate)
 * 4. CODEX_CLI_MODELS - Models for OpenAI's `codex` CLI (separate)
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
  "claude-sonnet-4.6": "Claude Sonnet 4.6",
  "gemini-3.1-pro-preview": "Gemini 3.1 Pro Preview",
  "gemini-3.5-flash": "Gemini 3.5 Flash",
  "gpt-5.3-codex": "GPT 5.3 Codex",
  "gpt-5.4-mini": "GPT 5.4 Mini",
  "gpt-5.4": "GPT 5.4",
  "mai-code-1-flash-picker": "Mai Code 1 Flash Picker",
  "gpt-5-mini": "GPT-5 Mini",
  "gpt-4o-mini": "GPT-4o Mini",
  "claude-sonnet-4.5": "Claude Sonnet 4.5",
  "claude-haiku-4.5": "Claude Haiku 4.5",
  "gemini-3-flash-preview": "Gemini 3 Flash Preview",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "oswe-vscode-prime": "Raptor Mini",
  auto: "Auto",
  "copilot-utility-small": "Copilot Utility Small",
  "copilot-utility": "Copilot Utility",
};

/**
 * Copilot CLI supported models (subset of COPILOT_MODELS)
 *
 * This list comes from `copilot help config` output.
 * Update this when new CLI models become available.
 *
 * Last updated: 2026-07-01
 * Command: npm run sync-models -- --discover
 */
export const COPILOT_CLI_MODEL_IDS = [
  "claude-sonnet-5",
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",
  "claude-haiku-4.5",
  "claude-fable-5",
  "claude-opus-4.8",
  "claude-opus-4.8-fast",
  "claude-opus-4.7",
  "claude-opus-4.6",
  "claude-opus-4.5",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.4-mini",
  "gpt-5-mini",
  "gemini-3.1-pro-preview",
  "gemini-3.5-flash",
] as const;

/**
 * Claude Code CLI models (Anthropic's direct CLI)
 *
 * These are simpler aliases used by the `claude` CLI.
 * Unlike Copilot models, these are not discovered dynamically.
 *
 * See: https://github.com/anthropics/claude-code
 */
export const CLAUDE_CLI_MODELS = [
  "fable",
  "sonnet",
  "sonnet[1m]",
  "opus",
  "opus[1m]",
  "haiku",
] as const;

/**
 * Claude CLI model display names
 */
export const CLAUDE_CLI_MODEL_LABELS: Record<string, string> = {
  fable: "Fable",
  sonnet: "Sonnet",
  "sonnet[1m]": "Sonnet 1M Context",
  opus: "Opus",
  "opus[1m]": "Opus 1M Context",
  haiku: "Haiku",
};

/**
 * Codex CLI models (OpenAI's code-specialized CLI)
 *
 * These are the primary models supported by the `codex` CLI.
 * List sourced from `codex /model` command output.
 *
 * See: https://docs.openai.com/codex
 */
export const CODEX_CLI_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"] as const;

/**
 * Codex CLI model display names
 */
export const CODEX_CLI_MODEL_LABELS: Record<string, string> = {
  "gpt-5.5": "GPT 5.5",
  "gpt-5.4": "GPT 5.4",
  "gpt-5.4-mini": "GPT 5.4 Mini",
};

/**
 * Sentinel value to suppress the --model flag entirely.
 * When a user selects "none", ctrlyoke skips the --model argument so the
 * harness uses its own default or the user can pass a custom model via additionalArgs.
 * Useful for harnesses that require a custom model string (e.g., hosted Bedrock).
 */
export const MODEL_NONE = "none";

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
 * Context window sizes (in tokens) per Copilot CLI model ID.
 * Falls back to 128k for unknown/unlisted models via getCopilotContextWindowSize().
 */
const COPILOT_CLI_CONTEXT_WINDOW_SIZES: Record<string, number> = {
  // Claude models — sonnet now defaults to a 1M token window; only the
  // sonnet-4.x line and haiku remain on the older 200k window.
  "claude-haiku-4.5": 200_000,
  "claude-sonnet-4": 144_000,
  "claude-sonnet-4.5": 200_000,
  "claude-sonnet-4.6": 200_000,
  "claude-sonnet-5": 1_000_000,
  "claude-opus-4.5": 200_000,
  "claude-opus-4.6": 200_000,
  "claude-opus-4.7": 200_000,
  "claude-opus-4.8": 200_000,
  "claude-opus-4.8-fast": 200_000,
  // Gemini models
  "gemini-2.5-pro": 173_000,
  "gemini-3-flash-preview": 173_000,
  "gemini-3.1-pro-preview": 173_000,
  "gemini-3.5-flash": 173_000,
  // GPT models
  "gpt-4.1": 128_000,
  "gpt-4o": 68_000,
  "gpt-5-mini": 192_000,
  "gpt-5.2": 192_000,
  "gpt-5.2-codex": 400_000,
  "gpt-5.3-codex": 400_000,
  "gpt-5.4": 400_000,
  "gpt-5.4-mini": 400_000,
  // Grok models
  "grok-code-fast-1": 173_000,
  // Raptor mini (oswe-vscode-prime)
  "oswe-vscode-prime": 264_000,
};

/**
 * Get the context window size for a Copilot CLI model.
 * Returns the model-specific size if known, or 128k as the fallback.
 */
export function getCopilotContextWindowSize(
  modelId: string | undefined
): number {
  if (modelId && modelId in COPILOT_CLI_CONTEXT_WINDOW_SIZES) {
    return COPILOT_CLI_CONTEXT_WINDOW_SIZES[modelId];
  }
  return 128_000;
}

/**
 * Context window size (in tokens) for the Codex CLI.
 * Current Codex CLI models (gpt-5.4, gpt-5.4-mini, gpt-5.5) use a 400k token context window.
 */
export const CODEX_CLI_CONTEXT_WINDOW_SIZE = 400_000;

// ============================================================================
// OPENCODE CLI FALLBACK MODELS
// Fallback only — runtime list comes from `opencode models`
// Do NOT add a full static list here — models are user-specific
// ============================================================================
export const OPENCODE_CLI_FALLBACK_MODELS = [
  "opencode/big-pickle",
  "opencode/claude-haiku-4-5",
  "opencode/claude-sonnet-4-6",
] as const;

// ============================================================================
// QWEN CLI MODELS
// Fallback only — runtime list comes from ~/.qwen/settings.json modelProviders
// ============================================================================
export const QWEN_CLI_MODELS = ["qwen3.5-plus"] as const;

/**
 * Qwen CLI model display names (fallback — runtime list is from settings.json)
 */
const QWEN_CLI_MODEL_LABELS: Record<string, string> = {
  "qwen3.5-plus": "Qwen 3.5 Plus",
} as const;

/**
 * Get the Qwen CLI model name (identity function for now)
 *
 * @param model The model identifier
 * @returns The Qwen CLI model name, or undefined if not recognized
 */
export function getQwenModelName(model: string): string | undefined {
  if (QWEN_CLI_MODELS.includes(model as any)) {
    return model;
  }
  // Accept any model string - Qwen CLI will validate
  return model || undefined;
}

/**
 * Get the context window size for a Claude CLI model.
 *
 * Fable, Opus, the "[1m]" extended-context variant, and bare "sonnet" (which
 * now resolves to Sonnet 5) get a 1M token window. Haiku and the older
 * sonnet-4.x line (sonnet-4, sonnet-4.5, sonnet-4.6) remain on the 200k
 * window.
 *
 * @param modelId The model alias or full model ID (e.g. "sonnet", "claude-opus-4-6")
 * @returns Context window size in tokens
 */
export function getClaudeContextWindowSize(modelId: string): number {
  if (
    modelId.includes("[1m]") ||
    modelId.includes("1m") ||
    modelId.includes("opus") ||
    modelId.includes("fable")
  ) {
    return 1_000_000;
  }
  if (modelId.includes("sonnet") && !/sonnet[-_]?4\b/.test(modelId)) {
    return 1_000_000;
  }
  return 200_000;
}

/**
 * Check if a model identifier is valid for Claude CLI
 *
 * @param modelId The model identifier to check
 * @returns true if the model is valid for Claude CLI
 */
export function isValidClaudeModel(modelId: string): boolean {
  return CLAUDE_CLI_MODELS.includes(modelId as ClaudeCliModelAlias);
}

/**
 * Get the Claude CLI model alias for a given model identifier
 * Claude CLI accepts short aliases directly (fable, sonnet, opus, haiku)
 *
 * @param model The model identifier (alias or Copilot-style name like "claude-sonnet-4.5")
 * @returns The Claude CLI alias, or undefined if not recognized
 */
export function getClaudeModelName(
  model: string
): ClaudeCliModelAlias | undefined {
  // Direct match for aliases
  if (CLAUDE_CLI_MODELS.includes(model as ClaudeCliModelAlias)) {
    return model as ClaudeCliModelAlias;
  }

  // Try lowercase normalization
  const normalized = model.toLowerCase();
  if (CLAUDE_CLI_MODELS.includes(normalized as ClaudeCliModelAlias)) {
    return normalized as ClaudeCliModelAlias;
  }

  // Map Copilot-style names to aliases
  if (normalized.includes("fable")) return "fable";
  if (normalized.includes("sonnet")) return "sonnet";
  if (normalized.includes("opus")) return "opus";
  if (normalized.includes("haiku")) return "haiku";

  // Not recognized
  return undefined;
}

// Type exports for Claude CLI
export type ClaudeCliModelAlias = (typeof CLAUDE_CLI_MODELS)[number];

// Type exports for Codex CLI
export type CodexCliModel = (typeof CODEX_CLI_MODELS)[number];

// Type exports for Qwen CLI
export type QwenCliModel = (typeof QWEN_CLI_MODELS)[number];

/**
 * Get the context window size for a Qwen CLI model.
 *
 * @param modelId The model identifier (e.g. "coder-model")
 * @returns Context window size in tokens
 */
export function getQwenContextWindowSize(_modelId: string): number {
  return 1_000_000;
}

// ============================================================================
// GEMINI CLI MODELS
// Gemini CLI supported models
// ============================================================================
export const GEMINI_CLI_MODELS = [
  "gemini-3-pro-preview",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite-preview",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
] as const;

/**
 * Gemini CLI model display names
 */
export const GEMINI_CLI_MODEL_LABELS: Record<string, string> = {
  "gemini-3-pro-preview": "Gemini 3 Pro (Preview)",
  "gemini-3-flash-preview": "Gemini 3 Flash (Preview)",
  "gemini-3.1-flash-lite-preview": "Gemini 3.1 Flash Lite (Preview)",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "gemini-2.5-flash-lite": "Gemini 2.5 Flash Lite",
} as const;

/**
 * Get the Gemini CLI model name (identity function for now)
 *
 * @param model The model identifier
 * @returns The Gemini CLI model name, or undefined if not recognized
 */
export function getGeminiModelName(model: string): string | undefined {
  if (GEMINI_CLI_MODELS.includes(model as any)) {
    return model;
  }
  // Accept any model string - Gemini CLI will validate
  return model || undefined;
}

// Type exports for Gemini CLI
export type GeminiCliModel = (typeof GEMINI_CLI_MODELS)[number];

/**
 * Get the context window size for a Gemini CLI model.
 *
 * @param modelId The model identifier (e.g. "gemini-2.5-pro")
 * @returns Context window size in tokens
 */
export function getGeminiContextWindowSize(_modelId: string): number {
  return 1_000_000;
}

/**
 * Returns a human-readable display name for a model, resolved against the
 * correct label map for the given harness.
 */
export function getHarnessModelDisplayName(
  harnessId: string,
  modelId: string
): string {
  switch (harnessId) {
    case "claude-cli":
      return CLAUDE_CLI_MODEL_LABELS[modelId] ?? modelId;
    case "codex-cli":
      return CODEX_CLI_MODEL_LABELS[modelId] ?? modelId;
    case "gemini-cli":
      return GEMINI_CLI_MODEL_LABELS[modelId] ?? modelId;
    case "qwen-cli":
      return QWEN_CLI_MODEL_LABELS[modelId] ?? modelId;
    default:
      return COPILOT_MODELS[modelId] ?? modelId;
  }
}

