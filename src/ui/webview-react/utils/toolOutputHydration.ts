import type { CliOutput } from "@root/types/WebviewMessageTypes";
import type { WorkflowRunAddress } from "@root/types/CtrlYokeTypes";
import type {
  FetchToolOutputEvent,
  ToolOutputEventIdentity,
} from "@hooks/useToolOutputContent";
import type { CliEvent } from "@root/types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  FINAL_STEP_PHASES,
  OUTPUT_HISTORY_KINDS,
  OUTPUT_MESSAGE_TYPES,
} from "@root/types/DashboardConstants";

export type { FetchToolOutputEvent };

async function fetchToolOutputEvents(
  fetchEvent: FetchToolOutputEvent,
  identities: readonly ToolOutputEventIdentity[]
): Promise<(CliEvent | undefined)[]> {
  return fetchEvent.requestMany
    ? fetchEvent.requestMany(identities)
    : Promise.all(identities.map((identity) => fetchEvent(identity)));
}

export function isToolOutputTruncated(event: CliEvent): boolean {
  if (event.outputTruncated) return true;
  if (event.type === CLI_EVENT_TYPES.BASH_COMMAND) {
    return Boolean(
      (event.data as { outputTruncated?: boolean }).outputTruncated
    );
  }
  if (event.type === CLI_EVENT_TYPES.TOOL_RESULT) {
    const result = (event.data as { result?: { outputTruncated?: boolean } })
      .result;
    return Boolean(result?.outputTruncated);
  }
  return false;
}

export async function hydrateCliOutputEvents(
  output: CliOutput,
  identity: Omit<ToolOutputEventIdentity, "eventIndex">,
  fetchEvent: FetchToolOutputEvent
): Promise<CliOutput> {
  const events = output.structured?.events;
  if (!events?.some(isToolOutputTruncated)) return output;
  const indices = events.flatMap((event, eventIndex) =>
    isToolOutputTruncated(event) ? [eventIndex] : []
  );
  const hydrated = await fetchToolOutputEvents(
    fetchEvent,
    indices.map((eventIndex) => ({ ...identity, eventIndex }))
  );
  const fullEvents = [...events];
  indices.forEach((eventIndex, index) => {
    fullEvents[eventIndex] = hydrated[index] ?? fullEvents[eventIndex];
  });
  return {
    ...output,
    structured: { ...output.structured!, events: fullEvents },
  };
}

export async function hydrateOrderedCliEntries(
  entries: readonly import("@root/types/OutputHistoryTypes").OrderedHistoryEntry[],
  address: WorkflowRunAddress,
  fetchEvent: FetchToolOutputEvent
): Promise<import("@root/types/OutputHistoryTypes").OrderedHistoryEntry[]> {
  const identities: ToolOutputEventIdentity[] = [];
  const locations: Array<{ entryIndex: number; eventIndex: number }> = [];
  for (const [entryIndex, entry] of entries.entries()) {
    if (entry.kind !== OUTPUT_HISTORY_KINDS.CLI) continue;
    for (const [eventIndex, event] of (
      entry.cliOutput.structured?.events ?? []
    ).entries()) {
      if (!isToolOutputTruncated(event)) continue;
      identities.push({
        address,
        target: entry.target,
        attemptIndex: entry.attemptIndex,
        runIndex: entry.runIndex,
        phase: entry.phase,
        eventIndex,
      });
      locations.push({ entryIndex, eventIndex });
    }
  }
  const fetched = await fetchToolOutputEvents(fetchEvent, identities);
  const eventsByEntry = new Map<
    number,
    Array<{ eventIndex: number; event: CliEvent }>
  >();
  locations.forEach((location, resultIndex) => {
    const event = fetched[resultIndex];
    if (!event) return;
    const events = eventsByEntry.get(location.entryIndex) ?? [];
    events.push({ eventIndex: location.eventIndex, event });
    eventsByEntry.set(location.entryIndex, events);
  });
  return entries.map((entry, entryIndex) => {
    if (entry.kind !== OUTPUT_HISTORY_KINDS.CLI) return entry;
    const matching = eventsByEntry.get(entryIndex);
    if (!matching || matching.length === 0) return entry;
    const events = [...(entry.cliOutput.structured?.events ?? [])];
    for (const hydrated of matching) {
      events[hydrated.eventIndex] = hydrated.event;
    }
    return {
      ...entry,
      cliOutput: {
        ...entry.cliOutput,
        structured: { ...entry.cliOutput.structured!, events },
      },
    };
  });
}

export async function hydrateOutputMessages<
  T extends {
    type: string;
    data: unknown;
    target: { kind: string; index: number };
    attemptIndex?: number;
    runIndex?: number;
    phase?: ToolOutputEventIdentity["phase"];
    activityEventIndices?: number[];
  },
>(
  messages: readonly T[],
  address: WorkflowRunAddress,
  fetchEvent: FetchToolOutputEvent
): Promise<T[]> {
  const identities: ToolOutputEventIdentity[] = [];
  const locations: Array<{ messageIndex: number; eventIndex: number }> = [];
  for (const [messageIndex, message] of messages.entries()) {
    if (
      message.type !== OUTPUT_MESSAGE_TYPES.CLI ||
      message.attemptIndex === undefined ||
      !message.data ||
      typeof message.data !== "object"
    )
      continue;
    const output = message.data as CliOutput;
    const target =
      message.target.kind === FINAL_STEP_PHASES.FINAL_STEP
        ? {
            kind: FINAL_STEP_PHASES.FINAL_STEP,
            loopIndex: message.target.index,
          }
        : { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: message.target.index };
    for (const [eventIndex, event] of (
      output.structured?.events ?? []
    ).entries()) {
      if (!isToolOutputTruncated(event)) continue;
      identities.push({
        address,
        target,
        attemptIndex: message.attemptIndex,
        runIndex: message.runIndex,
        phase: message.phase,
        eventIndex: message.activityEventIndices?.[eventIndex] ?? eventIndex,
      });
      locations.push({ messageIndex, eventIndex });
    }
  }
  const fetched = await fetchToolOutputEvents(fetchEvent, identities);
  const eventsByMessage = new Map<
    number,
    Array<{ eventIndex: number; event: CliEvent }>
  >();
  locations.forEach((location, resultIndex) => {
    const event = fetched[resultIndex];
    if (!event) return;
    const events = eventsByMessage.get(location.messageIndex) ?? [];
    events.push({ eventIndex: location.eventIndex, event });
    eventsByMessage.set(location.messageIndex, events);
  });
  return messages.map((message, messageIndex) => {
    const matching = eventsByMessage.get(messageIndex);
    if (!matching || matching.length === 0) return message;
    const output = { ...(message.data as CliOutput) };
    const events = [...(output.structured?.events ?? [])];
    for (const hydrated of matching) {
      events[hydrated.eventIndex] = hydrated.event;
    }
    return {
      ...message,
      data: {
        ...output,
        structured: { ...output.structured!, events },
      },
    };
  });
}
