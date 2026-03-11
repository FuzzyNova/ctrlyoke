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
 * - CLI/Chat harness model switching
 *
 * Falls back to static model lists from ModelConstants when queries fail.
 */

import * as vscode from "vscode";
import { exec } from "child_process";
import { promisify } from "util";
import {
  COPILOT_CHAT_MODEL_IDS,
  COPILOT_CLI_MODEL_IDS,
  CLAUDE_CLI_MODELS,
  OPENCODE_CLI_FALLBACK_MODELS,
} from "./ModelConstants";
import { Log } from "./Log";
import { retryWithBackoff } from "./RetryUtils";

const execAsync = promisify(exec);

// Event emitter for model registry changes
const modelsLoadedEmitter = new vscode.EventEmitter<void>();

/**
 * Event that fires when model registry has finished loading
 * Subscribe to this to know when models are available
 */
export const onModelsLoaded = modelsLoadedEmitter.event;

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
let cachedOpenCodeModelIds: string[] = [];
/** Context window size (tokens) keyed by fully-qualified OpenCode model ID */
const cachedOpenCodeContextWindows = new Map<string, number>();
let isInitialized = false;
let initializationPromise: Promise<void> | null = null;

// Fallback model lists - imported from ModelConstants (single source of truth)
const FALLBACK_CHAT_MODELS = COPILOT_CHAT_MODEL_IDS;
const FALLBACK_COPILOT_CLI_MODELS = [...COPILOT_CLI_MODEL_IDS];

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
    await queryOpenCodeModels();
    isInitialized = true;
    // Notify subscribers that models are now available
    modelsLoadedEmitter.fire();
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
    Log.debug(
      "Querying Copilot CLI for available models via 'copilot help config'..."
    );

    const result = await retryWithBackoff(
      async () => {
        try {
          return await execAsync("copilot help config", { timeout: 5000 });
        } catch (error) {
          // On Windows, copilot.ps1 can be temporarily locked by a concurrent process.
          // Retry transient file-lock errors; let other errors fall through.
          const msg = String(error);
          if (msg.includes("being used by another process")) {
            return null; // trigger retry
          }
          throw error; // permanent failure - stop retrying
        }
      },
      { maxAttempts: 4, delays: [200, 500, 1000] }
    );

    if (!result) {
      Log.info(
        "Copilot CLI unavailable after retries (file lock), using fallback list"
      );
      cachedCopilotCliModelIds = [...FALLBACK_COPILOT_CLI_MODELS];
      return;
    }

    const { stdout } = result;

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
        Log.debug(
          `Copilot CLI supports ${cachedCopilotCliModelIds.length} models: ${cachedCopilotCliModelIds.join(", ")}`
        );
        return;
      }
    }

    Log.info("Could not parse Copilot CLI models, using fallback list");
    cachedCopilotCliModelIds = [...FALLBACK_COPILOT_CLI_MODELS];
  } catch (error) {
    Log.warn(`Failed to query Copilot CLI models: ${error}`);
    cachedCopilotCliModelIds = [...FALLBACK_COPILOT_CLI_MODELS];
  }
}

/**
 * Query available models from VS Code Language Model API
 */
async function queryChatModels(): Promise<void> {
  try {
    Log.debug("Querying VS Code LM API for available models...");

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

      Log.debug(
        `Discovered ${cachedModels.length} chat models: ${cachedModels.map((m) => m.id).join(", ")}`
      );
    } else {
      Log.info("No models returned from LM API, using fallback list");
      useFallbackModels();
    }
  } catch (error) {
    Log.warn(`Failed to query LM API models, using fallback: ${error}`);
    useFallbackModels();
  }
}

/**
 * Query available models from `opencode models --verbose`.
 *
 * The verbose output alternates between a model-ID line (e.g. "opencode/big-pickle")
 * and a multi-line JSON block containing `limit.context` (context window size in tokens).
 * Populates both `cachedOpenCodeModelIds` and `cachedOpenCodeContextWindows`.
 */
