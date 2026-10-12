import React, { useEffect, useState } from "react";
import { EXECUTION_STATES } from "@root/types/DashboardConstants";
import type { WorkflowSummary } from "@root/types/CtrlYokeTypes";
import {
  CLOCK_DURATION_TENTHS_BELOW_MS,
  formatClockDuration,
  formatSpokenDuration,
} from "../../utils/time";

/** Tooltip shared by every run-time display. */
export const RUN_DURATION_TITLE = "Run time (excludes pauses)";

/**
 * The phrase a settled run time contributes to a row's accessible name. Only
 * for settled values: a ticking one would re-announce the row every second.
 */
export function runDurationAccessibleLabel(
  durationMs: number | undefined
): string | undefined {
  return durationMs === undefined
    ? undefined
    : `run time ${formatSpokenDuration(durationMs)}`;
}

/** A run's active time: either settled, or still advancing from `tickingSince`. */
export interface RunDurationValue {
  durationMs: number;
  /**
   * Set while the run's clock is running: the time elapsed since this
   * timestamp is added to `durationMs`, re-rendered every second.
   */
  tickingSince?: number;
}

/** A persisted run time, or `undefined` when the run has none to show. */
export function settledRunDuration(
  durationMs: number | undefined
): RunDurationValue | undefined {
  return durationMs === undefined ? undefined : { durationMs };
}

/**
 * The live run time of an executing workflow, from its summary's pause-aware
 * sample. Ticks while running or pausing (a pause only stops the clock once it
 * is confirmed) and holds still while paused.
 */
export function liveRunDuration(
  summary: Pick<
    WorkflowSummary,
    | "executionState"
    | "executionTimeMs"
    | "executionTimeUpdatedAt"
    | "startedAt"
  >
): RunDurationValue {
  const isTicking =
    summary.executionState === EXECUTION_STATES.RUNNING ||
    summary.executionState === EXECUTION_STATES.PAUSING;
  if (summary.executionTimeMs !== undefined) {
    return {
      durationMs: summary.executionTimeMs,
      ...(isTicking && summary.executionTimeUpdatedAt !== undefined
        ? { tickingSince: summary.executionTimeUpdatedAt }
        : {}),
    };
  }
  // No pause-aware sample (e.g. an external runner's summary): fall back to
  // wall-clock time since the run started.
  if (summary.startedAt === undefined) {
    return { durationMs: 0 };
  }
  return isTicking
    ? { durationMs: 0, tickingSince: summary.startedAt }
    : { durationMs: Math.max(0, Date.now() - summary.startedAt) };
}

interface RunDurationProps extends RunDurationValue {
  className?: string;
}

/**
 * RunDuration - how long a run has executed, in the dashboard's one duration
 * format (`formatClockDuration`). Used by every surface that shows a run's
 * total time, so a running row's ticking clock and the settled value that row
 * shows once the run finishes always read the same way.
 */
export const RunDuration: React.FC<RunDurationProps> = ({
  durationMs,
  tickingSince,
  className = "",
}) => {
  const [now, setNow] = useState(() => Date.now());

  const elapsedMs =
    durationMs +
    (tickingSince !== undefined ? Math.max(0, now - tickingSince) : 0);
  // Under a minute the clock shows tenths, so it ticks at that resolution;
  // past it, once a second is all the display can change.
  const tickMs = elapsedMs < CLOCK_DURATION_TENTHS_BELOW_MS ? 100 : 1000;

  useEffect(() => {
    if (tickingSince === undefined) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(interval);
  }, [tickingSince, tickMs]);

  return (
    <span className={`font-mono ${className}`} title={RUN_DURATION_TITLE}>
      {formatClockDuration(elapsedMs)}
    </span>
  );
};
