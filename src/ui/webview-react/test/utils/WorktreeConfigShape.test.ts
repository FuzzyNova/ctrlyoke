import { describe, expect, it } from "vitest";
import { WORKTREE_MODES } from "@root/types/DashboardConstants";
import {
  effectiveWorktreeObjectConfig,
  toWorktreeObjectConfig,
} from "@root/utils/WorktreeConfigShape";

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

describe("effectiveWorktreeObjectConfig", () => {
  it("inherits the settings value when nothing is authored", () => {
    expect(effectiveWorktreeObjectConfig(undefined, "main")).toEqual({
      mode: WORKTREE_MODES.NAMED,
      branch: "main",
    });
    expect(effectiveWorktreeObjectConfig(undefined, undefined)).toBe(false);
  });

  it("prefers an authored value, including an explicit false", () => {
    expect(effectiveWorktreeObjectConfig(false, true)).toBe(false);
    expect(effectiveWorktreeObjectConfig(true, false)).toEqual({
      mode: WORKTREE_MODES.MANAGED,
    });
  });

  it("returns a copy of an object config", () => {
    const config = { mode: WORKTREE_MODES.MANAGED, keep: true } as const;
    const effective = effectiveWorktreeObjectConfig(config, undefined);
    expect(effective).toEqual(config);
    expect(effective).not.toBe(config);
  });
});
