/**
 * ModelRegistry - Dynamic model discovery and caching
 *
 * Queries available models via:
 * 1. `copilot help config` output (for Copilot CLI models) - Parsed dynamically
 *
 * Claude Code CLI models are maintained as a static list because:
 * - Claude CLI has no `claude model list` command (feature request: github.com/anthropics/claude-code/issues/12612)
 * - The `/model` command in interactive mode requires starting a session and consumes tokens
 * - Models are: sonnet (4.5), opus (4/4.5), haiku (4.5) with dated full names
 *
 * Provides runtime access to the model list for:
 * - IntelliSense completions in prompt files
 * - Validation of model selection
 * - CLI harness model switching
 *
 * Falls back to static model lists from ModelConstants when queries fail.
 */

import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import { promises as fsPromises } from "fs";
import {
  COPILOT_CLI_MODEL_IDS,
  OPENCODE_CLI_FALLBACK_MODELS,
  ANTIGRAVITY_CLI_MODELS,
} from "./ModelConstants";
import { Log } from "./Log";
import { retryWithBackoff } from "./RetryUtils";
import { attachStreamTextDecoder } from "./StreamTextDecoder";
import { CLI_VERSION_CHECK_TIMEOUT_MS } from "../core/harness/shared/interfaces/ICliProvider";

const execAsync = promisify(exec);

// Event emitter for model registry changes
const modelsLoadedEmitter = new vscode.EventEmitter<void>();

/**
 * Event that fires when model registry has finished loading
 * Subscribe to this to know when models are available
 */
export const onModelsLoaded = modelsLoadedEmitter.event;

const QWEN_CLI_FALLBACK_MODEL = "qwen3.5-plus";

// In-memory cache of discovered models
let cachedCopilotCliModelIds: string[] = [];
let cachedOpenCodeModelIds: string[] = [];
let cachedQwenModelIds: string[] = [];
let cachedAntigravityModelIds: string[] = [];
/** Context window size (tokens) keyed by fully-qualified OpenCode model ID */
const cachedOpenCodeContextWindows = new Map<string, number>();
/** Display label keyed by Antigravity model ID, sourced live from `agy models` */
const cachedAntigravityModelLabels = new Map<string, string>();
let isInitialized = false;
let initializationPromise: Promise<void> | null = null;

// Fallback model list - imported from ModelConstants (single source of truth)
const FALLBACK_COPILOT_CLI_MODELS = [...COPILOT_CLI_MODEL_IDS];

