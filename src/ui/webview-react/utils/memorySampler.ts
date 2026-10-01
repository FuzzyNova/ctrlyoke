import { WebviewLog } from "@utils/logger";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import { useWorkflowStore } from "@store/workflowStore";

/**
 * Panel-side counterpart of the extension host's `MemoryWatchdog`: samples the
 * dashboard's memory into the session log (panel log lines are forwarded to
 * the extension's log file) so a renderer OOM leaves a trajectory.
 *
 * Two kinds of signal, because neither is enough alone:
 * - `performance.memory` (Chromium only; absent in Safari). Without
 *   `--enable-precise-memory-info` Chromium rounds it and refreshes it only
 *   occasionally, so a flat heap reading is not proof the heap is flat.
 * - Exact counts of what the stores hold (output entries, activity entries,
 *   streaming text), which grow with the run regardless of what the heap API
 *   reports.
 *
 * A line is logged at start and then only when either signal moves enough,
 * together with the heavy messages received since the previous line.
 */

const SAMPLE_INTERVAL_MS = 15_000;
const HEAP_DELTA_BYTES = 50 * 1024 * 1024;
const ENTRY_DELTA = 500;
const STREAMING_DELTA_CHARS = 5 * 1024 * 1024;
const MAX_ACTIVITIES = 12;

/** Messages that carry whole run views or histories and are worth naming. */
const HEAVY_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  MESSAGE_TYPES.RUN_VIEW_LOADED,
  MESSAGE_TYPES.OUTPUT_HISTORY_LOADED,
  MESSAGE_TYPES.SESSION_RESTORED,
]);

interface ChromiumMemoryInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

interface PanelMemorySample {
  heapUsed?: number;
  heapTotal?: number;
  heapLimit?: number;
  liveEntries: number;
  liveActivityEntries: number;
  historyEntries: number;
  historyActivityEntries: number;
  streamingChars: number;
}

const activities: Array<{ at: number; label: string }> = [];
let lastLogged: { sample: PanelMemorySample; at: number } | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

function toMb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

function formatTime(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(11, 19);
}

function readChromiumMemory(): ChromiumMemoryInfo | undefined {
  const memory = (performance as Performance & { memory?: ChromiumMemoryInfo })
    .memory;
  return memory && typeof memory.usedJSHeapSize === "number"
    ? memory
    : undefined;
}

function countChars(chunks: Record<string, string>): number {
  let total = 0;
  for (const chunk of Object.values(chunks)) total += chunk.length;
  return total;
}

function takeSample(): PanelMemorySample {
  const state = useWorkflowStore.getState();
  const memory = readChromiumMemory();
  return {
    heapUsed: memory?.usedJSHeapSize,
    heapTotal: memory?.totalJSHeapSize,
    heapLimit: memory?.jsHeapSizeLimit,
    liveEntries: state.liveOrderedEntries.length,
    liveActivityEntries: state.liveActivityEntries.length,
    historyEntries: state.historyOutputs?.orderedEntries.length ?? 0,
    historyActivityEntries: state.historyOutputs?.activityEntries?.length ?? 0,
    streamingChars:
      countChars(state.streamingChunks) +
      countChars(state.finalStepStreamingChunks),
  };
}

function movedEnough(
  current: PanelMemorySample,
  previous: PanelMemorySample
): boolean {
  const heapMoved =
    current.heapUsed !== undefined &&
    previous.heapUsed !== undefined &&
    Math.abs(current.heapUsed - previous.heapUsed) >= HEAP_DELTA_BYTES;
  const entries = (sample: PanelMemorySample) =>
    sample.liveEntries +
    sample.liveActivityEntries +
    sample.historyEntries +
    sample.historyActivityEntries;
  return (
    heapMoved ||
    Math.abs(entries(current) - entries(previous)) >= ENTRY_DELTA ||
    Math.abs(current.streamingChars - previous.streamingChars) >=
      STREAMING_DELTA_CHARS
  );
}

function logSample(sample: PanelMemorySample, at: number): void {
  const previous = lastLogged;
  const heap =
    sample.heapUsed === undefined
      ? "heap=unavailable"
      : `heapUsed=${toMb(sample.heapUsed)}MB` +
        (previous?.sample.heapUsed !== undefined
          ? ` (${sample.heapUsed >= previous.sample.heapUsed ? "+" : ""}${toMb(sample.heapUsed - previous.sample.heapUsed)}MB since ${formatTime(previous.at)})`
          : ` (baseline, heapLimit=${toMb(sample.heapLimit ?? 0)}MB)`) +
        ` heapTotal=${toMb(sample.heapTotal ?? 0)}MB`;
  const since = previous?.at ?? 0;
  const noted = activities
    .filter((activity) => activity.at >= since)
    .map((activity) => `${formatTime(activity.at)} ${activity.label}`);
  WebviewLog.info(
    `[PanelMemory] ${heap} liveEntries=${sample.liveEntries} liveActivity=${sample.liveActivityEntries} historyEntries=${sample.historyEntries} historyActivity=${sample.historyActivityEntries} streamingChars=${sample.streamingChars}` +
      (noted.length > 0 ? ` | activity: ${noted.join("; ")}` : "")
  );
  lastLogged = { sample, at };
}

function sampleNow(): void {
  const sample = takeSample();
  if (!lastLogged || movedEnough(sample, lastLogged.sample)) {
    logSample(sample, Date.now());
  }
}

/**
 * Record a received message if it is one of the heavy ones. Counts come from
 * the payload's arrays; serializing it to measure bytes would itself allocate
 * a second copy of the very payload under suspicion.
 */
export function notePanelMessage(message: {
  type?: unknown;
  history?: { orderedEntries?: unknown[]; activityEntries?: unknown[] };
}): void {
  if (typeof message.type !== "string") return;
  if (!HEAVY_MESSAGE_TYPES.has(message.type)) return;
  const history = message.history;
  activities.push({
    at: Date.now(),
    label: `${message.type} historyEntries=${history?.orderedEntries?.length ?? 0} historyActivity=${history?.activityEntries?.length ?? 0}`,
  });
  if (activities.length > MAX_ACTIVITIES) activities.shift();
}

/** Start sampling; idempotent. Returns a stop function. */
export function startPanelMemorySampler(): () => void {
  if (timer === undefined) {
    sampleNow();
    timer = setInterval(sampleNow, SAMPLE_INTERVAL_MS);
  }
  return () => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
