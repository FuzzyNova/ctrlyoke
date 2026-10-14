import { describe, expect, it } from "vitest";
import { HARNESS_IDS } from "@root/types/DashboardConstants";
import { harnessScopedFallbackLabel } from "@utils/harnessScopedFallback";

describe("harnessScopedFallbackLabel", () => {
  it("says Inherit when the step runs on the workflow's harness", () => {
    expect(
      harnessScopedFallbackLabel(
        HARNESS_IDS.CLAUDE_CLI,
        HARNESS_IDS.CLAUDE_CLI,
        "Sonnet"
      )
    ).toBe("Inherit (Sonnet)");
  });

  it("says Default when the step runs on another harness", () => {
    expect(
      harnessScopedFallbackLabel(
        HARNESS_IDS.ANTIGRAVITY_CLI,
        HARNESS_IDS.CLAUDE_CLI,
        "Gemini"
      )
    ).toBe("Default (Gemini)");
  });

  it("names both for a bulk selection across harnesses", () => {
    expect(
      harnessScopedFallbackLabel(null, HARNESS_IDS.CLAUDE_CLI, "Sonnet")
    ).toBe("Inherit / Default");
  });
});
