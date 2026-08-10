import type { BaseCliEvent } from "../shared/interfaces/ILogParser";
import { StatuslineSnapshotWatcher } from "../shared/StatuslineSnapshotWatcher";
import type { AntigravityLogParser } from "./AntigravityLogParser";

interface SnapshotContextWindow {
  total_input_tokens?: unknown;
  total_output_tokens?: unknown;
  context_window_size?: unknown;
  current_usage?: SnapshotCurrentUsage;
}

export interface SnapshotCurrentUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
}

/** Last-turn usage breakdown, normalized to ctrlyoke's camelCase naming. */
export interface AntigravityCurrentUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Map the statusline payload's `context_window.current_usage` block to
 * ctrlyoke's naming.
 *
 * Single source of truth for this mapping: both the sidecar (building synthetic
 * live events) and `AntigravityLogParser` (deriving final `TokenUsage` from a
 * raw snapshot) consume the same four snake_case fields, so the translation
 * must not be reimplemented per call site.
 */
export function parseStatuslineCurrentUsage(
  usage: SnapshotCurrentUsage | undefined
): AntigravityCurrentUsage | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const parsed: AntigravityCurrentUsage = {
    inputTokens: toFiniteNumber(usage.input_tokens),
    outputTokens: toFiniteNumber(usage.output_tokens),
    cacheCreationInputTokens: toFiniteNumber(usage.cache_creation_input_tokens),
    cacheReadInputTokens: toFiniteNumber(usage.cache_read_input_tokens),
  };
  return Object.values(parsed).some((value) => value !== undefined)
    ? parsed
    : undefined;
}

interface SnapshotMetadata {
  sequence?: unknown;
  writtenAt?: unknown;
}

/** Raw statusline payload, including the wrapper's correlation metadata. */
export interface AntigravityStatuslineSnapshot {
  [key: string]: unknown;
  _ctrlyoke?: SnapshotMetadata;
  context_window?: SnapshotContextWindow;
  model?: unknown;
  conversation_id?: unknown;
}

export interface AntigravityStatuslineSidecarDeps {
  snapshotPath: string;
  model: string;
  parser: Pick<AntigravityLogParser, "extractLiveContextWindow">;
  onContextWindowUpdate: (used: number, size: number) => void;
  onSnapshot?: (snapshot: AntigravityStatuslineSnapshot) => void;
}

/**
 * Watches one Antigravity statusline snapshot and maps it into the existing
 * live-context parser contract. It intentionally never emits streaming events:
 * the snapshot is an additional token-count source, not a second log stream.
 */
export class AntigravityStatuslineSidecar {
  private readonly model: string;
  private readonly parser: Pick<
    AntigravityLogParser,
    "extractLiveContextWindow"
  >;
  private readonly onContextWindowUpdate: (used: number, size: number) => void;
  private readonly watcher: StatuslineSnapshotWatcher<AntigravityStatuslineSnapshot>;

  constructor(deps: AntigravityStatuslineSidecarDeps) {
    this.model = deps.model;
    this.parser = deps.parser;
    this.onContextWindowUpdate = deps.onContextWindowUpdate;
    this.watcher = new StatuslineSnapshotWatcher({
      snapshotPath: deps.snapshotPath,
      onSnapshot: (snapshot) => {
        deps.onSnapshot?.(snapshot);
        this.acceptSnapshot(snapshot);
      },
    });
  }

  /** The most recently accepted raw statusline payload. */
  getLatestSnapshot(): AntigravityStatuslineSnapshot | undefined {
    return this.watcher.getLatestSnapshot();
  }

  /** Flush one final read so completed-response consumers see the newest snapshot. */
  async readLatestSnapshot(): Promise<
    AntigravityStatuslineSnapshot | undefined
  > {
    return this.watcher.readLatestSnapshot();
  }

  stop(): void {
    this.watcher.stop();
  }

  private acceptSnapshot(snapshot: AntigravityStatuslineSnapshot): void {
    const contextWindow = snapshot.context_window;
    const inputTokens = this.asFiniteNumber(contextWindow?.total_input_tokens);
    const outputTokens = this.asFiniteNumber(
      contextWindow?.total_output_tokens
    );
    const contextWindowSize = this.asFiniteNumber(
      contextWindow?.context_window_size
    );
    if (
      inputTokens === undefined ||
      outputTokens === undefined ||
      contextWindowSize === undefined
    ) {
      return;
    }

    const event: BaseCliEvent = {
      type: "log.line",
      line: "",
      timestamp:
        this.asFiniteNumber(snapshot._ctrlyoke?.writtenAt) ?? Date.now(),
      model: this.getModel(snapshot) ?? this.model,
      contextWindowUsedTokens: inputTokens + outputTokens,
      contextWindowSize,
      outputTokens,
      currentUsage: parseStatuslineCurrentUsage(contextWindow?.current_usage),
    } as BaseCliEvent;
    const context = this.parser.extractLiveContextWindow(event, this.model);
    if (context) {
      this.onContextWindowUpdate(context.used, context.size);
    }
  }

  private getModel(
    snapshot: AntigravityStatuslineSnapshot
  ): string | undefined {
    if (typeof snapshot.model === "string") {
      return snapshot.model;
    }
    if (snapshot.model && typeof snapshot.model === "object") {
      const id = (snapshot.model as { id?: unknown }).id;
      return typeof id === "string" && id.length > 0 ? id : undefined;
    }
    return undefined;
  }

  private asFiniteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  }
}
