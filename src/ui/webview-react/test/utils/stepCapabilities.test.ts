import { describe, expect, it } from "vitest";
import {
  EXECUTION_STATES,
  PROMPT_TERMINAL_STATUS,
  STEP_TYPES,
} from "@root/types/DashboardConstants";
import type { ParallelGroupDefinition } from "@root/types/CtrlYokeTypes";
import type { WorkflowStep } from "@store/workflowStore";
import {
  getSelectionCapabilities,
  getStepCapabilities,
  isStepExecutionLocked,
} from "@utils/stepCapabilities";

const prompt: WorkflowStep = { prompt: "Prompt" };
const script: WorkflowStep = {
  type: STEP_TYPES.SCRIPT,
  script: "echo ok",
};
const defaultContext = {
  currentStep: 0,
  executionState: EXECUTION_STATES.IDLE,
  totalSteps: 2,
};
const completedPrompt = (): WorkflowStep => ({
  ...prompt,
  _runtime: {
    completedAt: Date.now(),
    terminalStatus: PROMPT_TERMINAL_STATUS.COMPLETED,
  } as unknown as WorkflowStep["_runtime"],
});

describe("stepCapabilities", () => {
  it("matches each row of the goal capability matrix", () => {
    expect(
      getSelectionCapabilities([0, 1], [prompt, { ...prompt }], defaultContext)
    ).toEqual({
      canEditColor: true,
      canToggleEnabled: true,
      canDelete: true,
      canReorder: true,
      canEditPromptProperties: true,
    });
    expect(
      getSelectionCapabilities([0, 1], [prompt, script], defaultContext)
    ).toEqual({
      canEditColor: true,
      canToggleEnabled: true,
      canDelete: true,
      canReorder: true,
      canEditPromptProperties: false,
    });
    const completed = completedPrompt();
    expect(
      getSelectionCapabilities([0, 1], [completed, prompt], defaultContext)
    ).toEqual({
      canEditColor: true,
      canToggleEnabled: false,
      canDelete: false,
      canReorder: false,
      canEditPromptProperties: false,
    });
    expect(getStepCapabilities(script, 1, defaultContext).canEditColor).toBe(
      true
    );
    expect(
      getStepCapabilities(script, 1, defaultContext).canEditPromptProperties
    ).toBe(false);
  });

  it("locks completed and running prefixes and terminal steps", () => {
    const completed = completedPrompt();
    expect(
      getStepCapabilities(prompt, 0, {
        ...defaultContext,
        currentStep: 1,
        executionState: EXECUTION_STATES.RUNNING,
      }).canDelete
    ).toBe(false);
    expect(
      getStepCapabilities(completed, 1, defaultContext).canToggleEnabled
    ).toBe(false);
    expect(
      isStepExecutionLocked(completed, 1, 1, EXECUTION_STATES.RUNNING)
    ).toBe(true);
    expect(
      isStepExecutionLocked(completed, 0, 1, EXECUTION_STATES.PAUSED)
    ).toBe(false);
  });

  it("locks the preserved prefix while a rewind is pending", () => {
    const ctx = { ...defaultContext, pendingRewindBoundary: 1 };
    expect(getStepCapabilities(prompt, 0, ctx).canDelete).toBe(false);
    expect(getStepCapabilities(prompt, 1, ctx).canDelete).toBe(true);
  });

  it("disables selection reorder when any selected step belongs to a parallel group", () => {
    const groups: ParallelGroupDefinition[] = [
      { id: "group", startIndex: 1, endIndex: 1, failFast: true },
    ];
    expect(
      getSelectionCapabilities([0, 2], [prompt, prompt, prompt], {
        ...defaultContext,
        totalSteps: 3,
        parallelGroups: groups,
      }).canReorder
    ).toBe(true);
    expect(
      getSelectionCapabilities([0, 1], [prompt, prompt, prompt], {
        ...defaultContext,
        totalSteps: 3,
        parallelGroups: groups,
      }).canReorder
    ).toBe(false);
  });
});
