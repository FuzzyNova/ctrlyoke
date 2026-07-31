import * as fs from "fs";
import * as path from "path";
import type { BaseCliEvent } from "../shared/interfaces/ILogParser";
import type { AntigravityLogParser } from "./AntigravityLogParser";

const SNAPSHOT_POLL_INTERVAL_MS = 500;

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
  private readonly snapshotPath: string;
  private readonly model: string;
  private readonly parser: Pick<
    AntigravityLogParser,
    "extractLiveContextWindow"
  >;
  private readonly onContextWindowUpdate: (used: number, size: number) => void;
  private readonly onSnapshot:
    | ((snapshot: AntigravityStatuslineSnapshot) => void)
    | undefined;
  private readonly snapshotDirectory: string;
  private readonly snapshotFileName: string;
  private watcher?: fs.FSWatcher;
  private pollTimer?: NodeJS.Timeout;
  private readQueue = Promise.resolve();
  private stopped = false;
  private lastSnapshotMarker?: string;
  private latestSnapshot?: AntigravityStatuslineSnapshot;

  constructor(deps: AntigravityStatuslineSidecarDeps) {
    this.snapshotPath = deps.snapshotPath;
    this.model = deps.model;
    this.parser = deps.parser;
    this.onContextWindowUpdate = deps.onContextWindowUpdate;
    this.onSnapshot = deps.onSnapshot;
    this.snapshotDirectory = path.dirname(deps.snapshotPath);
    this.snapshotFileName = path.basename(deps.snapshotPath);

    this.startWatching();
    this.queueSnapshotRead();
  }

  /** The most recently accepted raw statusline payload. */
  getLatestSnapshot(): AntigravityStatuslineSnapshot | undefined {
    return this.latestSnapshot;
  }

  /** Flush one final read so completed-response consumers see the newest snapshot. */
  async readLatestSnapshot(): Promise<
    AntigravityStatuslineSnapshot | undefined
  > {
    this.queueSnapshotRead();
    await this.readQueue;
    return this.latestSnapshot;
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
  }

  private startWatching(): void {
    try {
      fs.mkdirSync(this.snapshotDirectory, { recursive: true });
      this.watcher = fs.watch(
        this.snapshotDirectory,
        (_eventType, fileName) => {
          if (
            this.stopped ||
            (fileName != null && fileName.toString() !== this.snapshotFileName)
          ) {
            return;
          }
          this.queueSnapshotRead();
        }
      );
      this.watcher.on("error", () => {
        // Polling remains active when a platform watcher becomes unreliable.
      });
    } catch {
      // The polling fallback below still handles filesystems where fs.watch
      // cannot be created.
    }

    this.pollTimer = setInterval(
      () => this.queueSnapshotRead(),
      SNAPSHOT_POLL_INTERVAL_MS
    );
  }

  private queueSnapshotRead(): void {
    if (this.stopped) {
      return;
    }
    this.readQueue = this.readQueue
      .then(() => this.readSnapshot())
      .catch(() => {
        // A watcher callback must never surface malformed or transient reads.
      });
  }

  private async readSnapshot(): Promise<void> {
    if (this.stopped) {
      return;
    }

    let snapshot: AntigravityStatuslineSnapshot;
    try {
      const content = await fs.promises.readFile(this.snapshotPath, "utf8");
      const parsed: unknown = JSON.parse(content);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return;
      }
      snapshot = parsed as AntigravityStatuslineSnapshot;
    } catch {
      return;
    }

    const marker = this.getSnapshotMarker(snapshot);
    if (!marker || marker === this.lastSnapshotMarker || this.stopped) {
      return;
    }

    this.lastSnapshotMarker = marker;
    this.latestSnapshot = snapshot;
    this.onSnapshot?.(snapshot);

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
    if (context && !this.stopped) {
      this.onContextWindowUpdate(context.used, context.size);
    }
  }

  private getSnapshotMarker(
    snapshot: AntigravityStatuslineSnapshot
  ): string | undefined {
    const metadata = snapshot._ctrlyoke;
    const sequence = this.asFiniteNumber(metadata?.sequence);
    const writtenAt = this.asFiniteNumber(metadata?.writtenAt);
    if (sequence === undefined && writtenAt === undefined) {
      return undefined;
    }
    return `${sequence ?? ""}:${writtenAt ?? ""}`;
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
