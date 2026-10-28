/**
 * What the dashboard's screen-reader live region says about a run.
 *
 * Announcements are derived from store state, never from rendered rows: the
 * output pane is virtualized, so rows mount and unmount as the user scrolls,
 * and a live region fed from the DOM would announce a scroll as new output and
 * miss everything off screen. `OutputAnnouncementTracker` compares successive
 * snapshots instead and says only what changed between them.
 *
 * The first snapshot, and the first after the viewed workflow or run changes,
 * is a baseline: it records what is already there without announcing it, so
 * opening a workflow never reads out its whole history.
 */
import {
  CLI_EVENT_TYPES,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  IN_FLIGHT_EXECUTION_STATES,
  OPERATION_STATUS,
  OUTPUT_ANNOUNCEMENT_MODES,
  OUTPUT_HISTORY_KINDS,
  STEP_STATUS,
  isPromptExecutionPhase,
  type ExecutionState,
  type OutputAnnouncementMode,
  type StepStatus,
} from "@root/types/DashboardConstants";
import type {
  OrderedCliHistoryEntry,
  OrderedHistoryEntry,
  OutputExecutionTarget,
} from "@root/types/OutputHistoryTypes";
import type {
  AskUserQuestionData,
  CliEvent,
  TextData,
} from "@root/types/CliOutputTypes";
import type { CliOutput } from "@root/types/WebviewMessageTypes";
import { formatStepTargetLabel } from "@root/utils/FinalStepLabels";
import { joinResponseText } from "@root/utils/ResponseTextJoin";
import { getFinalAssistantText } from "@root/utils/StepOutputText";
import {
  describeActivityForSpeech,
  findSettledSpeechBoundary,
  toSpeechText,
} from "@root/utils/speechText";
import type { WorkflowStep } from "@store/workflowStore";
import { cliEntryIdentityKey, getCliEntryIdentity } from "./outputProjection";
import { isScriptOutput } from "./outputRenderUtils";

/** Streaming mode reads new paragraphs at most this often. */
export const STREAMING_ANNOUNCEMENT_INTERVAL_MS = 2500;

export interface OutputAnnouncementSnapshot {
  /** Identity of the workflow/run on screen; a change starts a new baseline. */
  viewKey: string | null;
  /** Whether `entries` came from a loaded run rather than the live view. */
  entriesFromHistory: boolean;
  executionState: ExecutionState;
  steps: readonly WorkflowStep[];
  finalStep: WorkflowStep | null;
  finalStepStatus: StepStatus | null;
  /** 0-based index of the final step's current pass. */
  finalStepLoopCount: number;
  entries: readonly OrderedHistoryEntry[];
  nowMs: number;
}

/** The parts of a snapshot needed to name a step. */
type StepNames = Pick<OutputAnnouncementSnapshot, "steps" | "finalStep">;

interface TrackedEntry {
  cliOutput: CliOutput;
  isStreaming: boolean;
  /** Length of the streamed reply already read out (streaming mode only). */
  spokenLength: number;
}

const STEP_STATUS_PHRASES: Partial<Record<StepStatus, string>> = {
  [STEP_STATUS.RUNNING]: "started",
  [STEP_STATUS.COMPLETED]: "completed",
  [STEP_STATUS.FAILED]: "failed",
  [STEP_STATUS.CANCELLED]: "cancelled",
};

const WORKFLOW_STATE_ANNOUNCEMENTS: Partial<Record<ExecutionState, string>> = {
  [EXECUTION_STATES.COMPLETED]: "Workflow completed.",
  [EXECUTION_STATES.ERROR]: "Workflow stopped with an error.",
  [EXECUTION_STATES.STOPPED]: "Workflow stopped.",
  [EXECUTION_STATES.PAUSED]: "Workflow paused.",
};

function stepLabel(
  names: StepNames,
  isFinalStep: boolean,
  index: number
): string {
  const step = isFinalStep ? names.finalStep : names.steps[index];
  const name = step?.name?.trim();
  const label = formatStepTargetLabel(isFinalStep, index);
  return name ? `${label}, ${name},` : label;
}

function targetLabel(names: StepNames, target: OutputExecutionTarget): string {
  return target.kind === FINAL_STEP_PHASES.FINAL_STEP
    ? stepLabel(names, true, target.loopIndex)
    : stepLabel(names, false, target.stepIndex);
}

/** Entries that hold a step's AI response, as opposed to scripts or conditions. */
function isResponseEntry(
  entry: OrderedHistoryEntry
): entry is OrderedCliHistoryEntry {
  return (
    entry.kind === OUTPUT_HISTORY_KINDS.CLI &&
    isPromptExecutionPhase(entry.phase) &&
    !isScriptOutput(entry.cliOutput)
  );
}

function responseEvents(output: CliOutput): readonly CliEvent[] {
  return output.structured?.events ?? [];
}

