import { describe, expect, it } from "vitest";
import {
  HARNESS_CHART_COLORS,
  HARNESS_IDS,
  SCRIPT_STEP_DEFAULT_COLOR,
  STEP_COLOR_MODES,
  type HarnessId,
} from "@root/types/DashboardConstants";
import type { ParallelGroupDefinition } from "@root/types/CtrlYokeTypes";
import type { WorkflowStep } from "@store/workflowStore";
import {
  getStepPaletteHex,
  getInheritedStepColor,
  getUniqueStepColor,
  resolveStepColor,
  type StepColorGroupMember,
} from "@utils/stepColor";

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
        stepIndex: 0,
        stepColorMode: STEP_COLOR_MODES.HARNESS,
        settings: customSettings,
      })
    ).toBe("#123456");
    expect(
      resolveStepColor({
        step: { type: "script", script: "npm test" },
        stepIndex: 1,
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
        stepIndex: 0,
        settings: customSettings,
      })
    ).toBe("#abcdef");
  });

  it("uses the unique palette for a same-harness collision", () => {
    const firstStep: WorkflowStep = { prompt: "first" };
    const secondStep: WorkflowStep = { prompt: "second" };
    const groupMembers = [
      groupMember(firstStep, 0),
      groupMember(secondStep, 1),
    ];
    const firstColor = resolveStepColor({
      step: firstStep,
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      stepIndex: 4,
      group,
      offsetInGroup: 0,
      settings: customSettings,
      groupMembers,
    });

    expect(firstColor).toBe(getUniqueStepColor(4));
    expect(firstColor).not.toBe(
      customSettings.byHarness[HARNESS_IDS.CLAUDE_CLI]
    );
  });

  it("keeps an authored color above a parallel collision color", () => {
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
        stepIndex: 4,
        group,
        offsetInGroup: 0,
        settings: customSettings,
        groupMembers,
      })
    ).toBe("#abcdef");
  });

  it("disables identity colors in off mode", () => {
    expect(
      resolveStepColor({
        step: { prompt: "disabled" },
        harnessId: HARNESS_IDS.CLAUDE_CLI,
        stepIndex: 0,
        stepColorMode: STEP_COLOR_MODES.OFF,
        settings: customSettings,
      })
    ).toBeUndefined();
  });

  it("suppresses authored colors in off mode", () => {
    // `off` drops authored colors too, so the rail keeps meaning status alone.
    expect(
      resolveStepColor({
        step: { prompt: "authored", color: "#abcdef" },
        stepIndex: 0,
        stepColorMode: STEP_COLOR_MODES.OFF,
      })
    ).toBeUndefined();
  });

  it("uses the built-in harness color by default", () => {
    expect(
      resolveStepColor({
        step: { prompt: "Use Claude" },
        harnessId: HARNESS_IDS.CLAUDE_CLI,
        stepIndex: 0,
      })
    ).toBe(HARNESS_CHART_COLORS[HARNESS_IDS.CLAUDE_CLI]);
  });

  it("uses the neutral default for script steps", () => {
    expect(
      resolveStepColor({
        step: { type: "script", script: "npm test" },
        stepIndex: 0,
      })
    ).toBe(SCRIPT_STEP_DEFAULT_COLOR);
  });

  it("uses unique palette entries when group members share a harness color", () => {
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
      stepIndex: 4,
      group,
      offsetInGroup: 0,
      groupMembers,
    });
    const secondColor = resolveStepColor({
      step: secondStep,
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      stepIndex: 5,
      group,
      offsetInGroup: 1,
      groupMembers,
    });

    expect(firstColor).toBe(getUniqueStepColor(4));
    expect(secondColor).toBe(getUniqueStepColor(5));
    expect(firstColor).not.toBe(baseColor);
    expect(secondColor).not.toBe(baseColor);
    expect(secondColor).not.toBe(firstColor);
  });

  it("keeps a collision color stable when the group indices change", () => {
    const step: WorkflowStep = { prompt: "stable member" };
    const groupMembers = [
      groupMember(step, 1),
      groupMember({ prompt: "sibling" }, 0),
    ];
    const reorderedGroup = { ...group, startIndex: 20, endIndex: 21 };

    const originalColor = resolveStepColor({
      step,
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      stepIndex: 4,
      group,
      offsetInGroup: 1,
      groupMembers,
    });
    const reorderedColor = resolveStepColor({
      step,
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      stepIndex: 4,
      group: reorderedGroup,
      offsetInGroup: 1,
      groupMembers,
    });

    expect(reorderedColor).toBe(originalColor);
  });

  it("retains harness colors for a non-colliding mixed-harness group", () => {
    const firstStep: WorkflowStep = { prompt: "claude" };
    const secondStep: WorkflowStep = { prompt: "codex" };
    const groupMembers = [
      groupMember(firstStep, 0, HARNESS_IDS.CLAUDE_CLI),
      groupMember(secondStep, 1, HARNESS_IDS.CODEX_CLI),
    ];

    expect(
      resolveStepColor({
        step: firstStep,
        harnessId: HARNESS_IDS.CLAUDE_CLI,
        stepIndex: 4,
        group,
        offsetInGroup: 0,
        groupMembers,
      })
    ).toBe(HARNESS_CHART_COLORS[HARNESS_IDS.CLAUDE_CLI]);
    expect(
      resolveStepColor({
        step: secondStep,
        harnessId: HARNESS_IDS.CODEX_CLI,
        stepIndex: 5,
        group,
        offsetInGroup: 1,
        groupMembers,
      })
    ).toBe(HARNESS_CHART_COLORS[HARNESS_IDS.CODEX_CLI]);
  });

  it("does not tie-break a step outside a parallel group", () => {
    expect(
      resolveStepColor({
        step: { prompt: "sequential" },
        harnessId: HARNESS_IDS.CLAUDE_CLI,
        stepIndex: 0,
        groupMembers: [groupMember({ prompt: "sibling" }, 0)],
      })
    ).toBe(HARNESS_CHART_COLORS[HARNESS_IDS.CLAUDE_CLI]);
  });

  it("uses unique palette colors independently of harness settings", () => {
    expect(
      resolveStepColor({
        step: { prompt: "unique" },
        harnessId: HARNESS_IDS.CLAUDE_CLI,
        stepIndex: 2,
        stepColorMode: STEP_COLOR_MODES.UNIQUE,
        settings: customSettings,
      })
    ).toBe(getUniqueStepColor(2));

    expect(
      resolveStepColor({
        step: { prompt: "authored", color: "#abcdef" },
        harnessId: HARNESS_IDS.CLAUDE_CLI,
        stepIndex: 2,
        stepColorMode: STEP_COLOR_MODES.UNIQUE,
        settings: customSettings,
      })
    ).toBe("#abcdef");
  });

  it("wraps unique colors after the 24-slot palette", () => {
    expect(getUniqueStepColor(24)).toBe(getUniqueStepColor(0));
    expect(getStepPaletteHex(24, "light")).toBe(getStepPaletteHex(0, "light"));
  });

  it("uses the unique palette for the inherited color picker value", () => {
    expect(
      getInheritedStepColor(
        HARNESS_IDS.CLAUDE_CLI,
        customSettings,
        STEP_COLOR_MODES.UNIQUE,
        1
      )
    ).toBe(getStepPaletteHex(1));
  });

  it("uses the light palette when the theme is forwarded through the DOM", () => {
    const originalBodyClass = document.body.className;
    const originalThemeKind = document.documentElement.style.getPropertyValue(
      "--fp-color-theme-kind"
    );
    document.body.className = "vscode-light";
    document.documentElement.style.setProperty("--fp-color-theme-kind", "dark");

    try {
      expect(getStepPaletteHex(0)).toBe(getStepPaletteHex(0, "light"));
    } finally {
      document.body.className = originalBodyClass;
      if (originalThemeKind) {
        document.documentElement.style.setProperty(
          "--fp-color-theme-kind",
          originalThemeKind
        );
      } else {
        document.documentElement.style.removeProperty("--fp-color-theme-kind");
      }
    }
  });
});
