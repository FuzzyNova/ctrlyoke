import type { CapabilitiesModel } from "../../../types/CapabilitiesTypes";
import { isPinnedClaudeModelId } from "../../../utils/ModelConstants";
import { resolveCliCommand } from "../shared/CliLauncherResolver";
import {
  defaultStdioProbeSpawn,
  runStdioProbe,
  StdioProbeTimeoutError,
  type StdioProbeSpawn,
} from "../shared/StdioProbe";

export const CLAUDE_MODEL_CATALOG_TIMEOUT_MS = 10_000;

/** The pseudo-entry Claude puts first; ctrlyoke's own "None" covers it. */
const CLAUDE_DEFAULT_MODEL_VALUE = "default";

const CLAUDE_INITIALIZE_REQUEST_ID = "ctrlyoke-models";

/** Stream-json control protocol vocabulary used by the initialize exchange. */
const CLAUDE_CONTROL = {
  REQUEST_TYPE: "control_request",
  RESPONSE_TYPE: "control_response",
  INITIALIZE_SUBTYPE: "initialize",
  ERROR_SUBTYPE: "error",
} as const;
/**
 * Claude Code has no `models` command, but the stream-json control protocol
 * the Agent SDK speaks answers an `initialize` request with the same model
 * list the `/model` picker shows for the signed-in account. Sending no user
 * message means no turn, no tokens, and nothing to persist.
 */
const CLAUDE_STREAM_JSON_ARGS = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--no-session-persistence",
  "--strict-mcp-config",
];

/**
 * Skips the user's hooks, plugins and MCP servers while keeping auth and
 * model settings. Newer than ctrlyoke's minimum Claude Code, so an older CLI
 * that rejects it is asked again without it.
 */
const CLAUDE_SAFE_MODE_ARG = "--safe-mode";

export interface ClaudeModelCatalogClientOptions {
  spawnProcess?: StdioProbeSpawn;
  resolveCommand?: typeof resolveCliCommand;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize the `models` array of Claude's `initialize` control response.
 * Each entry's `value` is what `claude --model` takes: an alias (`opus`,
 * which floats to the newest Opus) or a pinned model ID
 * (`claude-opus-4-6`, flagged `hidden`); `displayName` is Claude's own
 * label. The `default` pseudo-entry is dropped.
 */
export function normalizeClaudeModelList(models: unknown): CapabilitiesModel[] {
  if (!Array.isArray(models)) return [];
  const result: CapabilitiesModel[] = [];
  for (const entry of models) {
    if (!isRecord(entry) || typeof entry.value !== "string") continue;
    const value = entry.value;
    if (!value || value === CLAUDE_DEFAULT_MODEL_VALUE) continue;
    const label =
      typeof entry.displayName === "string" && entry.displayName
        ? entry.displayName
        : value;
    // Claude's own picker shows only the aliases and keeps pinned versions
    // behind "More models", so they start hidden here too.
    result.push(
      isPinnedClaudeModelId(value)
        ? { value, label, hidden: true }
        : { value, label }
    );
  }
  return result;
}

/**
 * Pull the model list out of a stream-json line if it is the reply to our
 * `initialize` request. Returns `undefined` for every other line and throws
 * when Claude reports the request failed.
 */
export function selectClaudeInitializeModels(
  message: unknown
): CapabilitiesModel[] | undefined {
  if (!isRecord(message) || message.type !== CLAUDE_CONTROL.RESPONSE_TYPE) {
    return undefined;
  }
  const response = isRecord(message.response) ? message.response : undefined;
  if (
    response?.request_id !== undefined &&
    response.request_id !== CLAUDE_INITIALIZE_REQUEST_ID
  ) {
    return undefined;
  }
  if (response?.subtype === CLAUDE_CONTROL.ERROR_SUBTYPE) {
    throw new Error("Claude Code rejected the initialize request");
  }
  const payload = isRecord(response?.response) ? response.response : response;
  return normalizeClaudeModelList(payload?.models);
}

/**
 * Short-lived, read-only client that asks Claude Code which models the
 * signed-in account can use. The rest of the `initialize` reply (account
 * details, commands, agents) is discarded.
 */
export class ClaudeModelCatalogClient {
  private readonly spawnProcess: StdioProbeSpawn;
  private readonly resolveCommand: typeof resolveCliCommand;
  private readonly timeoutMs: number;

  constructor(options: ClaudeModelCatalogClientOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? defaultStdioProbeSpawn;
    this.resolveCommand = options.resolveCommand ?? resolveCliCommand;
    this.timeoutMs = options.timeoutMs ?? CLAUDE_MODEL_CATALOG_TIMEOUT_MS;
  }

  /**
   * Rejects when Claude Code is missing, times out or answers without a
   * model list; callers fall back to a static list.
   */
  async listModels(signal?: AbortSignal): Promise<CapabilitiesModel[]> {
    try {
      return await this.query(
        [...CLAUDE_STREAM_JSON_ARGS, CLAUDE_SAFE_MODE_ARG],
        signal
      );
    } catch (error) {
      if (signal?.aborted || error instanceof StdioProbeTimeoutError) {
        throw error;
      }
      // Most likely a Claude Code too old to know --safe-mode.
      return this.query(CLAUDE_STREAM_JSON_ARGS, signal);
    }
  }

  private async query(
    args: string[],
    signal: AbortSignal | undefined
  ): Promise<CapabilitiesModel[]> {
    const models = await runStdioProbe(
      {
        label: "Claude Code",
        commandName: "claude",
        args,
        timeoutMs: this.timeoutMs,
        spawnProcess: this.spawnProcess,
        resolveCommand: this.resolveCommand,
        signal,
      },
      (session) => {
        const reply = session.awaitMessage(selectClaudeInitializeModels);
        session.send({
          type: CLAUDE_CONTROL.REQUEST_TYPE,
          request_id: CLAUDE_INITIALIZE_REQUEST_ID,
          request: { subtype: CLAUDE_CONTROL.INITIALIZE_SUBTYPE },
        });
        return reply;
      }
    );
    if (models.length === 0) {
      throw new Error("Claude Code returned no models");
    }
    return models;
  }
}
