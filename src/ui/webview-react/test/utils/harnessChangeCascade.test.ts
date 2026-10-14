import { describe, expect, it } from "vitest";
import { INHERIT_DEFAULT_OPTION } from "@root/types/DashboardConstants";
import {
  buildHarnessChangeCascade,
  defaultModelForHarness,
} from "@utils/harnessChangeCascade";

describe("defaultModelForHarness", () => {
  const models = [
    { value: "opus", label: "Opus" },
    { value: "sonnet", label: "Sonnet" },
  ];

  it("prefers the user's default model when the harness offers it", () => {
    expect(
      defaultModelForHarness("claude-cli", { "claude-cli": "sonnet" }, models)
    ).toBe("sonnet");
  });

  it("falls back to the first model when the user's default is unavailable", () => {
    expect(
      defaultModelForHarness("claude-cli", { "claude-cli": "gone" }, models)
    ).toBe("opus");
  });

  it("returns undefined while the model list is loading", () => {
    expect(defaultModelForHarness("claude-cli", {}, [])).toBeUndefined();
  });
});

describe("buildHarnessChangeCascade", () => {
  it("clears harness companions when inheriting", () => {
    expect(buildHarnessChangeCascade(INHERIT_DEFAULT_OPTION)).toEqual({
      harness: undefined,
      model: undefined,
      additionalArgs: undefined,
    });
  });

  it("clears model and args overrides when picking a harness", () => {
    // Cleared, not seeded: the resolver gives a step on another harness that
    // harness's settings defaults, and the drawer labels them "Default (…)".
    expect(buildHarnessChangeCascade("codex-cli")).toEqual({
      harness: "codex-cli",
      model: undefined,
      additionalArgs: undefined,
    });
  });
});
