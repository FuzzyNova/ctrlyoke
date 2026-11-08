/**
 * ModelConstants - Single source of truth for model definitions
 *
 * This file defines all supported AI models with their display names.
 * Other files (ModelRegistry.ts, CtrlYokeWebviewProvider.ts)
 * import from here instead of maintaining duplicate lists.
 *
 * package.json enums are synced via: `npm run sync-models`
 *
 * Every harness's list here is the offline fallback and the source of the
 * schema's `model` examples. At runtime ModelRegistry asks each installed CLI
 * for its own list and the dashboard shows that instead.
 *
 * To refresh the Copilot, Claude, Codex and Antigravity lists from the CLIs
 * installed on this machine:
 * 1. Run `npm run sync-models:discover` (rewrites the arrays and labels below)
 * 2. Run `npm run sync-models` to update package.json and the schema
 * 3. Commit the results
 */

/**
 * Copilot CLI supported models.
 *
 * This list comes from `copilot help config` output and is rewritten wholesale
 * by `npm run sync-models:discover` (git history records when). That
 * output can lag what Copilot actually accepts — `--model gpt-6-luna` worked
 * on 2026-09-23 while `copilot help config` (CLI 1.0.88) did not list it — so a
 * missing ID here does not by itself mean Copilot cannot run it.
 */
export const COPILOT_CLI_MODEL_IDS = [
  "claude-sonnet-5.5",
  "claude-sonnet-5",
  "claude-fable-5.1",
  "claude-fable-5",
  "claude-opus-5.5",
  "claude-opus-5",
  "claude-opus-4.8",
  "claude-opus-4.8-fast",
  "claude-sonnet-4.6",
  "claude-haiku-5.5",
  "claude-haiku-4.5",
  "gpt-6.1-sol",
  "gpt-6.1-terra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.3-codex",
  "mai-code-1.1-flash",
  "gemini-4-argon",
  "gemini-3.8-flash",
  "grok-4.7",
  "grok-4.6",
  "kimi-k3",
] as const;

/**
 * Copilot CLI model display names.
 *
 * Auto-derived from COPILOT_CLI_MODEL_IDS by `npm run sync-models` — see
 * `updateCopilotDerivedConstants()` in scripts/sync-models.mjs. Hand-editing
 * is safe but will be overwritten on the next sync if it drifts from the
 * generated title-case form.
 */
export const COPILOT_CLI_MODEL_LABELS: Record<string, string> = {
  "claude-sonnet-5.5": "Claude Sonnet 5.5",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-fable-5.1": "Claude Fable 5.1",
  "claude-fable-5": "Claude Fable 5",
  "claude-opus-5.5": "Claude Opus 5.5",
  "claude-opus-5": "Claude Opus 5",
  "claude-opus-4.8": "Claude Opus 4.8",
  "claude-opus-4.8-fast": "Claude Opus 4.8 Fast",
  "claude-sonnet-4.6": "Claude Sonnet 4.6",
  "claude-haiku-5.5": "Claude Haiku 5.5",
  "claude-haiku-4.5": "Claude Haiku 4.5",
  "gpt-6.1-sol": "GPT 6.1 Sol",
  "gpt-6.1-terra": "GPT 6.1 Terra",
  "gpt-6-sol": "GPT 6 Sol",
  "gpt-6-luna": "GPT 6 Luna",
  "gpt-6-astra": "GPT 6 Astra",
  "gpt-5.6-sol": "GPT 5.6 Sol",
  "gpt-5.6-terra": "GPT 5.6 Terra",
  "gpt-5.6-luna": "GPT 5.6 Luna",
  "gpt-5.3-codex": "GPT 5.3 Codex",
  "mai-code-1.1-flash": "Mai Code 1.1 Flash",
  "gemini-4-argon": "Gemini 4 Argon",
  "gemini-3.8-flash": "Gemini 3.8 Flash",
  "grok-4.7": "Grok 4.7",
  "grok-4.6": "Grok 4.6",
  "kimi-k3": "Kimi K3",
};

/**
 * Claude Code CLI model aliases, in Claude's `/model` picker order.
 *
 * Each alias floats to the newest model of its family. Rewritten by
 * `npm run sync-models:discover` from the `initialize` reply of Claude's
 * stream-json control protocol (`ClaudeModelCatalogClient`), keeping only the
 * aliases: the pinned versions in that reply (`claude-opus-4-6`, …) depend
 * on the account, so they appear in the dashboard from live discovery only.
 *
 * The old `sonnet[1m]`/`opus[1m]` aliases are gone because Sonnet and Opus
 * now always run with a 1M context. Claude Code still accepts them.
 */
