/**
 * ModelRegistry - Dynamic model discovery and caching
 *
 * Queries available models via:
 * 1. VS Code's Language Model API (for Chat models) - User-specific availability
 * 2. `copilot help config` output (for Copilot CLI models) - Parsed dynamically
 *
 * Claude Code CLI models are maintained as a static list because:
 * - Claude CLI has no `claude model list` command (feature request: github.com/anthropics/claude-code/issues/12612)
 * - The `/model` command in interactive mode requires starting a session and consumes tokens
 * - Models are: sonnet (4.5), opus (4/4.5), haiku (4.5) with dated full names
 *
 * Provides runtime access to the model list for:
 * - IntelliSense completions in prompt files
 * - Validation of model selection
 * - CLI/Chat provider model switching
 *
 * Falls back to static model lists when queries fail.
 */

import * as vscode from "vscode";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * Represents a discovered Copilot model
 */
export interface CopilotModel {
  /** Model ID (e.g., "claude-sonnet-4.5", "gpt-4o") */
  id: string;
  /** Model family (e.g., "claude-sonnet-4.5", "gpt-4o") */
  family: string;
  /** Model vendor (typically "copilot") */
  vendor: string;
  /** Whether this model is available for Copilot CLI use */
  cliSupported: boolean;
}

// In-memory cache of discovered models
let cachedModels: CopilotModel[] = [];
let cachedCopilotCliModelIds: string[] = [];
let isInitialized = false;
let initializationPromise: Promise<void> | null = null;

/**
 * Claude Code CLI supported models (static list)
 *
 * Claude CLI has no programmatic way to list models - the `/model` command
 * only works in interactive mode and uses tokens. This is a known limitation.
 * See: https://github.com/anthropics/claude-code/issues/12612
 *
 * Users can specify these via:
 * - Aliases: "sonnet", "opus", "haiku"
 * - Generic names: "claude-sonnet-4.5", "claude-opus-4"
 * - Full names: "claude-sonnet-4-5-20250929"
 *
 * The mapping is handled by ModelConstants.getClaudeModelName()
 */
export const CLAUDE_CLI_MODELS = [
  "sonnet",
  "opus",
  "haiku",
  "claude-sonnet-4.5",
  "claude-sonnet-4",
  "claude-opus-4",
  "claude-opus-4.5",
  "claude-haiku-4.5",
] as const;

// Fallback model lists (used when queries fail)
const FALLBACK_CHAT_MODELS = [
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
  "gpt-4o",
  "gemini-3-pro-preview",
  "gemini-2.5-pro",
];

const FALLBACK_COPILOT_CLI_MODELS = [
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
];

/**
 * Initialize the model registry by querying available models
 * Queries both VS Code LM API and Copilot CLI for model availability
 * Safe to call multiple times - only queries once
 *
 * @returns Promise that resolves when models are loaded
 */
export async function initializeModelRegistry(): Promise<void> {
  // Return existing promise if already initializing
  if (initializationPromise) {
    return initializationPromise;
  }

  // Already initialized
  if (isInitialized) {
    return;
  }

  initializationPromise = (async () => {
    // Query Copilot CLI first, then Chat models (so we can set cliSupported correctly)
    await queryCopilotCliModels();
    await queryChatModels();
    isInitialized = true;
  })();

  await initializationPromise;
  initializationPromise = null;
}

/**
 * Query Copilot CLI-supported models by parsing 'copilot help config' output
 *
 * Uses `copilot help config` instead of `copilot --help` because:
 * - More structured output with clear model section
 * - Easier to parse (each model on its own line with " - " prefix)
 *
 * Example output:
 *   `model`: AI model to use for Copilot CLI
 *     - "claude-sonnet-4.5"
 *     - "claude-sonnet-4"
 *     - "claude-haiku-4.5"
 *     - "gpt-5"
 */
