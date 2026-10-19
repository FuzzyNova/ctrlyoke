import {
  EXECUTION_PHASES,
  FINAL_STEP_PHASES,
} from "../../types/DashboardConstants";
import type {
  OutputExecutionTarget,
  WorkspaceSnapshot,
} from "../../types/OutputHistoryTypes";
import type { RunBundleEvent } from "../../types/RunBundleTypes";
import type { CliEvent, CliOutput } from "../../types/WebviewMessageTypes";
import {
  TIMELINE_ATTEMPT_KINDS,
  TIMELINE_ATTEMPT_TERMINAL_STATES,
  TIMELINE_EVENT_TYPES,
  type TimelineAttemptTerminalState,
} from "../../types/WorkflowTimelineTypes";

/**
 * What a replay plays back, cut out of a run bundle's timeline: each AI
 * attempt's streamed output with its timing, and each script's result. The
 * engine produces everything else itself (statuses, retries, snapshots).
 */

/** One streamed delivery, `offsetMs` after its attempt started. */
export interface RecordedStreamItem {
  offsetMs: number;
  sequence: number;
  events?: CliEvent[];
  chunk?: string;
}

export interface RecordedAiAttempt {
  target: OutputExecutionTarget;
  attemptIndex: number;
  startedAt: number;
  durationMs: number;
  items: RecordedStreamItem[];
  /** The sealed output; its `structured` is what the harness parsed. */
  finalOutput?: CliOutput;
  terminalState: TimelineAttemptTerminalState;
  /** The workspace as this attempt left it, when the bundle has snapshots. */
  snapshot?: WorkspaceSnapshot;
}

export interface RecordedScript {
  command: string;
  stdout: string;
  stderr: string;
  exitCode?: number;
  durationMs: number;
  sequence: number;
}

export interface ReplayScript {
  /** AI attempts per target, in the order they ran. */
  attempts: Map<string, RecordedAiAttempt[]>;
  /** Conditions and script steps, in the order they ran. */
  scripts: RecordedScript[];
}

export function replayTargetKey(target: OutputExecutionTarget): string {
  return target.kind === FINAL_STEP_PHASES.QUEUE
    ? `${FINAL_STEP_PHASES.QUEUE}:${target.stepIndex}`
    : FINAL_STEP_PHASES.FINAL_STEP;
}

type TargetedEvent = Extract<RunBundleEvent, { target: OutputExecutionTarget }>;

function attemptKey(event: TargetedEvent): string {
  const indexed = event as TargetedEvent & {
    runIndex?: number;
    attemptIndex?: number;
    phase?: string;
  };
  return [
    replayTargetKey(event.target),
    indexed.runIndex ?? 0,
    indexed.attemptIndex ?? 0,
    indexed.phase ?? EXECUTION_PHASES.PROMPT,
  ].join("|");
}

export function buildReplayScript(
  events: readonly RunBundleEvent[]
): ReplayScript {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  const aiByKey = new Map<string, RecordedAiAttempt>();
  const scriptStarts = new Map<string, number>();
  const attempts = new Map<string, RecordedAiAttempt[]>();
  const scripts: RecordedScript[] = [];

  for (const event of ordered) {
    switch (event.eventType) {
      case TIMELINE_EVENT_TYPES.ATTEMPT_STARTED: {
        const key = attemptKey(event);
        if (event.payload.kind !== TIMELINE_ATTEMPT_KINDS.AI) {
          scriptStarts.set(key, event.timestampMs);
          break;
        }
        const attempt: RecordedAiAttempt = {
          target: event.target,
          attemptIndex: event.attemptIndex,
          startedAt: event.timestampMs,
          durationMs: 0,
          items: [],
          terminalState: TIMELINE_ATTEMPT_TERMINAL_STATES.COMPLETED,
        };
        aiByKey.set(key, attempt);
        const targetKey = replayTargetKey(event.target);
        attempts.set(targetKey, [...(attempts.get(targetKey) ?? []), attempt]);
        break;
      }
      case TIMELINE_EVENT_TYPES.CLI_OUTPUT_EVENTS_APPENDED:
      case TIMELINE_EVENT_TYPES.CLI_OUTPUT_CHUNK_APPENDED: {
        const attempt = aiByKey.get(attemptKey(event));
        if (!attempt) break;
        attempt.items.push({
          offsetMs: Math.max(0, event.timestampMs - attempt.startedAt),
          sequence: event.sequence,
          ...(event.eventType ===
          TIMELINE_EVENT_TYPES.CLI_OUTPUT_EVENTS_APPENDED
            ? { events: event.payload.events }
            : { chunk: event.payload.chunk }),
        });
        break;
      }
      case TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED: {
        const attempt = aiByKey.get(attemptKey(event));
        if (attempt && !event.payload.cliOutput.isStreaming) {
          attempt.finalOutput = event.payload.cliOutput;
        }
        break;
      }
      case TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED: {
        const attempt = aiByKey.get(attemptKey(event));
        if (!attempt) break;
        attempt.durationMs = Math.max(0, event.timestampMs - attempt.startedAt);
        attempt.terminalState = event.payload.terminalState;
        break;
      }
      case TIMELINE_EVENT_TYPES.SCRIPT_EXECUTION_RECORDED: {
        const startedAt =
          scriptStarts.get(attemptKey(event)) ?? event.timestampMs;
        scripts.push({
          command: event.payload.command,
          stdout: event.payload.stdout,
          stderr: event.payload.stderr,
          ...(event.payload.exitCode !== undefined
            ? { exitCode: event.payload.exitCode }
            : {}),
          durationMs: Math.max(0, event.timestampMs - startedAt),
          sequence: event.sequence,
        });
        break;
      }
      case TIMELINE_EVENT_TYPES.WORKSPACE_SNAPSHOT_CAPTURED: {
        // A snapshot is captured after its target's attempt: give it to the
        // latest AI attempt of that target.
        const latest = attempts.get(replayTargetKey(event.target))?.at(-1);
        if (latest) latest.snapshot = event.payload.workspaceSnapshot;
        break;
      }
      default:
        break;
    }
  }
  return { attempts, scripts };
}

/**
 * Moves recorded event timestamps onto the replay's clock: the recorded
 * attempt start maps to `replayStartedAt`, later times scale by `speed`.
 */
export function retimeEvents(
  events: readonly CliEvent[],
  recordedStartedAt: number,
  replayStartedAt: number,
  speed: number
): CliEvent[] {
  return events.map((event) =>
    typeof event.timestamp === "number"
      ? {
          ...event,
          timestamp: Math.round(
            replayStartedAt +
              scaleDelay(event.timestamp - recordedStartedAt, speed)
          ),
        }
      : event
  );
}

/** A recorded delay at `speed`; speed 0 means no waiting at all. */
export function scaleDelay(delayMs: number, speed: number): number {
  return speed > 0 ? Math.max(0, delayMs) / speed : 0;
}