/** Everything the step's own agent has written so far, in order. */
function ownAssistantText(events: readonly CliEvent[]): string {
  return joinResponseText(
    events
      .filter((event) => event.type === CLI_EVENT_TYPES.TEXT && !event.subagent)
      .map((event) => (event.data as TextData).text)
  );
}

/**
 * The prefix of a streaming reply whose paragraphs are complete. Text written
 * before a later event (a tool call) is complete; within the last stretch of
 * text, only up to its last blank line outside a code fence.
 */
function settledAssistantLength(events: readonly CliEvent[]): number {
  const parts = events
    .filter((event) => event.type === CLI_EVENT_TYPES.TEXT && !event.subagent)
    .map((event) => (event.data as TextData).text);
  if (parts.length === 0) return 0;
  const lastIndex = parts.length - 1;
  const last = parts[lastIndex];
  const settled = [
    ...parts.slice(0, lastIndex),
    last.slice(0, findSettledSpeechBoundary(last)),
  ];
  const lastIsLatestEvent =
    events[events.length - 1]?.type === CLI_EVENT_TYPES.TEXT;
  return joinResponseText(lastIsLatestEvent ? settled : parts).length;
}

function questionKey(
  entryKey: string,
  eventIndex: number,
  data: AskUserQuestionData
): string {
  return data.toolCallId ?? `${entryKey}:${eventIndex}`;
}

function describeQuestions(label: string, data: AskUserQuestionData): string {
  const questions = data.questions.map((entry) => {
    const options = entry.options.map((option) => option.label).join(", ");
    const header = entry.header ? `${entry.header}: ` : "";
    return `${header}${entry.question}${options ? ` Options: ${options}.` : ""}`;
  });
  return `${label} asks: ${questions.join(" ")}`;
}