async function queryOpenCodeModels(): Promise<void> {
  try {
    Log.debug(
      "Querying OpenCode for available models via 'opencode models --verbose'..."
    );
    const { stdout } = await execAsync("opencode models --verbose", {
      timeout: 10000,
    });
    const ids = parseOpenCodeVerboseOutput(stdout);
    if (ids.length > 0) {
      cachedOpenCodeModelIds = ids;
      Log.debug(
        `OpenCode reports ${ids.length} models, ${cachedOpenCodeContextWindows.size} with context window sizes`
      );
    } else {
      Log.info("opencode models --verbose returned empty list, using fallback");
      cachedOpenCodeModelIds = [...OPENCODE_CLI_FALLBACK_MODELS];
    }
  } catch (error) {
    Log.warn(`Failed to query opencode models: ${error}`);
    cachedOpenCodeModelIds = [...OPENCODE_CLI_FALLBACK_MODELS];
  }
}

/**
 * Parse `opencode models --verbose` stdout into a list of model IDs.
 * As a side effect, populates `cachedOpenCodeContextWindows` with context window sizes.
 *
 * Output format: alternating model-ID lines (e.g. "opencode/big-pickle") and
 * multi-line JSON blocks containing `limit.context`.
 */
function parseOpenCodeVerboseOutput(stdout: string): string[] {
  const modelIds: string[] = [];
  const lines = stdout.split("\n");
  let currentModelId: string | undefined;
  let jsonBuffer = "";
  let braceDepth = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (braceDepth === 0) {
      if (trimmed.startsWith("{")) {
        jsonBuffer = line + "\n";
        braceDepth +=
          (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
      } else {
        currentModelId = trimmed;
        modelIds.push(currentModelId);
        jsonBuffer = "";
      }
    } else {
      jsonBuffer += line + "\n";
      braceDepth +=
        (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;

      if (braceDepth <= 0) {
        braceDepth = 0;
        if (currentModelId && jsonBuffer.trim()) {
          try {
            const parsed = JSON.parse(jsonBuffer.trim()) as {
              limit?: { context?: number };
            };
            const contextSize = parsed?.limit?.context;
            if (typeof contextSize === "number") {
              cachedOpenCodeContextWindows.set(currentModelId, contextSize);
            }
          } catch {
            // Skip malformed JSON block
          }
        }
        jsonBuffer = "";
      }
    }
  }

  return modelIds;
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
 * Get Copilot CLI-supported model IDs synchronously (from cache, populated at startup)
 *
 * @returns Array of CLI-supported model IDs
 */
export function getCliSupportedModelIdsSync(): string[] {
  return cachedCopilotCliModelIds;
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
 * Get OpenCode model IDs synchronously (from cache, populated at startup)
 */
export function getOpenCodeModelIdsSync(): string[] {
  return cachedOpenCodeModelIds;
}

/**
 * Get the context window size (in tokens) for a fully-qualified OpenCode model ID.
 * Populated at startup by `queryOpenCodeModels` via `opencode models --verbose`.
 *
 * @param modelId Fully-qualified model ID (e.g. "anthropic/claude-sonnet-4-6")
 * @returns Context window size in tokens, or undefined if not discovered
 */
export function getOpenCodeContextWindowSize(
  modelId: string
): number | undefined {
  return cachedOpenCodeContextWindows.get(modelId);
}

/**
 * Refresh the model cache (force re-query)
 * Call this if you expect model availability to have changed
 */
export async function refreshModelRegistry(): Promise<void> {
  isInitialized = false;
  cachedModels = [];
  cachedCopilotCliModelIds = [];
  cachedOpenCodeModelIds = [];
  cachedOpenCodeContextWindows.clear();
  await initializeModelRegistry();
}

/**
 * Get the registry initialization status
 */
export function isRegistryInitialized(): boolean {
  return isInitialized;
}
