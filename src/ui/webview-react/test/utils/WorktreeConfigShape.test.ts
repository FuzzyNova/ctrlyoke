import { describe, expect, it } from "vitest";
import { WORKTREE_MODES } from "@root/types/DashboardConstants";
import { toWorktreeObjectConfig } from "@root/utils/WorktreeConfigShape";

describe("toWorktreeObjectConfig", () => {
  it.each([undefined, false])("maps %s to false", (value) => {
    expect(toWorktreeObjectConfig(value)).toBe(false);
  });

  it("maps true to managed mode", () => {
    expect(toWorktreeObjectConfig(true)).toEqual({
      mode: WORKTREE_MODES.MANAGED,
    });
  });

  it("maps a string to named mode", () => {
    expect(toWorktreeObjectConfig("feature/topic")).toEqual({
      mode: WORKTREE_MODES.NAMED,
      branch: "feature/topic",
    });
  });

  it("returns an object config by reference", () => {
    const config = { mode: WORKTREE_MODES.MANAGED, keep: true } as const;
    expect(toWorktreeObjectConfig(config)).toBe(config);
  });
});