/**
 * Initialize the model registry by querying available models
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
    await queryCopilotCliModels();
    await queryOpenCodeModels();
    await queryQwenModels();
    await queryAntigravityModels();
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
      "[ModelRegistry] Querying Copilot CLI for available models via 'copilot help config'..."
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
        "[ModelRegistry] Copilot CLI unavailable after retries (file lock), using fallback list"
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
          `[ModelRegistry] Copilot CLI supports ${cachedCopilotCliModelIds.length} models: ${cachedCopilotCliModelIds.join(", ")}`
        );
        return;
      }
    }

    Log.info(
      "[ModelRegistry] Could not parse Copilot CLI models, using fallback list"
    );
    cachedCopilotCliModelIds = [...FALLBACK_COPILOT_CLI_MODELS];
  } catch (error) {
    Log.warn(`[ModelRegistry] Failed to query Copilot CLI models: ${error}`);
    cachedCopilotCliModelIds = [...FALLBACK_COPILOT_CLI_MODELS];
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
    // Check availability before querying models to avoid a noisy error when OpenCode is not installed
    try {
      await execAsync("opencode --version", {
        timeout: CLI_VERSION_CHECK_TIMEOUT_MS,
      });
    } catch {
      Log.debug(
        "[ModelRegistry] OpenCode CLI not available, skipping model query — using fallback list"
      );
      cachedOpenCodeModelIds = [...OPENCODE_CLI_FALLBACK_MODELS];
      return;
    }

    Log.debug(
      "[ModelRegistry] Querying OpenCode for available models via 'opencode models --verbose'..."
    );
    let stdout = "";
    try {
      ({ stdout } = await execAsync("opencode models --verbose", {
        timeout: 10000,
      }));
    } catch (execError) {
      // opencode sometimes exits non-zero (e.g. internal "JSON Parse error") but
      // still writes the full model list to stdout before failing. Recover it.
      stdout =
        (execError as NodeJS.ErrnoException & { stdout?: string }).stdout ?? "";
      if (!stdout.trim()) {
        throw execError;
      }
      Log.debug(
        `[ModelRegistry] opencode models --verbose exited non-zero but stdout has content — attempting parse`
      );
    }
    const ids = parseOpenCodeVerboseOutput(stdout);
    if (ids.length > 0) {
      cachedOpenCodeModelIds = ids;
      Log.debug(
        `[ModelRegistry] OpenCode reports ${ids.length} models, ${cachedOpenCodeContextWindows.size} with context window sizes`
      );
    } else {
      Log.info(
        "[ModelRegistry] opencode models --verbose returned empty list, using fallback"
      );
      cachedOpenCodeModelIds = [...OPENCODE_CLI_FALLBACK_MODELS];
    }
  } catch (error) {
    Log.warn(`[ModelRegistry] Failed to query opencode models: ${error}`);
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
 * Query available models from `~/.qwen/settings.json`.
 *
 * Reads the `modelProviders` section and collects all provider model IDs.
 * Falls back to `["qwen3.5-plus"]` when the file is absent or malformed.
 */
async function queryQwenModels(): Promise<void> {
  const settingsPath = path.join(os.homedir(), ".qwen", "settings.json");
  try {
    const content = await fsPromises.readFile(settingsPath, "utf-8");
    const settings = JSON.parse(content) as {
      modelProviders?: Record<string, Array<{ id?: string }>>;
    };
    const providers = settings?.modelProviders ?? {};
    const ids: string[] = [];
    for (const providerModels of Object.values(providers)) {
      if (Array.isArray(providerModels)) {
        for (const model of providerModels) {
          if (model && typeof model.id === "string" && model.id) {
            ids.push(model.id);
          }
        }
      }
    }
    if (ids.length > 0) {
      cachedQwenModelIds = ids;
      Log.debug(
        `[ModelRegistry] Discovered ${ids.length} Qwen models from ~/.qwen/settings.json: ${ids.join(", ")}`
      );
    } else {
      Log.debug(
        "[ModelRegistry] No models found in ~/.qwen/settings.json, using fallback model"
      );
      cachedQwenModelIds = [QWEN_CLI_FALLBACK_MODEL];
    }
  } catch {
    Log.debug(
      "[ModelRegistry] Could not read ~/.qwen/settings.json, using fallback Qwen model"
    );
    cachedQwenModelIds = [QWEN_CLI_FALLBACK_MODEL];
  }
}

/**
 * Run a command with stdin explicitly closed (`stdio: ["ignore", "pipe", "pipe"]`).
 *
 * `agy models` hangs indefinitely under `child_process.exec`/`execFile` on Windows:
 * those leave the child's stdin open as an unwritten, unclosed pipe, and the `models`
 * subcommand specifically blocks on it before printing anything (`agy --version` is
 * unaffected, confirming it's a stdin-read quirk of that one subcommand, not a general
 * agy startup issue). Explicitly closing stdin up front avoids the hang.
 */
function execWithClosedStdin(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          `Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`
        )
      );
    }, timeoutMs);

    const flushStdout = child.stdout
      ? attachStreamTextDecoder(child.stdout, (chunk) => {
          stdout += chunk;
        })
      : () => "";
    const flushStderr = child.stderr
      ? attachStreamTextDecoder(child.stderr, (chunk) => {
          stderr += chunk;
        })
      : () => "";
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      stdout += flushStdout();
      stderr += flushStderr();
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            `Command failed (exit ${code}): ${stderr.trim() || stdout.trim()}`
          )
        );
      }
    });
  });
}