async function queryCopilotCliModels(): Promise<void> {
  try {
    console.log(
      "FlightPath: Querying Copilot CLI for available models via 'copilot help config'..."
    );

    const { stdout } = await execAsync("copilot help config", {
      timeout: 5000,
    });

    // Parse the `model` section to extract choices
    // Format: `model`: AI model...followed by lines like:   - "model-name"
    const modelSectionMatch = stdout.match(
      /`model`[^`]+?((?:\s+-\s+"[^"]+"\r?\n)+)/i
    );

    if (modelSectionMatch) {
      // Extract quoted model names from the matched section
      const models = modelSectionMatch[1].match(/"([^"]+)"/g);

      if (models && models.length > 0) {
        cachedCopilotCliModelIds = models.map((m) => m.replace(/"/g, ""));
        console.log(
          `FlightPath: Copilot CLI supports ${cachedCopilotCliModelIds.length} models: ${cachedCopilotCliModelIds.join(", ")}`
        );
        return;
      }
    }

    console.log(
      "FlightPath: Could not parse Copilot CLI models, using fallback list"
    );
    cachedCopilotCliModelIds = [...FALLBACK_COPILOT_CLI_MODELS];
  } catch (error) {
    console.warn(`FlightPath: Failed to query Copilot CLI models: ${error}`);
    cachedCopilotCliModelIds = [...FALLBACK_COPILOT_CLI_MODELS];
  }
}

/**
 * Query available models from VS Code Language Model API
 */
async function queryChatModels(): Promise<void> {
  try {
    console.log("FlightPath: Querying VS Code LM API for available models...");

    const models = await vscode.lm.selectChatModels({
      vendor: "copilot",
    });

    if (models && models.length > 0) {
      cachedModels = models.map((model) => ({
        id: model.id,
        family: model.family,
        vendor: model.vendor,
        cliSupported: cachedCopilotCliModelIds.includes(model.id),
      }));

      console.log(
        `FlightPath: Discovered ${cachedModels.length} chat models: ${cachedModels.map((m) => m.id).join(", ")}`
      );
    } else {
      console.log(
        "FlightPath: No models returned from LM API, using fallback list"
      );
      useFallbackModels();
    }
  } catch (error) {
    console.warn(
      `FlightPath: Failed to query LM API models, using fallback: ${error}`
    );
    useFallbackModels();
  }
}

/**
 * Populate cache with static fallback models
 */
function useFallbackModels(): void {
  cachedModels = FALLBACK_CHAT_MODELS.map((id) => ({
    id,
    family: id,
    vendor: "copilot",
    cliSupported: cachedCopilotCliModelIds.includes(id),
  }));
}

/**
 * Get all available models
 * Returns cached models if available, otherwise queries API
 *
 * @returns Array of available Copilot models
 */
export async function getAvailableModels(): Promise<CopilotModel[]> {
  if (!isInitialized) {
    await initializeModelRegistry();
  }
  return cachedModels;
}

/**
 * Get available models synchronously (from cache)
 * Returns empty array if not yet initialized
 * Use getAvailableModels() for guaranteed results
 *
 * @returns Array of cached models, or empty if not initialized
 */
export function getAvailableModelsSync(): CopilotModel[] {
  return cachedModels;
}

/**
 * Get model IDs as a simple string array
 * Useful for validation and completion providers
 *
 * @returns Array of model ID strings
 */
export async function getModelIds(): Promise<string[]> {
  const models = await getAvailableModels();
  return models.map((m) => m.id);
}

/**
 * Get model IDs synchronously (from cache)
 *
 * @returns Array of model ID strings from cache
 */
export function getModelIdsSync(): string[] {
  return cachedModels.map((m) => m.id);
}

/**
 * Get Copilot CLI-supported model IDs
 * Returns models that work with Copilot CLI
 *
 * @returns Array of CLI-supported model IDs
 */
export function getCliSupportedModelIds(): string[] {
  return cachedCopilotCliModelIds;
}

/**
 * Get CLI-supported model IDs synchronously
 * Alias for getCliSupportedModelIds
 */
export function getCliSupportedModelIdsSync(): string[] {
  return cachedCopilotCliModelIds;
}

/**
 * Get only CLI-supported models (with full model info)
 *
 * @returns Array of models supported by Copilot CLI
 */
export async function getCliSupportedModels(): Promise<CopilotModel[]> {
  const models = await getAvailableModels();
  return models.filter((m) => m.cliSupported);
}

/**
 * Check if a model is available for Chat
 *
 * @param modelId The model ID to check
 * @returns true if model is available for chat
 */
export function isModelAvailable(modelId: string): boolean {
  return cachedModels.some((m) => m.id === modelId);
}

/**
 * Check if a model is supported by Copilot CLI
 *
 * @param modelId The model ID to check
 * @returns true if model is supported by CLI
 */
export function isCliModelSupported(modelId: string): boolean {
  return cachedCopilotCliModelIds.includes(modelId);
}

/**
 * Check if a model identifier is valid for Claude CLI
 * This includes aliases, generic names, and full names
 *
 * @param modelId The model ID to check
 * @returns true if model can be used with Claude CLI
 */
export function isClaudeCliModel(modelId: string): boolean {
  return CLAUDE_CLI_MODELS.includes(
    modelId as (typeof CLAUDE_CLI_MODELS)[number]
  );
}

/**
 * Refresh the model cache (force re-query)
 * Call this if you expect model availability to have changed
 */
export async function refreshModelRegistry(): Promise<void> {
  isInitialized = false;
  cachedModels = [];
  cachedCopilotCliModelIds = [];
  await initializeModelRegistry();
}

/**
 * Get the registry initialization status
 */
export function isRegistryInitialized(): boolean {
  return isInitialized;
}
