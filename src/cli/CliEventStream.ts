import type { CliEvent } from "../types/CliOutputTypes";
import { CLI_EVENT_TYPES, OPERATION_STATUS } from "../types/DashboardConstants";
import {
  CliEventNormalizer,
  isOpenCliOperation,
} from "../utils/CliEventNormalizer";
import { findSupersededInitiatedIndex } from "../utils/CliEventVisibility";
import type { CliOutputTarget } from "./CliTerminalFormatter";
import { CliTerminalFormatter } from "./CliTerminalFormatter";

const SLOT_PARTS = {
  HEADER: "header",
  MARKER: "marker",
  BODY: "body",
  ERROR: "error",
} as const;
type SlotPart = (typeof SLOT_PARTS)[keyof typeof SLOT_PARTS];

/** Incremental normalized event renderer for one terminal output target. */
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
    const touched = this.normalizer.append(events);
    const slots = this.normalizer.snapshot();
    const eventsBySlot = slots.map((slot) => slot.event);
    const supersededBy = new Map<number, number>();
    for (let index = 0; index < eventsBySlot.length; index++) {
      const initiated = findSupersededInitiatedIndex(eventsBySlot, index);
      if (initiated === undefined) continue;
      const command = (eventsBySlot[initiated].data as { command?: string })
        .command;
      const completionIndex = eventsBySlot.findIndex(
        (candidate, candidateIndex) => {
          if (
            candidateIndex <= initiated ||
            candidate.type !== CLI_EVENT_TYPES.BASH_COMMAND
          ) {
            return false;
          }
          const data = candidate.data as { command?: string; status?: string };
          return (
            data.command === command &&
            (data.status === OPERATION_STATUS.COMPLETED ||
              data.status === OPERATION_STATUS.FAILED)
          );
        }
      );
      if (completionIndex >= 0) supersededBy.set(completionIndex, initiated);
    }

    for (const index of touched) {
      if (this.maxSlots !== undefined && index >= this.maxSlots) continue;
      const event = eventsBySlot[index];
      if (!event) continue;
      const parts = this.parts(index);
      if (
        event.type === CLI_EVENT_TYPES.TEXT ||
        event.type === CLI_EVENT_TYPES.THINKING
      ) {
        CliTerminalFormatter.renderEvent(event, this.target);
        CliTerminalFormatter.noteStreamSlot(this.targetKey, index);
        parts.add(SLOT_PARTS.BODY);
        continue;
      }

      if (isOpenCliOperation(event)) {
        if (!parts.has(SLOT_PARTS.HEADER)) {
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
        continue;
      }

      const supersededSlot = supersededBy.get(index);
      if (supersededSlot !== undefined) {
        const earlier = this.normalizer.snapshot()[supersededSlot]?.event;
        if (earlier) {
          const earlierParts = this.parts(supersededSlot);
          if (!earlierParts.has(SLOT_PARTS.HEADER)) {
            CliTerminalFormatter.renderStreamHeader(
              earlier,
              this.target,
              true,
              this.targetKey,
              supersededSlot
            );
            earlierParts.add(SLOT_PARTS.HEADER);
            earlierParts.add(SLOT_PARTS.MARKER);
          }
          CliTerminalFormatter.renderStreamBody(
            earlier,
            event,
            this.target,
            this.targetKey,
            supersededSlot
          );
          earlierParts.add(SLOT_PARTS.BODY);
          parts.add(SLOT_PARTS.BODY);
          continue;
        }
      }

      if (parts.has(SLOT_PARTS.MARKER)) {
        CliTerminalFormatter.renderStreamBody(
          event,
          event,
          this.target,
          this.targetKey,
          index
        );
        parts.add(
          (event.data as { error?: unknown }).error
            ? SLOT_PARTS.ERROR
            : SLOT_PARTS.BODY
        );
      } else if (!parts.has(SLOT_PARTS.BODY)) {
        CliTerminalFormatter.renderEvent(event, this.target);
        CliTerminalFormatter.noteStreamSlot(this.targetKey, index);
        parts.add(SLOT_PARTS.HEADER);
        parts.add(SLOT_PARTS.BODY);
      }
    }
  }

  finish(): void {
    if (this.disposed) return;
    CliTerminalFormatter.flushStreamingBuffer(this.target);
  }

  get slotCount(): number {
    return this.normalizer.snapshot().length;
  }

  dispose(): void {
    this.disposed = true;
    this.printedParts.clear();
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
