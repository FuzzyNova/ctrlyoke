import { describe, expect, it } from "vitest";
import { CONDITION_ACTIONS, STEP_TYPES } from "@root/types/DashboardConstants";
import { getSubWorkflowStepPropertyUpdate } from "@utils/subWorkflowStepProperties";

const DEFAULTS = {
  onFail: CONDITION_ACTIONS.STOP_WORKFLOW,
  color: undefined,
  enabled: true,
  promptName: "",
} as const;

describe("getSubWorkflowStepPropertyUpdate", () => {
  it("sends only the kind and clears every field at its default", () => {
    expect(getSubWorkflowStepPropertyUpdate(DEFAULTS)).toEqual({
      properties: { type: STEP_TYPES.WORKFLOW },
      clearProperties: ["onFail", "color", "enabled", "name"],
    });
  });

  it("sends the fields the editor overrides", () => {
    expect(
      getSubWorkflowStepPropertyUpdate({
        onFail: CONDITION_ACTIONS.CONTINUE,
        color: "#6b8e23",
        enabled: false,
        promptName: "Verify",
      })
    ).toEqual({
      properties: {
        type: STEP_TYPES.WORKFLOW,
        onFail: CONDITION_ACTIONS.CONTINUE,
        color: "#6b8e23",
        enabled: false,
      },
      clearProperties: [],
    });
  });

  it("keeps an authored onFail placeholder as written", () => {
    const { properties, clearProperties } = getSubWorkflowStepPropertyUpdate({
      ...DEFAULTS,
      onFail: "{{onFail}}",
    });
    expect(properties.onFail).toBe("{{onFail}}");
    expect(clearProperties).not.toContain("onFail");
  });
});
