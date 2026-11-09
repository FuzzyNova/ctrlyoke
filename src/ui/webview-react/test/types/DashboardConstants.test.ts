import { describe, expect, it } from "vitest";
import { workflowSandboxModeVisible } from "@root/types/DashboardConstants";

describe("workflowSandboxModeVisible", () => {
  it("shows the control for an enabled sandbox, an authored workflow mode, or an inheriting prompt step", () => {
    expect(workflowSandboxModeVisible(true, undefined, [])).toBe(true);
    expect(workflowSandboxModeVisible(false, "read-only", [])).toBe(true);
    expect(
      workflowSandboxModeVisible(false, undefined, [
        { prompt: "build", sandbox: true },
      ])
    ).toBe(true);
  });

  it("ignores scripts and prompt steps with their own mode when workflow sandbox is Off", () => {
    expect(
      workflowSandboxModeVisible(false, undefined, [
        { prompt: "build", sandbox: true, sandboxMode: "workspace-write" },
        { sandbox: true },
      ])
    ).toBe(false);
  });
});
