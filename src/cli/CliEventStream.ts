import type {
  BashCommandData,
  CliEvent,
  FileEditData,
} from "../types/CliOutputTypes";
import { CLI_EVENT_TYPES, OPERATION_STATUS } from "../types/DashboardConstants";
import {
  CliEventNormalizer,
  isOpenCliOperation,
} from "../utils/CliEventNormalizer";
import { findSupersededInitiatedIndex } from "../utils/CliEventVisibility";
import type { CliOutputTarget } from "./CliTerminalFormatter";
import { CliTerminalFormatter, hasFileEditDiff } from "./CliTerminalFormatter";

const SLOT_PARTS = {
  HEADER: "header",
  MARKER: "marker",
  BODY: "body",
} as const;
type SlotPart = (typeof SLOT_PARTS)[keyof typeof SLOT_PARTS];

/**
 * Incremental normalized event renderer for one terminal output target.
 *
 * Each slot prints its header and its body at most once, as soon as the data
 * for that part exists. The body covers the completion's output and error.
 */
export class CliEventStream {
  private readonly normalizer = new CliEventNormalizer();
  private readonly printedParts = new Map<number, Set<SlotPart>>();
  private disposed = false;

  constructor(
    private readonly targetKey: string,
    private readonly target?: CliOutputTarget,
    private readonly maxSlots?: number
  ) {}

  append(events: readonly CliEvent[]): void {
    if (this.disposed || events.length === 0) return;
    for (const index of this.normalizer.append(events)) {
      if (this.maxSlots !== undefined && index >= this.maxSlots) continue;
      this.renderSlot(index);
    }
  }

  /**
   * Settle what the attempt has finished with: a slot that was waiting for a
   * semantic completion that never came prints its body now.
   */
  finish(): void {
    if (this.disposed) return;
    const slots = this.normalizer.events;
    for (const [index, parts] of this.printedParts) {
      if (!parts.has(SLOT_PARTS.MARKER) || parts.has(SLOT_PARTS.BODY)) continue;
      const event = slots[index];
      if (!event || isOpenCliOperation(event)) continue;
      this.printBody(index, event, event);
    }
    CliTerminalFormatter.flushStreamingBuffer(this.target);
  }

  get slotCount(): number {
    return this.normalizer.events.length;
  }

  dispose(): void {
    this.disposed = true;
    this.printedParts.clear();
  }

  private renderSlot(index: number): void {
    const event = this.normalizer.events[index];
    if (!event) return;
    const parts = this.parts(index);
    if (
      event.type === CLI_EVENT_TYPES.TEXT ||
      event.type === CLI_EVENT_TYPES.THINKING
    ) {
      CliTerminalFormatter.renderEvent(event, this.target);
      CliTerminalFormatter.noteStreamSlot(this.targetKey, index);
      return;
    }
    if (parts.has(SLOT_PARTS.BODY)) return;

    if (isOpenCliOperation(event) || this.isAwaitingDiff(index, event)) {
      this.printRunningHeader(index, event);
      return;
    }

    const supersededSlot = this.findSupersededSlot(index, event);
    if (supersededSlot !== undefined) {
      const earlier = this.normalizer.events[supersededSlot];
      this.printRunningHeader(supersededSlot, earlier);
      this.printBody(supersededSlot, earlier, event);
      parts.add(SLOT_PARTS.BODY);
      return;
    }

    if (parts.has(SLOT_PARTS.HEADER)) {
      this.printBody(index, event, event);
      return;
    }
    CliTerminalFormatter.renderEvent(event, this.target);
    CliTerminalFormatter.noteStreamSlot(this.targetKey, index);
    parts.add(SLOT_PARTS.HEADER);
    parts.add(SLOT_PARTS.BODY);
  }

  private printRunningHeader(index: number, event: CliEvent): void {
    const parts = this.parts(index);
    if (parts.has(SLOT_PARTS.HEADER)) return;
    CliTerminalFormatter.renderStreamHeader(
      event,
      this.target,
      true,
      this.targetKey,
      index
    );
    parts.add(SLOT_PARTS.HEADER);
    parts.add(SLOT_PARTS.MARKER);
  }

  private printBody(
    index: number,
    headerEvent: CliEvent,
    completionEvent: CliEvent
  ): void {
    CliTerminalFormatter.renderStreamBody(
      headerEvent,
      completionEvent,
      this.target,
      this.targetKey,
      index
    );
    this.parts(index).add(SLOT_PARTS.BODY);
  }

  /**
   * A FILE_EDIT settled by its TOOL_RESULT before the completion that carries
   * the diff: printing now would print `(no diff recorded)` and then the diff.
   */
  private isAwaitingDiff(index: number, event: CliEvent): boolean {
    if (event.type !== CLI_EVENT_TYPES.FILE_EDIT) return false;
    const data = event.data as FileEditData;
    return (
      data.status !== OPERATION_STATUS.FAILED &&
      !hasFileEditDiff(data) &&
      this.normalizer.isAwaitingSemanticCompletion(index)
    );
  }

  /**
   * The earlier Bash `initiated` slot this completion supersedes, when the
   * normalizer could not merge them; uses the dashboard's predicate.
   */
  private findSupersededSlot(
    index: number,
    event: CliEvent
  ): number | undefined {
    if (event.type !== CLI_EVENT_TYPES.BASH_COMMAND) return undefined;
    const { command } = event.data as BashCommandData;
    if (!command) return undefined;
    const slots = this.normalizer.events;
    for (let candidate = index - 1; candidate >= 0; candidate--) {
      const earlier = slots[candidate];
      if (earlier.type !== CLI_EVENT_TYPES.BASH_COMMAND) continue;
      if ((earlier.data as BashCommandData).command !== command) continue;
      // The nearest earlier same-command row is the one the predicate pairs
      // with this completion.
      return findSupersededInitiatedIndex(slots, candidate);
    }
    return undefined;
  }

  private parts(index: number): Set<SlotPart> {
    let parts = this.printedParts.get(index);
    if (!parts) {
      parts = new Set<SlotPart>();
      this.printedParts.set(index, parts);
    }
    return parts;
  }
}
