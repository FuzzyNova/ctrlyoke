import { describe, expect, it } from "vitest";
import { INHERIT_DEFAULT_OPTION } from "@root/types/DashboardConstants";
import { buildHarnessChangeCascade } from "@utils/harnessChangeCascade";

const defaults = {
  harnessDefaultModels: { "claude-cli": "sonnet", "codex-cli": "" },
  harnessDefaultAdditionalArgs: { "claude-cli": "--fast", "codex-cli": "" },
};

describe("buildHarnessChangeCascade", () => {
  it("clears harness companions when inheriting", () => {
    expect(buildHarnessChangeCascade(INHERIT_DEFAULT_OPTION, defaults)).toEqual(
      {
        harness: undefined,
        model: undefined,
        additionalArgs: undefined,
      }
    );
  });

  it("sets the harness defaults when available", () => {
    expect(buildHarnessChangeCascade("claude-cli", defaults)).toEqual({
      harness: "claude-cli",
      model: "sonnet",
      additionalArgs: "--fast",
    });
  });

  it("sets no model and explicitly clears args when defaults are absent", () => {
    expect(buildHarnessChangeCascade("codex-cli", defaults)).toEqual({
      harness: "codex-cli",
      model: undefined,
      additionalArgs: null,
    });
  });
});
