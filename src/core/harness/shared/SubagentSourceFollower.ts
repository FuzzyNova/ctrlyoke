import type {
  CliEvent,
  ProviderModelUsage,
  SubagentSpawn,
} from "../../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  SUBAGENT_SPAWN_STATES,
} from "../../../types/DashboardConstants";
import { DRAIN_DEADLINE_MS, DRAIN_POLL_INTERVAL_MS } from "../CliLogMonitor";
import type {
  SubagentChildSource,
  SubagentRecordUsage,
} from "./interfaces/SubagentChildSource";

export const SUBAGENT_SPAWN_UPDATE_TOOL_NAME = "";

export interface SubagentDrainResult {
  events: CliEvent[];
  usageByModel: Record<string, ProviderModelUsage>;
  partial: boolean;
}

interface RegisteredSource {
  key: string;
  attribution: SubagentChildSource<never>["attribution"];
  read(fromOffset: number): Promise<{
    records: Array<{
      events: CliEvent[];
      usage?: SubagentRecordUsage;
      complete: boolean;
    }>;
    nextOffset: number;
    complete?: boolean;
  }>;
  offset: number;
  complete: boolean;
  childComplete: boolean;
  /**
   * Still running when an earlier turn's drain retained it. It keeps
   * streaming, and what it writes later lands in whichever turn reads it,
   * but no later drain waits for it or turns partial because of it.
   */
  carried: boolean;
  seenEvents: Set<string>;
  seenUsage: Set<string>;
}

export interface SubagentDrainOptions {
  /**
   * Keep sources that have not finished registered, with their read offsets,
   * so they go on streaming after this drain (an interactive session stays
   * open after a prompt completes). Off by default: a headless process is
   * gone once drained, so its unfinished children never grow again.
   */
  retainUnfinished?: boolean;
}

/** Follows registered child logs for live output and a bounded final EOF drain. */
export class SubagentSourceFollower {
  private readonly sources = new Map<string, RegisteredSource>();
  private readonly events: CliEvent[] = [];
  private readonly usageByModel: Record<string, ProviderModelUsage> = {};
  private readonly completedSpawns = new Set<string>();
  private partial = false;
  private callback?: (events: CliEvent[]) => void;
  private pollHandle?: NodeJS.Timeout;
  private polling = false;
  private generation = 0;
  private pollIntervalMs = DRAIN_POLL_INTERVAL_MS;

  register<TRecord>(source: SubagentChildSource<TRecord>): void {
    if (this.sources.has(source.key)) return;
    this.sources.set(source.key, {
      key: source.key,
      attribution: source.attribution,
      read: async (fromOffset) => {
        const result = await source.read(fromOffset);
        return {
          nextOffset: result.nextOffset,
          complete: result.complete,
          records: result.records.map((record) => ({
            events: source.map(record),
            usage: source.usage?.(record),
            complete: source.isComplete(record),
          })),
        };
      },
      offset: 0,
      complete: false,
      childComplete: false,
      carried: false,
      seenEvents: new Set(),
      seenUsage: new Set(),
    });
  }

  /** Mark a child complete when its harness reports completion in the parent stream. */
  markChildComplete(agentId: string): CliEvent[] {
    const source = [...this.sources.values()].find(
      (candidate) => candidate.attribution.agentId === agentId
    );
    if (!source || source.childComplete) return [];
    source.childComplete = true;
    const siblings = [...this.sources.values()].filter(
      (candidate) =>
        candidate.attribution.parentToolCallId ===
        source.attribution.parentToolCallId
    );
    if (!siblings.every((candidate) => candidate.childComplete)) return [];
    const parentId = source.attribution.parentToolCallId;
    if (this.completedSpawns.has(parentId)) return [];
    this.completedSpawns.add(parentId);
    const event = this.buildSpawnUpdateEvent(parentId, {
      state: SUBAGENT_SPAWN_STATES.COMPLETED,
    });
    this.events.push(event);
    this.callback?.([event]);
    return [event];
  }

  /**
   * Stream a spawn-card update discovered while following a child source,
   * such as a newly started workflow agent. It is kept for the final output
   * like the follower's own completion updates.
   */
  updateSpawn(parentToolCallId: string, spawn: SubagentSpawn): void {
    if (this.completedSpawns.has(parentToolCallId)) return;
    const event = this.buildSpawnUpdateEvent(parentToolCallId, spawn);
    this.events.push(event);
    this.callback?.([event]);
  }

  /**
   * Start a new turn's accumulation. Output and usage streamed since the last
   * drain (by `SessionActivityWatcher`, between prompts) were already
   * delivered as follow-up activity and must not land in the next prompt's
   * final output too. Registered sources and their offsets are kept.
   */
  beginTurn(): void {
    this.events.length = 0;
    for (const model of Object.keys(this.usageByModel))
      delete this.usageByModel[model];
    this.partial = false;
  }

  start(
    onStreamingEvents: (events: CliEvent[]) => void,
    pollIntervalMs = DRAIN_POLL_INTERVAL_MS
  ): void {
    this.callback = onStreamingEvents;
    this.pollIntervalMs = pollIntervalMs;
    if (this.pollHandle) return;
    this.pollHandle = setInterval(() => void this.poll(), this.pollIntervalMs);
    void this.poll();
  }

