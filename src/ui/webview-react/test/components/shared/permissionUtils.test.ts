import { describe, expect, it } from "vitest";
import { PERMISSION_MODES } from "@root/types/DashboardConstants";
import {
  PERMISSION_MODE_OPTIONS_META,
  toSelectOptions,
} from "@root/types/SchemaUiMetadata";
import { permissionModeAllowsAllowedTools } from "@components/shared/permissionUtils";

describe("permission mode UI metadata", () => {
  it("gives every mode a short subtitle and a tooltip detail", () => {
    const options = toSelectOptions(
      PERMISSION_MODE_OPTIONS_META,
      "toolPermissions.mode"
    );
    for (const option of options) {
      expect(option.description).toBeTruthy();
      expect(option.description!.length).toBeLessThanOrEqual(50);
      expect(option.tooltipDetail).toBeTruthy();
    }
  });

  it("places auto between allowAll and custom with its explanatory copy", () => {
    const options = toSelectOptions(
      PERMISSION_MODE_OPTIONS_META,
      "toolPermissions.mode"
    );

    expect(options.map(({ value }) => value)).toEqual([
      PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL,
      PERMISSION_MODES.ALLOW_ALL,
      PERMISSION_MODES.AUTO,
      PERMISSION_MODES.CUSTOM,
      PERMISSION_MODES.NONE,
    ]);
    expect(options[2]).toMatchObject({
      label: "Auto (harness judges each request)",
      description: "Harness's judge decides; deny list still blocks",
    });
    expect(options[2].tooltipDetail).toContain(
      "The harness's safety judge approves or blocks each request."
    );
  });

  it("activates the allowed-tools editor for auto", () => {
    expect(permissionModeAllowsAllowedTools(PERMISSION_MODES.AUTO)).toBe(true);
  });
});