export const CLAUDE_CLI_MODELS = ["opus", "fable", "sonnet", "haiku"] as const;

/**
 * Claude CLI model display names, verbatim from Claude's `displayName`.
 * Written by `--discover` alongside CLAUDE_CLI_MODELS.
 */
export const CLAUDE_CLI_MODEL_LABELS: Record<string, string> = {
  opus: "Opus 5.5",
  fable: "Fable 5.1",
  sonnet: "Sonnet 5.5",
  haiku: "Haiku 5.5",
};

/**
 * Codex CLI models, in Codex's own picker order.
 *
 * Rewritten by `npm run sync-models:discover` from the app-server's
 * `model/list` (`CodexAppServerClient.listModels`), keeping the models Codex
 * shows by default. Models Codex marks hidden appear in the dashboard from
 * live discovery only, hidden until the user unhides them.
 */
export const CODEX_CLI_MODELS = [
  "gpt-6.1-sol",
  "gpt-6-astra",
  "gpt-6.1-terra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;

/**
 * Codex CLI model display names, verbatim from Codex's `displayName`.
 * Written by `--discover` alongside CODEX_CLI_MODELS.
 */
export const CODEX_CLI_MODEL_LABELS: Record<string, string> = {
  "gpt-6.1-sol": "GPT-6.1-Sol",
  "gpt-6-astra": "GPT-6-Astra",
  "gpt-6.1-terra": "GPT-6.1 Terra",
  "gpt-6-sol": "GPT-6-Sol",
  "gpt-6-luna": "GPT-6-Luna",
  "gpt-5.6-sol": "GPT-5.6-Sol",
  "gpt-5.6-terra": "GPT-5.6-Terra",
  "gpt-5.6-luna": "GPT-5.6-Luna",
};

/**
 * Sentinel value to suppress the --model flag entirely.
 * When a user selects "none", ctrlyoke skips the --model argument so the
 * harness uses its own default or the user can pass a custom model via additionalArgs.
 * Useful for harnesses that require a custom model string (e.g., hosted Bedrock).
 */
export const MODEL_NONE = "none";

/**
 * Get display name for a model ID
 * Falls back to formatted ID if not in map
 */
export function getModelDisplayName(modelId: string): string {
  if (COPILOT_CLI_MODEL_LABELS[modelId]) {
    return COPILOT_CLI_MODEL_LABELS[modelId];
  }

  // Fallback: capitalize and format the ID
  return modelId
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Check if a model ID is a known Copilot CLI model
 */
export function isKnownCopilotModel(modelId: string): boolean {
  return (COPILOT_CLI_MODEL_IDS as readonly string[]).includes(modelId);
}

/**
 * Default/fallback context window size (in tokens) for the Codex CLI.
 * GPT 5.6 variants override below; every other model uses this default.
 */
export const CODEX_CLI_CONTEXT_WINDOW_SIZE = 400_000;

const CODEX_CLI_CONTEXT_WINDOW_SIZES: Record<string, number> = {
  "gpt-5.6-sol": 1_050_000,
  "gpt-5.6-terra": 1_050_000,
  "gpt-5.6-luna": 1_050_000,
};

export function getCodexContextWindowSize(modelId: string | undefined): number {
  if (modelId && modelId in CODEX_CLI_CONTEXT_WINDOW_SIZES) {
    return CODEX_CLI_CONTEXT_WINDOW_SIZES[modelId];
  }
  return CODEX_CLI_CONTEXT_WINDOW_SIZE;
}

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
 * A pinned Claude model ID in Anthropic's dashed form, e.g. `claude-opus-4-6`
 * or `claude-haiku-4-5-20251001`, optionally with the legacy `[1m]` suffix.
 * Copilot's dotted IDs (`claude-sonnet-4.6`) are not.
 */
const PINNED_CLAUDE_MODEL_ID_PATTERN = /^claude-[a-z]+(?:-\d+)+(?:\[1m\])?$/;

/** Whether a Claude model value is a pinned model ID rather than an alias. */
export function isPinnedClaudeModelId(model: string): boolean {
  return PINNED_CLAUDE_MODEL_ID_PATTERN.test(model);
}

/**
 * Get the value to pass to `claude --model` for a given model identifier.
 * Aliases (fable, sonnet, opus, haiku) and pinned model IDs
 * (`claude-opus-4-6`) pass through unchanged.
 *
 * @param model The model identifier (alias, pinned ID, or Copilot-style name like "claude-sonnet-4.5")
 * @returns The Claude CLI model value, or undefined if not recognized
 */
export function getClaudeModelName(model: string): string | undefined {
  // Direct match for aliases
  if (CLAUDE_CLI_MODELS.includes(model as ClaudeCliModelAlias)) {
    return model;
  }

  // Try lowercase normalization
  const normalized = model.toLowerCase();
  if (CLAUDE_CLI_MODELS.includes(normalized as ClaudeCliModelAlias)) {
    return normalized;
  }

  if (isPinnedClaudeModelId(normalized)) {
    return normalized;
  }

  // Map Copilot-style names and legacy aliases (`sonnet[1m]`) to aliases
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
// ANTIGRAVITY CLI MODELS
// ============================================================================
/**
 * Antigravity CLI model IDs, exactly as printed by `agy models`.
 *
 * `agy --model` accepts either these IDs or the display labels below, but we
 * store IDs to match every other harness in this file (id -> label). The
 * effort tier is baked into the ID suffix (`-low` / `-medium` / `-high`)
 * rather than passed via agy's separate `--effort` flag.
 *
 * An unrecognized value is rejected by agy with exit 1 and a list of valid
 * models — it never silently falls back to the default.
 *
 * Last verified against `agy models` + `agy --model <id>` validation: 2026-08-21.
 * Command: npm run sync-models:discover
 */
export const ANTIGRAVITY_CLI_MODELS = [
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-low",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
] as const;

/**
 * Display labels, verbatim from agy's own "Available models" output.
 *
 * Note `claude-sonnet-4-6` carries a "(Thinking)" label despite having no
 * `-thinking` ID suffix — that asymmetry is agy's, not ours.
 */
export const ANTIGRAVITY_CLI_MODEL_LABELS: Record<string, string> = {
  "gemini-3.8-flash-high": "Gemini 3.8 Flash (High)",
  "gemini-3.8-flash-medium": "Gemini 3.8 Flash (Medium)",
  "gemini-3.8-flash-low": "Gemini 3.8 Flash (Low)",
  "claude-sonnet-4-6": "Claude Sonnet 4.6 (Thinking)",
  "claude-opus-4-6-thinking": "Claude Opus 4.6 (Thinking)",
  "gpt-oss-120b-medium": "GPT-OSS 120B (Medium)",
};

const MODEL_LABEL_HARNESS_IDS = {
  CLAUDE_CLI: "claude-cli",
  CODEX_CLI: "codex-cli",
  ANTIGRAVITY_CLI: "antigravity-cli",
  QWEN_CLI: "qwen-cli",
} as const;

export function getAntigravityModelName(model: string): string | undefined {
  if (ANTIGRAVITY_CLI_MODELS.includes(model as any)) {
    return model;
  }
  return model || undefined;
}

/**
 * Get the context window size for an Antigravity CLI model.
 *
 * Matches on provider family substrings, which hold for both the model IDs
 * above (`claude-…`, `gpt-oss-…`) and agy's display labels, so a value from
 * either vocabulary resolves correctly. Falls back to the Gemini-sized window
 * used by the default Antigravity models.
 */
export function getAntigravityContextWindowSize(
  modelId: string | undefined
): number {
  const normalized = (modelId ?? "").toLowerCase();
  if (normalized.includes("claude")) {
    return 200_000;
  }
  if (normalized.includes("gpt-oss")) {
    return 128_000;
  }
  return 1_000_000;
}

export type AntigravityCliModel = (typeof ANTIGRAVITY_CLI_MODELS)[number];

/**
 * Returns a human-readable display name for a model, resolved against the
 * correct label map for the given harness.
 */
export function getHarnessModelDisplayName(
  harnessId: string,
  modelId: string
): string {
  switch (harnessId) {
    case MODEL_LABEL_HARNESS_IDS.CLAUDE_CLI:
      return CLAUDE_CLI_MODEL_LABELS[modelId] ?? modelId;
    case MODEL_LABEL_HARNESS_IDS.CODEX_CLI:
      return CODEX_CLI_MODEL_LABELS[modelId] ?? modelId;
    case MODEL_LABEL_HARNESS_IDS.ANTIGRAVITY_CLI:
      return ANTIGRAVITY_CLI_MODEL_LABELS[modelId] ?? modelId;
    case MODEL_LABEL_HARNESS_IDS.QWEN_CLI:
      return QWEN_CLI_MODEL_LABELS[modelId] ?? modelId;
    default:
      return COPILOT_CLI_MODEL_LABELS[modelId] ?? modelId;
  }
}
