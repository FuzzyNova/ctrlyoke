/**
 * ModelRegistry - Dynamic model discovery and caching
 *
 * Queries available models from each installed harness:
 * - Copilot: `copilot help config`
 * - Claude Code: the `initialize` reply of its stream-json control protocol
 *   (`ClaudeModelCatalogClient`); no turn, no tokens
 * - Codex: the app-server's `model/list`, hidden models included
 *   (`CodexAppServerClient.listModels`)
 * - OpenCode: `opencode models --verbose` / its `model.list` API
 * - Qwen: `~/.qwen/settings.json` `modelProviders`
 * - Antigravity: `agy models`
 *
 * Provides runtime access to the model list for:
 * - IntelliSense completions in prompt files
 * - Validation of model selection
 * - CLI harness model switching
 *
 * Falls back to static model lists from ModelConstants when queries fail.
 */

import * as os from "os";
import * as path from "path";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import { promises as fsPromises } from "fs";
import {
  COPILOT_CLI_MODEL_IDS,
  OPENCODE_CLI_FALLBACK_MODELS,
  ANTIGRAVITY_CLI_MODELS,
  CLAUDE_CLI_MODELS,
  CLAUDE_CLI_MODEL_LABELS,
  CODEX_CLI_MODELS,
  CODEX_CLI_MODEL_LABELS,
} from "./ModelConstants";
import type { CapabilitiesModel } from "../types/CapabilitiesTypes";
import { CodexAppServerClient } from "../core/harness/codex/CodexAppServerClient";
import { ClaudeModelCatalogClient } from "../core/harness/claude/ClaudeModelCatalogClient";
import { Log } from "./Log";
import { getQwenHomeDir } from "./HarnessHome";
import { TypedEmitter } from "./TypedEmitter";
import { retryWithBackoff, stopRetrying } from "./RetryUtils";
import { attachStreamTextDecoder } from "./StreamTextDecoder";
import { CLI_VERSION_CHECK_TIMEOUT_MS } from "../core/harness/shared/interfaces/ICliProvider";
import { isSubprocessTimeoutError } from "./SubprocessUtils";
import {
  isOpenCodeV2Version,
  OPENCODE_MODELS_COMMANDS,
  OPENCODE_VERSION_COMMAND,
} from "../core/harness/opencode/OpenCodeProtocolConstants";

const execAsync = promisify(exec);

/**
 * Every discovery command runs from the home directory. Inheriting the process
 * cwd made the result depend on how the host was launched: the VS Code
 * extension host's cwd is the editor's install directory, never the open
 * folder, so no workspace ever informed discovery anyway.
 */
const DISCOVERY_CWD = os.homedir();
const MODEL_DISCOVERY_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

function execDiscoveryCommand(
  command: string,
  timeout: number
): Promise<{ stdout: string; stderr: string }> {
  return execAsync(command, {
    timeout,
    cwd: DISCOVERY_CWD,
    maxBuffer: MODEL_DISCOVERY_MAX_BUFFER_BYTES,
  });
}

// Event emitter for model registry changes
const modelsLoadedEmitter = new TypedEmitter<void>();

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
let copilotDiscoveryTimedOut = false;
let copilotTimeoutRetryCount = 0;
let copilotRetryTimer: NodeJS.Timeout | null = null;
export const COPILOT_TIMEOUT_RETRY_DELAY_MS = 30_000;
const COPILOT_TIMEOUT_RETRY_LIMIT = 2;

// Fallback model list - imported from ModelConstants (single source of truth)
const FALLBACK_COPILOT_CLI_MODELS = [...COPILOT_CLI_MODEL_IDS];

function staticModelOptions(
  ids: readonly string[],
  labels: Record<string, string>
): CapabilitiesModel[] {
  return ids.map((value) => ({ value, label: labels[value] ?? value }));
}

const FALLBACK_CLAUDE_CLI_MODELS = staticModelOptions(
  CLAUDE_CLI_MODELS,
  CLAUDE_CLI_MODEL_LABELS
);
const FALLBACK_CODEX_CLI_MODELS = staticModelOptions(
  CODEX_CLI_MODELS,
  CODEX_CLI_MODEL_LABELS
);