/**
 * Query available models from `agy models`.
 *
 * Output is tab-separated `<id>\t<label>` lines on stdout (the "Fetching
 * available models..." progress text goes to stderr, not stdout). Populates
 * both `cachedAntigravityModelIds` and `cachedAntigravityModelLabels`.
 */
async function queryAntigravityModels(): Promise<void> {
  try {
    // Check availability before querying models to avoid a noisy error when Antigravity is not installed
    try {
      await execAsync("agy --version", {
        timeout: CLI_VERSION_CHECK_TIMEOUT_MS,
      });
    } catch {
      Log.debug(
        "[ModelRegistry] Antigravity CLI not available, skipping model query — using fallback list"
      );
      cachedAntigravityModelIds = [...ANTIGRAVITY_CLI_MODELS];
      return;
    }

    Log.debug(
      "[ModelRegistry] Querying Antigravity for available models via 'agy models'..."
    );
    const stdout = await execWithClosedStdin("agy", ["models"], 10000);
    const ids = parseAntigravityModelsOutput(stdout);

    if (ids.length > 0) {
      cachedAntigravityModelIds = ids;
      Log.debug(
        `[ModelRegistry] Antigravity reports ${ids.length} models: ${ids.join(", ")}`
      );
    } else {
      Log.info(
        "[ModelRegistry] 'agy models' returned no models, using fallback list"
      );
      cachedAntigravityModelIds = [...ANTIGRAVITY_CLI_MODELS];
    }
  } catch (error) {
    Log.warn(`[ModelRegistry] Failed to query Antigravity models: ${error}`);
    cachedAntigravityModelIds = [...ANTIGRAVITY_CLI_MODELS];
  }
}

/**
 * Parse `agy models` stdout into a list of model IDs.
 * As a side effect, populates `cachedAntigravityModelLabels` with id -> label.
 *
 * Output format: one model per line, `<id>\t<label>` (e.g.
 * "gemini-3.6-flash-low\tGemini 3.6 Flash (Low)").
 */
function parseAntigravityModelsOutput(stdout: string): string[] {
  const modelIds: string[] = [];

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const [id, label] = trimmed.split("\t");
    if (!id) {
      continue;
    }

    modelIds.push(id);
    if (label) {
      cachedAntigravityModelLabels.set(id, label);
    }
  }

  return modelIds;
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
 * Check if a model is supported by Copilot CLI
 *
 * @param modelId The model ID to check
 * @returns true if model is supported by CLI
 */
export function isCliModelSupported(modelId: string): boolean {
  return cachedCopilotCliModelIds.includes(modelId);
}

/**
 * Get OpenCode model IDs synchronously (from cache, populated at startup)
 */
export function getOpenCodeModelIdsSync(): string[] {
  return cachedOpenCodeModelIds;
}

/**
 * Get Qwen model IDs synchronously (from cache, populated at startup via ~/.qwen/settings.json)
 */
export function getQwenModelIdsSync(): string[] {
  return cachedQwenModelIds;
}

/**
 * Get Antigravity model IDs synchronously (from cache, populated at startup via 'agy models')
 */
export function getAntigravityModelIdsSync(): string[] {
  return cachedAntigravityModelIds;
}

/**
 * Get the live display label for an Antigravity model ID, as reported by
 * 'agy models'. Falls back to the static `ANTIGRAVITY_CLI_MODEL_LABELS` map
 * (via the caller) when the live query hasn't populated this ID.
 */
export function getAntigravityModelLabelSync(
  modelId: string
): string | undefined {
  return cachedAntigravityModelLabels.get(modelId);
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
 * Get the registry initialization status
 */
export function isRegistryInitialized(): boolean {
  return isInitialized;
}
