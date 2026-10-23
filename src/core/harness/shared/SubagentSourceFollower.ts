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
  seenEvents: Set<string>;
  seenUsage: Set<string>;
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
    const event = this.buildSpawnStateEvent(
      parentId,
      SUBAGENT_SPAWN_STATES.COMPLETED
    );
    this.events.push(event);
    this.callback?.([event]);
    return [event];
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
    deadlineMs = DRAIN_DEADLINE_MS
  ): Promise<SubagentDrainResult> {
    const deadline = Date.now() + deadlineMs;
    this.stop();
    while (
      Date.now() < deadline &&
      [...this.sources.values()].some((source) => !source.complete)
    ) {
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
      if ([...this.sources.values()].every((source) => source.complete)) break;
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(DRAIN_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now()))
        )
      );
    }
    if ([...this.sources.values()].some((source) => !source.complete))
      this.partial = true;
    const result = {
      events: [...this.events],
      usageByModel: { ...this.usageByModel },
      partial: this.partial,
    };
    this.reset();
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
          const event = this.buildSpawnStateEvent(
            parentId,
            SUBAGENT_SPAWN_STATES.COMPLETED
          );
          this.events.push(event);
          emitted.push(event);
        }
      }
      if (emitted.length) this.callback?.(emitted);
    } catch {
      if (generation !== this.generation) return;
      this.partial = true;
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

  private buildSpawnStateEvent(
    parentToolCallId: string,
    state: SubagentSpawn["state"]
  ): CliEvent {
    return {
      type: CLI_EVENT_TYPES.TOOL_CALL,
      timestamp: Date.now(),
      data: {
        id: parentToolCallId,
        name: SUBAGENT_SPAWN_UPDATE_TOOL_NAME,
        parameters: {},
        subagentSpawn: { state },
      },
    };
  }
}