// Seeded with the static lists so callers before (or without) discovery,
// such as the standalone CLI, still get a usable list.
let cachedClaudeModels: CapabilitiesModel[] = FALLBACK_CLAUDE_CLI_MODELS;
let cachedCodexModels: CapabilitiesModel[] = FALLBACK_CODEX_CLI_MODELS;

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
  if (isInitialized && !copilotDiscoveryTimedOut) {
    return;
  }

  copilotDiscoveryTimedOut = false;
  initializationPromise = (async () => {
    await queryCopilotCliModels();
    await queryClaudeModels();
    await queryCodexModels();
    await queryOpenCodeModels();
    await queryQwenModels();
    await queryAntigravityModels();
    // The fallback list is usable for validation while a bounded background
    // retry gives a cold CLI another chance to answer.
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
          return await execDiscoveryCommand(
            "copilot help config",
            CLI_VERSION_CHECK_TIMEOUT_MS
          );
        } catch (error) {
          // On Windows, copilot.ps1 can be temporarily locked by a concurrent process.
          // Retry transient file-lock errors; let other errors fall through.
          const msg = String(error);
          if (msg.includes("being used by another process")) {
            return null; // trigger retry
          }
          stopRetrying(error);
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
    if (isCliTimeoutError(error)) {
      copilotDiscoveryTimedOut = true;
      scheduleCopilotTimeoutRetry();
    }
    Log.warn(`[ModelRegistry] Failed to query Copilot CLI models: ${error}`);
    cachedCopilotCliModelIds = [...FALLBACK_COPILOT_CLI_MODELS];
  }
}

/**
 * Query Claude Code for the models the signed-in account can use: its
 * aliases plus whichever pinned versions it offers. Keeps the static alias
 * list when Claude Code is missing or does not answer.
 */
async function queryClaudeModels(): Promise<void> {
  try {
    Log.debug(
      "[ModelRegistry] Querying Claude Code for available models via its initialize control request..."
    );
    cachedClaudeModels = await new ClaudeModelCatalogClient().listModels();
    Log.debug(
      `[ModelRegistry] Claude Code reports ${cachedClaudeModels.length} models: ${cachedClaudeModels.map((m) => m.value).join(", ")}`
    );
  } catch (error) {
    Log.debug(
      `[ModelRegistry] Claude Code model discovery unavailable (${String(error)}), using fallback list`
    );
    cachedClaudeModels = FALLBACK_CLAUDE_CLI_MODELS;
  }
}

/**
 * Query Codex's app-server `model/list`, hidden models included. Keeps the
 * static list when Codex is missing, signed out, or does not answer.
 */
async function queryCodexModels(): Promise<void> {
  try {
    Log.debug(
      "[ModelRegistry] Querying Codex for available models via app-server model/list..."
    );
    const models = await new CodexAppServerClient().listModels();
    if (models.length === 0) {
      throw new Error("model/list returned no models");
    }
    cachedCodexModels = models;
    Log.debug(
      `[ModelRegistry] Codex reports ${models.length} models: ${models.map((m) => (m.hidden ? `${m.value} (hidden)` : m.value)).join(", ")}`
    );
  } catch (error) {
    Log.debug(
      `[ModelRegistry] Codex model discovery unavailable (${String(error)}), using fallback list`
    );
    cachedCodexModels = FALLBACK_CODEX_CLI_MODELS;
  }
}

/**
 * Query available models from OpenCode.
 *
 * OpenCode 1 is queried with `opencode models --verbose`, whose output
 * alternates between a model-ID line (e.g. "opencode/big-pickle") and a
 * multi-line JSON block containing `limit.context` (context window size in
 * tokens). OpenCode 2 has no `--verbose` (it prints its help text instead), so
 * it is asked through its public `model.list` API operation, which is what its
 * own `opencode models` command lists and also carries `limit.context`.
 * Populates both `cachedOpenCodeModelIds` and `cachedOpenCodeContextWindows`.
 */
