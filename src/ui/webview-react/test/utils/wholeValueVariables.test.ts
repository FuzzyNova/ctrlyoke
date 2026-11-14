import { describe, expect, it } from "vitest";
import { PROMPT_PROPERTIES } from "@root/types/DashboardConstants";
import { holdsValueFieldPlaceholder } from "@/utils/wholeValueVariables";

describe("holdsValueFieldPlaceholder", () => {
  it("finds a whole-value placeholder in a top-level value field", () => {
    expect(
      holdsValueFieldPlaceholder(PROMPT_PROPERTIES.MAX_STEPS, "{{steps}}")
    ).toBe(true);
    expect(
      holdsValueFieldPlaceholder(PROMPT_PROPERTIES.EXECUTION_MODE, "{{mode}}")
    ).toBe(true);
  });

  it("finds a placeholder in a nested value field", () => {
    expect(
      holdsValueFieldPlaceholder(PROMPT_PROPERTIES.ERROR_BEHAVIOR, {
        onError: "{{onError}}",
      })
    ).toBe(true);
  });

  it("ignores typed values and text fields", () => {
    expect(holdsValueFieldPlaceholder(PROMPT_PROPERTIES.MAX_STEPS, 10)).toBe(
      false
    );
    expect(
      holdsValueFieldPlaceholder(PROMPT_PROPERTIES.ERROR_BEHAVIOR, {
        onError: "retry",
      })
    ).toBe(false);
    expect(
      holdsValueFieldPlaceholder(PROMPT_PROPERTIES.MODEL, "{{model}}")
    ).toBe(false);
  });
});