function joinSentences(...parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * Compares successive store snapshots and returns what to announce. One
 * instance per mounted announcer; recreate it when the mode changes.
 */
export class OutputAnnouncementTracker {
  private previous: OutputAnnouncementSnapshot | null = null;
  private readonly entries = new Map<string, TrackedEntry>();
  private readonly seenQuestions = new Set<string>();
  private lastStreamAnnouncementMs = Number.NEGATIVE_INFINITY;

  constructor(private readonly mode: OutputAnnouncementMode) {}

  /** Announcements for everything that changed since the last snapshot. */
  observe(snapshot: OutputAnnouncementSnapshot): string[] {
    const previous = this.previous;
    this.previous = snapshot;
    const isBaseline =
      previous === null ||
      previous.viewKey !== snapshot.viewKey ||
      previous.entriesFromHistory !== snapshot.entriesFromHistory;
    if (isBaseline) {
      this.entries.clear();
    }
    const speak = !isBaseline && this.mode !== OUTPUT_ANNOUNCEMENT_MODES.NONE;

    const finished: string[] = [];
    const started: string[] = [];
    if (speak && previous) {
      this.collectStatusChanges(previous, snapshot, finished, started);
    }
    const responses = this.collectEntryChanges(snapshot, speak);
    const workflow =
      speak && previous ? this.describeWorkflowChange(previous, snapshot) : "";

    return [...finished, ...responses, ...started, workflow].filter(Boolean);
  }

  private collectStatusChanges(
    previous: OutputAnnouncementSnapshot,
    next: OutputAnnouncementSnapshot,
    finished: string[],
    started: string[]
  ): void {
    // Statuses move only while a run is in flight; outside one, an index-wise
    // difference is a reorder or a reload, not a step finishing.
    if (
      !IN_FLIGHT_EXECUTION_STATES.has(previous.executionState) &&
      !IN_FLIGHT_EXECUTION_STATES.has(next.executionState)
    ) {
      return;
    }
    const announce = (
      before: StepStatus | null | undefined,
      after: StepStatus | null | undefined,
      label: string
    ) => {
      if (!after || before === after) return;
      if (after === STEP_STATUS.RUNNING && before === STEP_STATUS.SENT) return;
      const phrase = STEP_STATUS_PHRASES[after];
      if (!phrase) return;
      (after === STEP_STATUS.RUNNING ? started : finished).push(
        `${label} ${phrase}.`
      );
    };
    next.steps.forEach((step, index) =>
      announce(
        previous.steps[index]?.status,
        step.status,
        stepLabel(next, false, index)
      )
    );
    if (next.finalStep) {
      // A new pass restarts the final step's status; compare within one pass.
      const samePass = previous.finalStepLoopCount === next.finalStepLoopCount;
      announce(
        samePass ? previous.finalStepStatus : null,
        next.finalStepStatus,
        stepLabel(next, true, next.finalStepLoopCount)
      );
    }
  }

  private describeWorkflowChange(
    previous: OutputAnnouncementSnapshot,
    next: OutputAnnouncementSnapshot
  ): string {
    if (
      previous.executionState === next.executionState ||
      !IN_FLIGHT_EXECUTION_STATES.has(previous.executionState)
    ) {
      return "";
    }
    return WORKFLOW_STATE_ANNOUNCEMENTS[next.executionState] ?? "";
  }

  private collectEntryChanges(
    snapshot: OutputAnnouncementSnapshot,
    speak: boolean
  ): string[] {
    const messages: string[] = [];
    const streamingMode = this.mode === OUTPUT_ANNOUNCEMENT_MODES.STREAMING;
    const streamDue =
      snapshot.nowMs - this.lastStreamAnnouncementMs >=
      STREAMING_ANNOUNCEMENT_INTERVAL_MS;
    let streamed = false;

    for (const entry of snapshot.entries) {
      if (!isResponseEntry(entry)) continue;
      const key = cliEntryIdentityKey(getCliEntryIdentity(entry));
      const tracked = this.entries.get(key);
      if (tracked?.cliOutput === entry.cliOutput) continue;

      const output = entry.cliOutput;
      const events = responseEvents(output);
      const label = targetLabel(snapshot, entry.target);
      const questions = this.collectNewQuestions(key, events, label);

      if (!speak) {
        this.entries.set(key, {
          cliOutput: output,
          isStreaming: output.isStreaming,
          spokenLength: ownAssistantText(events).length,
        });
        continue;
      }

      messages.push(...questions);
      const spokenLength = tracked?.spokenLength ?? 0;
      const wasStreaming = tracked?.isStreaming ?? true;
      let nextSpokenLength = spokenLength;

      if (wasStreaming && !output.isStreaming) {
        messages.push(
          this.describeFinishedResponse(label, events, spokenLength)
        );
        nextSpokenLength = ownAssistantText(events).length;
      } else if (output.isStreaming && streamingMode && streamDue) {
        const text = ownAssistantText(events);
        const settledLength = Math.min(
          settledAssistantLength(events),
          text.length
        );
        if (settledLength > spokenLength) {
          const chunk = toSpeechText(text.slice(spokenLength, settledLength));
          if (chunk) {
            messages.push(chunk);
            streamed = true;
          }
          nextSpokenLength = settledLength;
        }
      }

      this.entries.set(key, {
        cliOutput: output,
        isStreaming: output.isStreaming,
        spokenLength: nextSpokenLength,
      });
    }

    if (streamed) {
      this.lastStreamAnnouncementMs = snapshot.nowMs;
    }
    return messages.filter(Boolean);
  }

  private describeFinishedResponse(
    label: string,
    events: readonly CliEvent[],
    spokenLength: number
  ): string {
    const activity = describeActivityForSpeech(events);
    if (this.mode === OUTPUT_ANNOUNCEMENT_MODES.STREAMING) {
      const remainder = toSpeechText(
        ownAssistantText(events).slice(spokenLength)
      );
      return joinSentences(`${label} response finished.`, activity, remainder);
    }
    const text = toSpeechText(getFinalAssistantText(events));
    if (!activity && !text) return "";
    return joinSentences(`${label} response:`, activity, text);
  }

  /** New, still-unanswered questions; every question seen is remembered. */
  private collectNewQuestions(
    entryKey: string,
    events: readonly CliEvent[],
    label: string
  ): string[] {
    const messages: string[] = [];
    events.forEach((event, index) => {
      if (event.type !== CLI_EVENT_TYPES.ASK_USER_QUESTION) return;
      const data = event.data as AskUserQuestionData;
      const key = questionKey(entryKey, index, data);
      if (this.seenQuestions.has(key)) return;
      this.seenQuestions.add(key);
      const isPending =
        data.status === OPERATION_STATUS.INITIATED ||
        (data.status === undefined &&
          !data.declined &&
          data.questions.every((question) => question.answer === undefined));
      if (isPending && data.questions.length > 0) {
        messages.push(describeQuestions(label, data));
      }
    });
    return messages;
  }
}

/**
 * The "Read last response" text: the most recent finished response in
 * `entries`, its activity summary first. Used on demand in every mode.
 */
export function describeLastResponse(
  entries: readonly OrderedHistoryEntry[],
  names: StepNames
): string {
  let latest: OrderedCliHistoryEntry | null = null;
  let latestText = "";
  for (const entry of entries) {
    if (!isResponseEntry(entry) || entry.cliOutput.isStreaming) continue;
    const text = getFinalAssistantText(responseEvents(entry.cliOutput));
    if (!text.trim()) continue;
    if (
      !latest ||
      entry.timestampMs > latest.timestampMs ||
      (entry.timestampMs === latest.timestampMs &&
        entry.sequence > latest.sequence)
    ) {
      latest = entry;
      latestText = text;
    }
  }
  if (!latest) return "No finished response to read yet.";
  return joinSentences(
    `${targetLabel(names, latest.target)} response:`,
    describeActivityForSpeech(responseEvents(latest.cliOutput)),
    toSpeechText(latestText)
  );
}