  stop(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
    this.pollHandle = undefined;
    this.callback = undefined;
  }

  reset(): void {
    this.generation += 1;
    this.stop();
    this.sources.clear();
    this.events.length = 0;
    for (const model of Object.keys(this.usageByModel))
      delete this.usageByModel[model];
    this.completedSpawns.clear();
    this.partial = false;
    this.polling = false;
  }

  async drainToEof(
    deadlineMs = DRAIN_DEADLINE_MS,
    options: SubagentDrainOptions = {}
  ): Promise<SubagentDrainResult> {
    const deadline = Date.now() + deadlineMs;
    this.stop();
    const awaited = () =>
      [...this.sources.values()].filter((source) => !source.carried);
    // Always read once, so carried children are caught up too, even though
    // the drain does not wait for them.
    let firstPass = this.sources.size > 0;
    while (
      firstPass ||
      (Date.now() < deadline && awaited().some((source) => !source.complete))
    ) {
      firstPass = false;
      const remainingMs = deadline - Date.now();
      const pollCompleted = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), remainingMs);
        void this.poll().then(() => {
          clearTimeout(timeout);
          resolve(true);
        });
      });
      if (!pollCompleted) {
        this.partial = true;
        break;
      }
      if (awaited().every((source) => source.complete)) break;
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(DRAIN_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now()))
        )
      );
    }
    if (awaited().some((source) => !source.complete)) this.partial = true;
    const result = {
      events: [...this.events],
      usageByModel: { ...this.usageByModel },
      partial: this.partial,
    };
    if (options.retainUnfinished) {
      this.beginTurn();
      for (const [key, source] of this.sources) {
        if (source.complete) this.sources.delete(key);
        else source.carried = true;
      }
    } else {
      this.reset();
    }
    return result;
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    const generation = this.generation;
    this.polling = true;
    try {
      await Promise.all(
        [...this.sources.values()].map((source) =>
          this.readSource(source, generation)
        )
      );
    } finally {
      if (generation === this.generation) this.polling = false;
    }
  }

  private async readSource(
    source: RegisteredSource,
    generation: number
  ): Promise<void> {
    if (source.complete) return;
    try {
      const result = await source.read(source.offset);
      if (generation !== this.generation) return;
      source.offset = result.nextOffset;
      source.complete = result.complete ?? false;
      const emitted: CliEvent[] = [];
      for (const record of result.records) {
        for (const event of record.events) {
          const key = JSON.stringify(event);
          if (source.seenEvents.has(key)) continue;
          source.seenEvents.add(key);
          const attributed = { ...event, subagent: source.attribution };
          this.events.push(attributed);
          emitted.push(attributed);
        }
        const usage = record.usage;
        if (usage && !source.seenUsage.has(usage.recordId)) {
          source.seenUsage.add(usage.recordId);
          this.addUsage(usage);
        }
        if (record.complete) {
          source.childComplete = true;
          source.complete = true;
        }
      }
      // A parent report is the child's completion signal; take one final read
      // after observing it so records appended just before the report are kept.
      if (source.childComplete) source.complete = true;
      if (source.complete) {
        const parentId = source.attribution.parentToolCallId;
        const siblings = [...this.sources.values()].filter(
          (candidate) => candidate.attribution.parentToolCallId === parentId
        );
        if (
          siblings.every((candidate) => candidate.childComplete) &&
          !this.completedSpawns.has(parentId)
        ) {
          this.completedSpawns.add(parentId);
          const event = this.buildSpawnUpdateEvent(parentId, {
            state: SUBAGENT_SPAWN_STATES.COMPLETED,
          });
          this.events.push(event);
          emitted.push(event);
        }
      }
      if (emitted.length) this.callback?.(emitted);
    } catch {
      if (generation !== this.generation) return;
      if (!source.carried) this.partial = true;
      source.complete = true;
    }
  }

  private addUsage(usage: SubagentRecordUsage): void {
    const model = (this.usageByModel[usage.model] ??= {});
    model.inputTokens = (model.inputTokens ?? 0) + (usage.inputTokens ?? 0);
    model.outputTokens = (model.outputTokens ?? 0) + (usage.outputTokens ?? 0);
    model.cacheReadInputTokens =
      (model.cacheReadInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0);
    model.cacheCreationInputTokens =
      (model.cacheCreationInputTokens ?? 0) +
      (usage.cacheCreationInputTokens ?? 0);
    model.cacheCreationLongTtlInputTokens =
      (model.cacheCreationLongTtlInputTokens ?? 0) +
      (usage.cacheCreationLongTtlInputTokens ?? 0);
    model.reasoningOutputTokens =
      (model.reasoningOutputTokens ?? 0) + (usage.reasoningOutputTokens ?? 0);
  }

  private buildSpawnUpdateEvent(
    parentToolCallId: string,
    spawn: SubagentSpawn
  ): CliEvent {
    return {
      type: CLI_EVENT_TYPES.TOOL_CALL,
      timestamp: Date.now(),
      data: {
        id: parentToolCallId,
        name: SUBAGENT_SPAWN_UPDATE_TOOL_NAME,
        parameters: {},
        subagentSpawn: spawn,
      },
    };
  }
}
