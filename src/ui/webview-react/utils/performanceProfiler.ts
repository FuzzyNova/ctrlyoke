import type { ProfilerOnRenderCallback } from "react";
import { WebviewLog } from "@utils/logger";
import { BOOLEAN_STRING_VALUES } from "@root/types/DashboardConstants";

type PerformanceProfilerOptions = {
  slowThresholdMs?: number;
  logAllScrollFrames?: boolean;
  logLongFrames?: boolean;
  logMeasurements?: boolean;
  logVirtualRanges?: boolean;
  logScrollAttribution?: boolean;
};

type PerformanceProfilerState = Required<PerformanceProfilerOptions> & {
  enabled: boolean;
};

interface PerformanceProfiler {
  enable: (options?: PerformanceProfilerOptions) => void;
  disable: () => void;
  configure: (options: PerformanceProfilerOptions) => void;
  snapshot: () => PerformanceProfilerState;
}

declare global {
  interface Window {
    ctrlyokeProfiler?: PerformanceProfiler;
  }
}

const LOG_PREFIX = "[cy-perf]";
const STORAGE_KEY = "ctrlyoke.profiler.enabled";
const DEFAULT_STATE: PerformanceProfilerState = {
  enabled: false,
  slowThresholdMs: 200,
  logAllScrollFrames: false,
  logLongFrames: false,
  logMeasurements: false,
  logVirtualRanges: false,
  logScrollAttribution: false,
};

const state: PerformanceProfilerState = {
  ...DEFAULT_STATE,
  enabled: readEnabledFlag(),
};

let longFrameAnimationFrame: number | null = null;
let longFrameLastFrameAt: number | null = null;
let longTaskObserver: PerformanceObserver | null = null;

function readEnabledFlag(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return (
      window.localStorage.getItem(STORAGE_KEY) === BOOLEAN_STRING_VALUES.TRUE
    );
  } catch {
    return false;
  }
}

function writeEnabledFlag(enabled: boolean): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (enabled) {
      window.localStorage.setItem(STORAGE_KEY, "true");
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures; the current in-memory setting still applies.
  }
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeDetails(
  details?: Record<string, unknown>
): Record<string, unknown> {
  if (!details) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key,
      typeof value === "number" ? roundMs(value) : value,
    ])
  );
}

function log(label: string, details?: Record<string, unknown>): void {
  if (!state.enabled) {
    return;
  }

  WebviewLog.trace(
    `[performanceProfiler] ${LOG_PREFIX} ${label}`,
    normalizeDetails(details)
  );
}

function applyOptions(options: PerformanceProfilerOptions): void {
  if (options.slowThresholdMs != null) {
    state.slowThresholdMs = Math.max(0, options.slowThresholdMs);
  }
  if (options.logAllScrollFrames != null) {
    state.logAllScrollFrames = options.logAllScrollFrames;
  }
  if (options.logMeasurements != null) {
    state.logMeasurements = options.logMeasurements;
  }
  if (options.logVirtualRanges != null) {
    state.logVirtualRanges = options.logVirtualRanges;
  }
  if (options.logLongFrames != null) {
    state.logLongFrames = options.logLongFrames;
  }
  if (options.logScrollAttribution != null) {
    state.logScrollAttribution = options.logScrollAttribution;
  }
}

function stopLongFrameMonitor(): void {
  if (longFrameAnimationFrame != null) {
    cancelAnimationFrame(longFrameAnimationFrame);
    longFrameAnimationFrame = null;
  }
  longFrameLastFrameAt = null;
  longTaskObserver?.disconnect();
  longTaskObserver = null;
}

function logLongFrame(now: number): void {
  if (!state.enabled || !state.logLongFrames) {
    return;
  }

  if (longFrameLastFrameAt != null) {
    const gapMs = now - longFrameLastFrameAt;
    if (gapMs >= state.slowThresholdMs) {
      log("longFrame", {
        gapMs,
        visibilityState: document.visibilityState,
      });
    }
  }

  longFrameLastFrameAt = now;
  longFrameAnimationFrame = requestAnimationFrame(logLongFrame);
}

