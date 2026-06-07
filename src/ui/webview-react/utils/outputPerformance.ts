import { WebviewLog } from "@utils/logger";

type OutputProfilerOptions = {
  slowThresholdMs?: number;
  logAllScrollFrames?: boolean;
  logLongFrames?: boolean;
  logMeasurements?: boolean;
  logVirtualRanges?: boolean;
};

type OutputProfilerState = Required<OutputProfilerOptions> & {
  enabled: boolean;
};

export interface OutputPerformanceProfiler {
  enable: (options?: OutputProfilerOptions) => void;
  disable: () => void;
  configure: (options: OutputProfilerOptions) => void;
  snapshot: () => OutputProfilerState;
}

declare global {
  interface Window {
    flightpathOutputProfiler?: OutputPerformanceProfiler;
  }
}

const STORAGE_KEY = "flightpath.outputProfiler.enabled";
const DEFAULT_STATE: OutputProfilerState = {
  enabled: false,
  slowThresholdMs: 16,
  logAllScrollFrames: false,
  logLongFrames: false,
  logMeasurements: false,
  logVirtualRanges: false,
};

const state: OutputProfilerState = {
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
    return window.localStorage.getItem(STORAGE_KEY) === "true";
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

  WebviewLog.debug(
    `[FP-out] ${label}`,
    normalizeDetails(details)
  );
}

function applyOptions(options: OutputProfilerOptions): void {
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
  if (
    typeof window === "undefined" ||
    !state.enabled ||
    !state.logLongFrames
  ) {
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

export function isOutputProfilingEnabled(): boolean {
  return state.enabled;
}

export function getOutputProfilerState(): OutputProfilerState {
  return { ...state };
}

export function setOutputProfilingEnabled(
  enabled: boolean,
  options?: OutputProfilerOptions
): OutputProfilerState {
  state.enabled = enabled;
  applyOptions(options ?? {});
  writeEnabledFlag(enabled);
  syncLongFrameMonitor();
  log(enabled ? "enabled" : "disabled", state);
  return { ...state };
}

export function configureOutputProfiler(
  options: OutputProfilerOptions
): OutputProfilerState {
  applyOptions(options);
  syncLongFrameMonitor();
  log("configured", state);
  return { ...state };
}

export function measureOutputPhase<T>(
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

export function logOutputProfilerEvent(
  label: string,
  details?: Record<string, unknown>
): void {
  log(label, details);
}

export function shouldLogOutputMeasurement(durationMs: number): boolean {
  return (
    state.enabled &&
    (state.logMeasurements || durationMs >= state.slowThresholdMs)
  );
}

export function shouldLogOutputVirtualRange(): boolean {
  return state.enabled && state.logVirtualRanges;
}

export function shouldLogOutputScrollFrame(gapMs: number): boolean {
  return (
    state.enabled &&
    (state.logAllScrollFrames || gapMs >= state.slowThresholdMs)
  );
}

export function installOutputPerformanceProfiler(): void {
  if (typeof window === "undefined" || window.flightpathOutputProfiler) {
    return;
  }

  window.flightpathOutputProfiler = {
    enable: (options) => {
      setOutputProfilingEnabled(true, options);
    },
    disable: () => {
      setOutputProfilingEnabled(false);
    },
    configure: (options) => {
      configureOutputProfiler(options);
    },
    snapshot: () => ({ ...state }),
  };
}
