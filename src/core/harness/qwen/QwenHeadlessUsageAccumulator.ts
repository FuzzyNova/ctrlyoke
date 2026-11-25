import { splitCompleteLines } from "../../../utils/TextLines";
import { isRecord } from "../../../utils/JsonTypeGuards";
import { QWEN_EVENT_TYPES } from "./QwenProtocolConstants";

/** Captures Qwen's process-wide terminal usage from headless stream-json. */
export class QwenHeadlessUsageAccumulator {
  private remainder = "";
  private resultUsage?: Record<string, number>;

  constructor(
    private readonly onResultUsage: (usage?: Record<string, number>) => void
  ) {}

  ingest(chunk: string): void {
    this.remainder += chunk;
    const { lines, remainder } = splitCompleteLines(this.remainder);
    this.remainder = remainder;
    lines.forEach((line) => this.ingestLine(line));
  }

  flush(): void {
    if (this.remainder) this.ingestLine(this.remainder);
    this.remainder = "";
  }

  reset(): void {
    this.remainder = "";
    this.resultUsage = undefined;
    this.onResultUsage(undefined);
  }

  private ingestLine(line: string): void {
    try {
      const event: unknown = JSON.parse(line);
      if (
        isRecord(event) &&
        event.type === QWEN_EVENT_TYPES.RESULT &&
        isRecord(event.usage) &&
        Object.values(event.usage).every((value) => typeof value === "number")
      ) {
        this.resultUsage = event.usage as Record<string, number>;
        this.onResultUsage(this.resultUsage);
      }
    } catch {
      // Ignore non-JSON and partial records; stdout is enrichment only.
    }
  }
}
