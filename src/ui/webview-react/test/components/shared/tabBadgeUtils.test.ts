import { describe, expect, it } from "vitest";
import { PERMISSION_MODES } from "@root/types/DashboardConstants";
import {
  getMcpTabOverride,
  getHooksTabOverride,
  getPermissionModeBadge,
  getPermissionModeVisual,
  getPermissionTabOverride,
  priorContextBadge,
} from "@components/shared/tabBadgeUtils";
import type { RunRef, WorkflowKey } from "@root/types/CtrlYokeTypes";

describe("permission tab badges", () => {
  it("omits the badge for none", () => {
    expect(getPermissionModeBadge(PERMISSION_MODES.NONE)).toBeUndefined();
  });

  it.each([
    [PERMISSION_MODES.CUSTOM, "text-terminal-ansiGreen"],
    [PERMISSION_MODES.ALLOW_ALL, "text-warning-fg"],
    [PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL, "text-error-fg"],
  ])(
    "uses only a shield badge (no primary-icon color) for the %s palette",
    (mode, color) => {
      const badge = getPermissionModeBadge(mode);

      expect(badge).toEqual({
        badgeCodicon: "shield",
        badgeColor: color,
      });
      expect(badge).not.toHaveProperty("codicon");
      expect(badge).not.toHaveProperty("color");
    }
  );

  it("preserves the drawer permission shape swap", () => {
    expect(
      getPermissionTabOverride(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
    ).toMatchObject({ codicon: "workspace-untrusted" });
  });

  it("overlays a warning badge on the permission mode's own icon and color", () => {
    const override = getPermissionTabOverride(
      PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL,
      true
    );

    expect(override).toEqual({
      codicon: "workspace-untrusted",
      statusColor: "text-error-fg",
      badgeCodicon: "warning",
      badgeColor: "text-warning-fg",
    });
  });

  it("still overlays a warning badge when the mode has no icon override of its own", () => {
    const override = getPermissionTabOverride(PERMISSION_MODES.NONE, true);

    expect(override).toEqual({
      badgeCodicon: "warning",
      badgeColor: "text-warning-fg",
    });
  });

  it("layers a warning badge over the configured hooks state", () => {
    expect(getHooksTabOverride([{ event: "error" }], true)).toEqual({
      color: "text-focus-border",
      hoverColor: "hover:text-focus-highlight",
      activeColor: "text-focus-highlight",
      badgeCodicon: "warning",
      badgeColor: "text-warning-fg",
    });
  });

  it("resolves a real color/codicon for 'none' too, unlike getPermissionTabOverride", () => {
    expect(getPermissionModeVisual(PERMISSION_MODES.NONE)).toEqual({
      codicon: "workspace-trusted",
      color: "text-description-fg",
    });
  });

  it("falls back to the 'none' visual for an unrecognized mode", () => {
    expect(getPermissionModeVisual("bogus-mode")).toEqual(
      getPermissionModeVisual(PERMISSION_MODES.NONE)
    );
  });

  it("layers a warning badge over the configured MCP icon", () => {
    expect(getMcpTabOverride(["ctrlyoke"], true)).toEqual({
      color: "text-focus-border",
      hoverColor: "hover:text-focus-highlight",
      activeColor: "text-focus-highlight",
      badgeCodicon: "warning",
      badgeColor: "text-warning-fg",
    });
  });
});

describe("priorContextBadge", () => {
  it("labels every priorContext form compactly", () => {
    expect(priorContextBadge("previous").label).toBe("ctx: prev");
    expect(priorContextBadge([1, 3]).label).toBe("ctx: [1,3]");
    expect(priorContextBadge({ previous: 3 }).label).toBe("ctx: prev 3");
  });

  it("labels a run address as run and keeps the address in the title", () => {
    const badge = priorContextBadge({
      workflowKey: "lineage-a" as WorkflowKey,
      runRef: "run-2026-07-20T00-00-00-000Z" as RunRef,
    });
    expect(badge.label).toBe("ctx: run");
    expect(badge.title).toContain('"workflowKey":"lineage-a"');
  });
});
