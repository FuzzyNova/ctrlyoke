import { afterEach, describe, expect, it } from "vitest";
import { buildStepMetadataClipboardText } from "@utils/stepMetadataClipboard";
import type { WorkflowStep } from "@store/workflowStore";
import { useSettingsStore } from "@store/settingsStore";

const originalSettings = useSettingsStore.getState();

afterEach(() => {
  useSettingsStore.setState(originalSettings, true);
});

describe("buildStepMetadataClipboardText prior context", () => {
  it("formats previous-count and run-source objects", () => {
    const previousCount = buildStepMetadataClipboardText({
      step: { prompt: "prompt", priorContext: { previous: 3 } } as WorkflowStep,
      slotNumber: 1,
    });
    const runSource = buildStepMetadataClipboardText({
      step: {
        prompt: "prompt",
        priorContext: { workflow: "workflow-1", run: 2 },
      } as WorkflowStep,
      slotNumber: 1,
    });

    expect(previousCount).toContain("priorContext: Previous 3");
    expect(runSource).toContain("priorContext: Completed run output");
  });

  it("uses live context telemetry while the step is rerunning", () => {
    const text = buildStepMetadataClipboardText({
      step: { prompt: "prompt" } as WorkflowStep,
      slotNumber: 1,
      isCurrent: true,
      latestOutput: {
        tokens: { contextWindowUsed: 20_000, contextWindowSize: 100_000 },
      } as never,
      liveContextWindow: { used: 40_000, size: 200_000 },
    });

    expect(text).toContain("Current context window: 40k/200k (20%)");
    expect(text).not.toContain("Current context window: 20k/100k (20%)");
  });

  it("formats the duration like the step header", () => {
    const text = buildStepMetadataClipboardText({
      step: { prompt: "prompt" } as WorkflowStep,
      slotNumber: 1,
      latestOutput: { elapsed: 150 } as never,
    });

    expect(text).toContain("Duration: 2:30");
  });

  it("keeps workflow None when global sandbox is On", () => {
    const state = useSettingsStore.getState();
    useSettingsStore.setState({
      workflowProperties: { ...state.workflowProperties, sandbox: null },
      globalSettings: { ...state.globalSettings, sandbox: true },
    } as never);

    const text = buildStepMetadataClipboardText({
      step: { prompt: "prompt" } as WorkflowStep,
      slotNumber: 1,
    });

    expect(text).toContain("sandbox: None (inherited)");
    expect(text).not.toContain("sandbox: On (inherited)");
  });

  it("labels step None without calling it disabled", () => {
    const text = buildStepMetadataClipboardText({
      step: { prompt: "prompt", sandbox: null } as WorkflowStep,
      slotNumber: 1,
    });

    expect(text).toContain("sandbox: None");
    expect(text).not.toContain("sandbox: (none) — explicitly disabled");
  });
});
