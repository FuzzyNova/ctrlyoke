import { describe, expect, it } from "vitest";
import {
  HARNESS_CHART_COLORS,
  HARNESS_IDS,
  SCRIPT_STEP_DEFAULT_COLOR,
  STEP_COLOR_MODES,
  STEP_COLOR_TIE_BREAK_PALETTE,
  type HarnessId,
} from "@root/types/DashboardConstants";
import type { ParallelGroupDefinition } from "@root/types/CtrlYokeTypes";
import type { WorkflowStep } from "@store/workflowStore";
import { resolveStepColor, type StepColorGroupMember } from "@utils/stepColor";

const group: ParallelGroupDefinition = {
  id: "stable-group-id",
  startIndex: 4,
  endIndex: 5,
  failFast: true,
};

function groupMember(
  step: WorkflowStep,
  offsetInGroup: number,
  harnessId: HarnessId = HARNESS_IDS.CLAUDE_CLI
): StepColorGroupMember {
  return { step, harnessId, offsetInGroup };
}

describe("resolveStepColor", () => {
  const customSettings = {
    byHarness: { [HARNESS_IDS.CLAUDE_CLI]: "#123456" },
    script: "#654321",
  };

  it("uses harness mode with the existing harness and script behavior", () => {
    expect(
      resolveStepColor({
        step: { prompt: "Use Claude" },
        harnessId: HARNESS_IDS.CLAUDE_CLI,
        stepColorMode: STEP_COLOR_MODES.HARNESS,
        settings: customSettings,
      })
    ).toBe("#123456");
    expect(
      resolveStepColor({
        step: { type: "script", script: "npm test" },
        stepColorMode: STEP_COLOR_MODES.HARNESS,
        settings: customSettings,
      })
    ).toBe("#654321");
  });

  it("keeps authored colors above settings overrides", () => {
    expect(
      resolveStepColor({
        step: { prompt: "authored", color: "#abcdef" },
        harnessId: HARNESS_IDS.CLAUDE_CLI,
        settings: customSettings,
      })
    ).toBe("#abcdef");
  });

  it("keeps tie-break colors above a matching harness override", () => {
    const firstStep: WorkflowStep = { prompt: "first" };
    const secondStep: WorkflowStep = { prompt: "second" };
    const groupMembers = [
      groupMember(firstStep, 0),
      groupMember(secondStep, 1),
    ];
    const firstColor = resolveStepColor({
      step: firstStep,
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      group,
      offsetInGroup: 0,
      settings: customSettings,
      groupMembers,
    });

    expect(STEP_COLOR_TIE_BREAK_PALETTE).toContain(firstColor);
    expect(firstColor).not.toBe(
      customSettings.byHarness[HARNESS_IDS.CLAUDE_CLI]
    );
  });

  it("keeps an authored color above a parallel tie-break", () => {
    const authoredStep: WorkflowStep = {
      prompt: "authored member",
      color: "#abcdef",
    };
    const sibling: WorkflowStep = { prompt: "sibling" };
    const groupMembers = [
      groupMember(authoredStep, 0),
      groupMember(sibling, 1),
    ];

    expect(
      resolveStepColor({
        step: authoredStep,
        harnessId: HARNESS_IDS.CLAUDE_CLI,
        group,
        offsetInGroup: 0,
        settings: customSettings,
        groupMembers,
      })
    ).toBe("#abcdef");
  });

  it("disables identity colors in off mode, including authored colors", () => {
    expect(
      resolveStepColor({
        step: { prompt: "disabled", color: "#abcdef" },
        harnessId: HARNESS_IDS.CLAUDE_CLI,
        stepColorMode: STEP_COLOR_MODES.OFF,
        settings: customSettings,
      })
    ).toBeUndefined();
  });

  it("uses the built-in harness color by default", () => {
    expect(
      resolveStepColor({
        step: { prompt: "Use Claude" },
        harnessId: HARNESS_IDS.CLAUDE_CLI,
      })
    ).toBe(HARNESS_CHART_COLORS[HARNESS_IDS.CLAUDE_CLI]);
  });

  it("uses the neutral default for script steps", () => {
    expect(
      resolveStepColor({
        step: { type: "script", script: "npm test" },
      })
    ).toBe(SCRIPT_STEP_DEFAULT_COLOR);
  });

  it("uses stable palette entries when group members share a harness color", () => {
    const firstStep: WorkflowStep = { prompt: "first" };
    const secondStep: WorkflowStep = { prompt: "second" };
    const groupMembers = [
      groupMember(firstStep, 0),
      groupMember(secondStep, 1),
    ];
    const baseColor = HARNESS_CHART_COLORS[HARNESS_IDS.CLAUDE_CLI];

    const firstColor = resolveStepColor({
      step: firstStep,
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      group,
      offsetInGroup: 0,
      groupMembers,
    });
    const secondColor = resolveStepColor({
      step: secondStep,
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      group,
      offsetInGroup: 1,
      groupMembers,
    });

    expect(STEP_COLOR_TIE_BREAK_PALETTE).toContain(firstColor);
    expect(STEP_COLOR_TIE_BREAK_PALETTE).toContain(secondColor);
    expect(firstColor).not.toBe(baseColor);
    expect(secondColor).not.toBe(baseColor);
    expect(secondColor).not.toBe(firstColor);
  });

  it("keeps a tie-break color stable when the group indices change", () => {
    const step: WorkflowStep = { prompt: "stable member" };
    const groupMembers = [
      groupMember(step, 1),
      groupMember({ prompt: "sibling" }, 0),
    ];
    const reorderedGroup = { ...group, startIndex: 20, endIndex: 21 };

    const originalColor = resolveStepColor({
      step,
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      group,
      offsetInGroup: 1,
      groupMembers,
    });
    const reorderedColor = resolveStepColor({
      step,
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      group: reorderedGroup,
      offsetInGroup: 1,
      groupMembers,
    });

    expect(reorderedColor).toBe(originalColor);
  });

  it("does not tie-break a step outside a parallel group", () => {
    expect(
      resolveStepColor({
        step: { prompt: "sequential" },
        harnessId: HARNESS_IDS.CLAUDE_CLI,
        groupMembers: [groupMember({ prompt: "sibling" }, 0)],
      })
    ).toBe(HARNESS_CHART_COLORS[HARNESS_IDS.CLAUDE_CLI]);
  });
});