async function queryOpenCodeModels(): Promise<void> {
  try {
    // Check availability before querying models to avoid a noisy error when OpenCode is not installed
    let versionOutput: string;
    try {
      ({ stdout: versionOutput } = await execDiscoveryCommand(
        OPENCODE_VERSION_COMMAND,
        CLI_VERSION_CHECK_TIMEOUT_MS
      ));
    } catch {
      Log.debug(
        "[ModelRegistry] OpenCode CLI not available, skipping model query — using fallback list"
      );
      cachedOpenCodeModelIds = [...OPENCODE_CLI_FALLBACK_MODELS];
      return;
    }

    const isV2 = isOpenCodeV2Version(versionOutput.trim());
    const modelsCommand = isV2
      ? OPENCODE_MODELS_COMMANDS.V2
      : OPENCODE_MODELS_COMMANDS.V1;
    Log.debug(
      `[ModelRegistry] Querying OpenCode for available models via '${modelsCommand}'...`
    );
    let stdout = "";
    try {
      ({ stdout } = await execDiscoveryCommand(
        modelsCommand,
        CLI_VERSION_CHECK_TIMEOUT_MS
      ));
    } catch (execError) {
      // opencode sometimes exits non-zero (e.g. internal "JSON Parse error") but
      // still writes the full model list to stdout before failing. Recover it.
      if (!isRecoverableNonZeroExit(execError)) {
        if (isCliTimeoutError(execError) || isMaxBufferError(execError)) {
          Log.warn(
            `[ModelRegistry] OpenCode model discovery output was ${isCliTimeoutError(execError) ? "timed out" : "truncated"}; discarding partial output`
          );
        }
        throw execError;
      }
      stdout =
        (execError as NodeJS.ErrnoException & { stdout?: string }).stdout ?? "";
      if (!stdout.trim()) {
        throw execError;
      }
      Log.debug(
        `[ModelRegistry] ${modelsCommand} exited non-zero but stdout has content — attempting parse`
      );
    }
    const ids = isV2
      ? parseOpenCodeModelListResponse(stdout)
      : parseOpenCodeModelsOutput(stdout);
    if (ids.length > 0) {
      cachedOpenCodeModelIds = ids;
      Log.debug(
        `[ModelRegistry] OpenCode reports ${ids.length} models, ${cachedOpenCodeContextWindows.size} with context window sizes`
      );
    } else {
      Log.info(
        `[ModelRegistry] ${modelsCommand} returned no model IDs, using fallback`
      );
      cachedOpenCodeModelIds = [...OPENCODE_CLI_FALLBACK_MODELS];
    }
  } catch (error) {
    Log.warn(`[ModelRegistry] Failed to query opencode models: ${error}`);
    cachedOpenCodeModelIds = [...OPENCODE_CLI_FALLBACK_MODELS];
  }
}

function isCliTimeoutError(error: unknown): boolean {
  return isSubprocessTimeoutError(error);
}

function scheduleCopilotTimeoutRetry(): void {
  if (
    copilotRetryTimer ||
    copilotTimeoutRetryCount >= COPILOT_TIMEOUT_RETRY_LIMIT
  ) {
    return;
  }
  copilotTimeoutRetryCount++;
  copilotRetryTimer = setTimeout(() => {
    copilotRetryTimer = null;
    void initializeModelRegistry().catch((error: unknown) => {
      Log.warn(
        `[ModelRegistry] Background model retry failed: ${String(error)}`
      );
    });
  }, COPILOT_TIMEOUT_RETRY_DELAY_MS);
  copilotRetryTimer.unref();
}

function isMaxBufferError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as NodeJS.ErrnoException).code ===
      "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
  );
}

function isRecoverableNonZeroExit(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const execError = error as NodeJS.ErrnoException & {
    killed?: boolean;
  };
  return (
    typeof execError.code === "number" &&
    execError.killed !== true &&
    !isMaxBufferError(execError)
  );
}

