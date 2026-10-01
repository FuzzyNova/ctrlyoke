import type { CliOutput } from "@root/types/WebviewMessageTypes";
import type { WorkflowRunAddress } from "@root/types/CtrlYokeTypes";
import type { ToolOutputEventIdentity } from "@hooks/useToolOutputContent";
import type { CliEvent } from "@root/types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  FINAL_STEP_PHASES,
  OUTPUT_HISTORY_KINDS,
  OUTPUT_MESSAGE_TYPES,
} from "@root/types/DashboardConstants";

export type FetchToolOutputEvent = (
  identity: ToolOutputEventIdentity
) => Promise<CliEvent | undefined>;

function isTruncated(event: CliEvent): boolean {
  if (event.outputTruncated) return true;
  if (event.type === CLI_EVENT_TYPES.BASH_COMMAND) {
    return Boolean(
      (event.data as { outputTruncated?: boolean }).outputTruncated
    );
  }
  if (event.type === CLI_EVENT_TYPES.TOOL_RESULT) {
    const result = (event.data as { result?: { outputTruncated?: boolean } }).result;
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
  if (!events?.some(isTruncated)) return output;
  const fullEvents = await Promise.all(
    events.map(async (event, eventIndex) => {
      if (!isTruncated(event)) return event;
      return (
        (await fetchEvent({ ...identity, eventIndex })) ?? event
      );
    })
  );
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
  return Promise.all(
    entries.map(async (entry) => {
      if (entry.kind !== OUTPUT_HISTORY_KINDS.CLI) return entry;
      const cliOutput = await hydrateCliOutputEvents(
        entry.cliOutput,
        {
          address,
          target: entry.target,
          attemptIndex: entry.attemptIndex,
          runIndex: entry.runIndex,
          phase: entry.phase,
        },
        fetchEvent
      );
      return cliOutput === entry.cliOutput ? entry : { ...entry, cliOutput };
    })
  );
}

export async function hydrateOutputMessages<T extends {
  type: string;
  data: unknown;
  target: { kind: string; index: number };
  attemptIndex?: number;
  runIndex?: number;
  phase?: ToolOutputEventIdentity["phase"];
}>(
  messages: readonly T[],
  address: WorkflowRunAddress,
  fetchEvent: FetchToolOutputEvent
): Promise<T[]> {
  return Promise.all(
    messages.map(async (message) => {
      if (
        message.type !== OUTPUT_MESSAGE_TYPES.CLI ||
        message.attemptIndex === undefined ||
        !message.data ||
        typeof message.data !== "object"
      ) return message;
      const output = await hydrateCliOutputEvents(
        message.data as CliOutput,
        {
          address,
          target: message.target.kind === FINAL_STEP_PHASES.FINAL_STEP
            ? { kind: FINAL_STEP_PHASES.FINAL_STEP, loopIndex: message.target.index }
            : { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: message.target.index },
          attemptIndex: message.attemptIndex,
          runIndex: message.runIndex,
          phase: message.phase,
        },
        fetchEvent
      );
      return output === message.data ? message : { ...message, data: output };
    })
  );
}
