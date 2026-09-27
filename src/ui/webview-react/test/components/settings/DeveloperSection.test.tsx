import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

let profiler: typeof import("@utils/performanceProfiler") | undefined;

afterEach(() => {
  cleanup();
  window.__ctrlyokeStandalone = false;
  // The click below turns profiling on, which persists a localStorage flag and
  // starts a requestAnimationFrame loop; both outlive this file in a shared
  // (non-isolated) worker unless profiling is switched back off.
  profiler?.setProfilingEnabled(false);
  profiler = undefined;
});

describe("DeveloperSection profiler feedback", () => {
  it.each([
    ["panel", false, 0],
    ["standalone", true, 1],
  ] as const)(
    "adds %s toast entries when profiling is toggled",
    async (_host, standalone, expectedToastCount) => {
      vi.resetModules();
      window.__ctrlyokeStandalone = standalone;

      const [
        { DeveloperSection },
        { useSettingsStore },
        { useUiStore },
        loadedProfiler,
      ] = await Promise.all([
        import("@components/settings/DeveloperSection"),
        import("@store/settingsStore"),
        import("@store/uiStore"),
        import("@utils/performanceProfiler"),
      ]);
      profiler = loadedProfiler;

      profiler.setProfilingEnabled(false);
      useSettingsStore.getState().setDevStatus({
        enabled: true,
        buildDate: "2026-08-17T00:00:00.000Z",
        commands: {
          reloadWindow: true,
          restartExtensionHost: true,
        },
      });
      useUiStore.getState().resetUi();

      render(<DeveloperSection />);
      fireEvent.click(
        screen.getByRole("checkbox", {
          name: /^Enable performance profiling/,
        })
      );

      expect(useUiStore.getState().toastQueue).toHaveLength(expectedToastCount);
    }
  );
});