/**
 * Parse OpenCode 2's `model.list` API response (`{ data: Model[] }`) into
 * fully-qualified `providerID/id` model IDs, sorted the way `opencode models`
 * prints them. As a side effect, populates `cachedOpenCodeContextWindows` from
 * each model's `limit.context`. Anything that is not that shape (an HTTP error
 * printed by `opencode api`, for instance) yields no IDs.
 */
function parseOpenCodeModelListResponse(stdout: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const data = (parsed as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    return [];
  }
  const modelIds: string[] = [];
  for (const entry of data as Array<{
    id?: unknown;
    providerID?: unknown;
    limit?: { context?: unknown };
  }>) {
    if (typeof entry?.id !== "string" || typeof entry.providerID !== "string") {
      continue;
    }
    const modelId = `${entry.providerID}/${entry.id}`;
    if (!OPENCODE_MODEL_ID_PATTERN.test(modelId)) {
      continue;
    }
    modelIds.push(modelId);
    const contextSize = entry.limit?.context;
    if (typeof contextSize === "number" && contextSize > 0) {
      cachedOpenCodeContextWindows.set(modelId, contextSize);
    }
  }
  return modelIds.sort((a, b) => a.localeCompare(b));
}

/**
 * OpenCode model IDs are always `provider/model` with no whitespace. Anything
 * else on a non-JSON line (help text, warnings) is not a model.
 */
const OPENCODE_MODEL_ID_PATTERN = /^[^\s/]+\/\S+$/;

/**
 * Parse `opencode models` stdout into a list of model IDs.
 * As a side effect, populates `cachedOpenCodeContextWindows` with context window sizes.
 *
 * Output format: one model-ID line per model (e.g. "opencode/big-pickle"),
 * each followed on OpenCode 1's `--verbose` by a multi-line JSON block
 * containing `limit.context`.
 */
function parseOpenCodeModelsOutput(stdout: string): string[] {
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
      } else if (OPENCODE_MODEL_ID_PATTERN.test(trimmed)) {
        currentModelId = trimmed;
        modelIds.push(currentModelId);
        jsonBuffer = "";
      } else {
        currentModelId = undefined;
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
 * Query available models from Qwen's user `settings.json` (`~/.qwen`, or
 * `QWEN_HOME`).
 *
 * Reads the `modelProviders` section and collects all provider model IDs.
 * Falls back to `["qwen3.5-plus"]` when the file is absent or malformed.
 */
async function queryQwenModels(): Promise<void> {
  const settingsPath = path.join(getQwenHomeDir(), "settings.json");
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
        `[ModelRegistry] Discovered ${ids.length} Qwen models from ${settingsPath}: ${ids.join(", ")}`
      );
    } else {
      Log.debug(
        `[ModelRegistry] No models found in ${settingsPath}, using fallback model`
      );
      cachedQwenModelIds = [QWEN_CLI_FALLBACK_MODEL];
    }
  } catch {
    Log.debug(
      `[ModelRegistry] Could not read ${settingsPath}, using fallback Qwen model`
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
    const child = spawn(command, args, {
      cwd: DISCOVERY_CWD,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
      await execDiscoveryCommand("agy --version", CLI_VERSION_CHECK_TIMEOUT_MS);
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
 * Claude Code models from the cache: discovered at startup, or the static
 * alias list until (or unless) discovery succeeds.
 */
export function getClaudeModelsSync(): readonly CapabilitiesModel[] {
  return cachedClaudeModels;
}

/**
 * Codex models from the cache, hidden ones flagged: discovered at startup,
 * or the static list until (or unless) discovery succeeds.
 */
export function getCodexModelsSync(): readonly CapabilitiesModel[] {
  return cachedCodexModels;
}

/** Whether Claude Code reported (or the static list holds) this model value. */
export function isKnownClaudeModel(modelId: string): boolean {
  return cachedClaudeModels.some((model) => model.value === modelId);
}

/** Whether Codex reported (or the static list holds) this model, hidden or not. */
export function isKnownCodexModel(modelId: string): boolean {
  return cachedCodexModels.some((model) => model.value === modelId);
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
