import { describe, expect, it } from "vitest";
import { STEP_STATUS } from "@root/types/DashboardConstants";
import type { PromptStep } from "@root/types/WebviewMessageTypes";
import { deriveCurrentStep } from "@components/shared/UndoRedoControl";
import {
  deriveCurrentStepFromRuntime,
  mergeRuntimeForUndoRedo,
} from "@hooks/useUndoRedoKeyHandler";

const noTurnStartedStep: PromptStep & { status: string } = {
  prompt: "step without a turn",
  status: STEP_STATUS.NO_TURN_STARTED,
  _runtime: {},
};

describe("undo/redo terminal step status", () => {
  it("keeps a restored no-turn-started status when merging runtime", () => {
    const [merged] = mergeRuntimeForUndoRedo([noTurnStartedStep], []);

    expect(merged.status).toBe(STEP_STATUS.NO_TURN_STARTED);
  });

  it("advances past a no-turn-started step in the runtime undo path", () => {
    expect(deriveCurrentStepFromRuntime([noTurnStartedStep])).toBe(1);
  });

  it("advances past a no-turn-started step in the control undo path", () => {
    expect(deriveCurrentStep([noTurnStartedStep])).toBe(1);
  });
});
