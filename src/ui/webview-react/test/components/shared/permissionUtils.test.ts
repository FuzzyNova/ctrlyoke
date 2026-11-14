import { describe, expect, it } from "vitest";
import { PERMISSION_MODES } from "@root/types/DashboardConstants";
import {
  PERMISSION_MODE_OPTIONS_META,
  toSelectOptions,
} from "@root/types/SchemaUiMetadata";
import { permissionModeAllowsAllowedTools } from "@components/shared/permissionUtils";

describe("permission mode UI metadata", () => {
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
      description:
        "The harness's safety judge approves or blocks each request. The deny list always blocks; the allow list pre-approves tools without limiting what runs.",
    });
  });

  it("activates the allowed-tools editor for auto", () => {
    expect(permissionModeAllowsAllowedTools(PERMISSION_MODES.AUTO)).toBe(true);
  });
});
