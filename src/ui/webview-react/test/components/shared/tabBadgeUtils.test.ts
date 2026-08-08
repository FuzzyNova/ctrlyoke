import { describe, expect, it } from "vitest";
import { PERMISSION_MODES } from "@root/types/DashboardConstants";
import {
  getPermissionModeBadge,
  getPermissionTabOverride,
} from "@components/shared/tabBadgeUtils";

describe("permission tab badges", () => {
  it("omits the badge for none", () => {
    expect(getPermissionModeBadge(PERMISSION_MODES.NONE)).toBeUndefined();
  });

  it.each([
    [PERMISSION_MODES.CUSTOM, "text-terminal-ansiGreen"],
    [PERMISSION_MODES.ALLOW_ALL, "text-warning-fg"],
    [PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL, "text-error-fg"],
  ])("uses a shield badge and the %s palette", (mode, color) => {
    const badge = getPermissionModeBadge(mode);

    expect(badge).toMatchObject({
      badgeCodicon: "shield",
      color,
      badgeColor: color,
    });
    expect(badge).not.toHaveProperty("codicon");
  });

  it("preserves the drawer permission shape swap", () => {
    expect(
      getPermissionTabOverride(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
    ).toMatchObject({ codicon: "workspace-untrusted" });
  });
});
