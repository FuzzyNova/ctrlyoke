import { afterEach, describe, expect, it, vi } from "vitest";

const OPTIONS_STORAGE_KEY = "ctrlyoke.profiler.options";

async function loadProfiler() {
  vi.resetModules();
  return import("@utils/performanceProfiler");
}

afterEach(async () => {
  // Profiling starts a requestAnimationFrame loop and persists flags; switch
  // it off so neither outlives this file in the shared (non-isolated) worker.
  (await import("@utils/performanceProfiler")).setProfilingEnabled(false);
  window.localStorage.clear();
});

describe("performanceProfiler thresholds", () => {
  it("defaults the long-frame threshold above a 30 Hz frame interval", async () => {
    const profiler = await loadProfiler();
    const state = profiler.getProfilerState();
    expect(state.longFrameThresholdMs).toBe(50);
    expect(state.longFrameThresholdMs).not.toBe(state.slowThresholdMs);
  });

  it("restores configured thresholds after a reload", async () => {
    const first = await loadProfiler();
    first.setProfilingEnabled(true);
    first.configureProfiler({ longFrameThresholdMs: 80, slowThresholdMs: 12 });

    const reloaded = await loadProfiler();
    expect(reloaded.getProfilerState()).toMatchObject({
      enabled: true,
      longFrameThresholdMs: 80,
      slowThresholdMs: 12,
    });
  });

  it("ignores stored thresholds that are not finite numbers", async () => {
    window.localStorage.setItem(
      OPTIONS_STORAGE_KEY,
      JSON.stringify({ longFrameThresholdMs: "fast", slowThresholdMs: null })
    );
    const profiler = await loadProfiler();
    expect(profiler.getProfilerState()).toMatchObject({
      longFrameThresholdMs: 50,
      slowThresholdMs: 16,
    });
  });
});
