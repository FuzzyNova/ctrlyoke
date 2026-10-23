import type { CliEvent, SubagentAttribution } from "../../../types/CliOutputTypes";
import { DRAIN_DEADLINE_MS } from "../CliLogMonitor";
import type { BaseCliEvent } from "./interfaces/ILogParser";

/** A child log becomes eligible for reading only after its spawn link is known. */
export interface SubagentChildSource {
  attribution: SubagentAttribution;
  open(): AsyncIterable<BaseCliEvent>;
  map(record: BaseCliEvent): CliEvent[];
  usage?(record: BaseCliEvent): { model: string; inputTokens: number; outputTokens: number; cachedInputTokens?: number } | undefined;
}

export interface SubagentDrainResult {
  events: CliEvent[];
  usageByModel: Record<string, { inputTokens: number; outputTokens: number; cachedInputTokens: number }>;
  partial: boolean;
}

/** Tails registered child sources once, suppressing duplicate records and bounding EOF drain. */
export class SubagentSourceFollower {
  private readonly sources = new Map<string, SubagentChildSource>();
  private readonly seen = new Map<string, Set<string>>();
  private readonly events: CliEvent[] = [];
  private readonly usageByModel: SubagentDrainResult["usageByModel"] = {};
  private partial = false;

  constructor(private readonly onEvents?: (events: CliEvent[]) => void) {}

  register(key: string, source: SubagentChildSource): void {
    if (!this.sources.has(key)) {
      this.sources.set(key, source);
      this.seen.set(key, new Set());
    }
  }

  async drain(deadlineMs = DRAIN_DEADLINE_MS): Promise<SubagentDrainResult> {
    const deadline = Date.now() + deadlineMs;
    await Promise.all([...this.sources].map(async ([key, source]) => {
      try {
        for await (const record of source.open()) {
          if (Date.now() > deadline) { this.partial = true; break; }
          const fingerprint = JSON.stringify(record);
          const seen = this.seen.get(key)!;
          if (seen.has(fingerprint)) continue;
          seen.add(fingerprint);
          const mapped = source.map(record).map((event) => ({ ...event, subagent: source.attribution }));
          this.events.push(...mapped);
          if (mapped.length) this.onEvents?.(mapped);
          const usage = source.usage?.(record);
          if (usage) {
            const total = this.usageByModel[usage.model] ??= { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
            total.inputTokens += usage.inputTokens;
            total.outputTokens += usage.outputTokens;
            total.cachedInputTokens += usage.cachedInputTokens ?? 0;
          }
        }
      } catch {
        this.partial = true;
      }
    }));
    return { events: [...this.events], usageByModel: { ...this.usageByModel }, partial: this.partial };
  }

  markPartial(): void { this.partial = true; }
}