function startLongFrameMonitor(): void {
  stopLongFrameMonitor();
  if (typeof window === "undefined" || !state.enabled || !state.logLongFrames) {
    return;
  }

  longFrameAnimationFrame = requestAnimationFrame(logLongFrame);

  if (
    "PerformanceObserver" in window &&
    PerformanceObserver.supportedEntryTypes?.includes("longtask")
  ) {
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          log("longTask", {
            durationMs: entry.duration,
            startTime: entry.startTime,
            name: entry.name,
          });
        }
      });
      longTaskObserver.observe({ entryTypes: ["longtask"] });
    } catch {
      longTaskObserver = null;
    }
  }
}

function syncLongFrameMonitor(): void {
  if (state.enabled && state.logLongFrames) {
    startLongFrameMonitor();
  } else {
    stopLongFrameMonitor();
  }
}

export function isProfilingEnabled(): boolean {
  return state.enabled;
}

export function getProfilerState(): PerformanceProfilerState {
  return { ...state };
}

export function setProfilingEnabled(
  enabled: boolean,
  options?: PerformanceProfilerOptions
): PerformanceProfilerState {
  state.enabled = enabled;
  applyOptions(options ?? {});
  writeEnabledFlag(enabled);
  syncLongFrameMonitor();
  log(enabled ? "enabled" : "disabled", state);
  return { ...state };
}

export function configureProfiler(
  options: PerformanceProfilerOptions
): PerformanceProfilerState {
  applyOptions(options);
  syncLongFrameMonitor();
  log("configured", state);
  return { ...state };
}

/**
 * Times an arbitrary unit of work and logs it when it crosses the slow
 * threshold. Usable from any part of the webview — the `label` and `details`
 * identify the scope (e.g. "output:rowLayout", "editor:tokenize").
 */
export function measurePhase<T>(
  label: string,
  details: Record<string, unknown>,
  fn: () => T
): T {
  if (!state.enabled) {
    return fn();
  }

  const startedAt = performance.now();
  const result = fn();
  const durationMs = performance.now() - startedAt;
  if (durationMs >= state.slowThresholdMs) {
    log(label, { ...details, durationMs });
  }
  return result;
}

export function logProfilerEvent(
  label: string,
  details?: Record<string, unknown>
): void {
  log(label, details);
}

export function shouldLogMeasurement(durationMs: number): boolean {
  return (
    state.enabled &&
    (state.logMeasurements || durationMs >= state.slowThresholdMs)
  );
}

export function shouldLogVirtualRange(): boolean {
  return state.enabled && state.logVirtualRanges;
}

export function shouldLogScrollFrame(gapMs: number): boolean {
  return (
    state.enabled &&
    (state.logAllScrollFrames || gapMs >= state.slowThresholdMs)
  );
}

/**
 * Per-scroll-event attribution logging. `isRoutineVerdict` is true for the
 * high-volume "nothing of ours claimed it" case (`OUTPUT_SCROLL_VERDICTS.userScroll`)
 * — that verdict fires once per physical scroll event and was 68% of a 27-minute
 * session's log by itself, so it needs its own opt-in flag. The verdicts that
 * actually diagnose a settle-window bug (suppressed/programmatic/echo) are rare
 * by comparison and always log while profiling is on.
 */
export function shouldLogScrollAttribution(isRoutineVerdict: boolean): boolean {
  return state.enabled && (!isRoutineVerdict || state.logScrollAttribution);
}

/**
 * Builds a React `Profiler.onRender` callback that reports slow commits for
 * the wrapped subtree through the same gated channel as the rest of the
 * profiler. `getDetails` can supply scope-specific context (e.g. row counts,
 * overscan) that's resolved at render time.
 */
export function createProfilerRenderHandler(
  scopeId: string,
  getDetails?: () => Record<string, unknown>
): ProfilerOnRenderCallback {
  return (id, phase, actualDuration, baseDuration, startTime, commitTime) => {
    if (!state.enabled || actualDuration < state.slowThresholdMs) {
      return;
    }

    logProfilerEvent(scopeId, {
      id,
      phase,
      actualDuration,
      baseDuration,
      renderToCommitGap: commitTime - startTime,
      ...(getDetails ? getDetails() : {}),
    });
  };
}

export function installPerformanceProfiler(): void {
  if (typeof window === "undefined" || window.ctrlyokeProfiler) {
    return;
  }

  window.ctrlyokeProfiler = {
    enable: (options) => {
      setProfilingEnabled(true, options);
    },
    disable: () => {
      setProfilingEnabled(false);
    },
    configure: (options) => {
      configureProfiler(options);
    },
    snapshot: () => ({ ...state }),
  };
}
