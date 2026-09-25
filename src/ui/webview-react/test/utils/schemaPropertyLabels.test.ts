import { describe, expect, it } from "vitest";
import { schemaAriaLabel, schemaTitle } from "../../utils/schemaPropertyLabels";

describe("schemaPropertyLabels", () => {
  it("adds a property path and literal value after the schema description", () => {
    expect(
      schemaTitle("toolPermissions.mode", "none", "Permission mode.")
    ).toBe("Permission mode. property: toolPermissions.mode = none");
    expect(schemaTitle("worktree", false, "")).toBe(
      "property: worktree = false"
    );
    expect(schemaTitle("toolPermissions", null, "")).toBe(
      "property: toolPermissions = null"
    );
  });

  it("uses generated descriptions when no description is supplied", () => {
    expect(schemaTitle("general.defaultFormat")).toBe(
      "Default file format for new workflows. property: general.defaultFormat"
    );
  });

  it("keeps accessible names prefixed by the visible label", () => {
    expect(schemaAriaLabel("None", "toolPermissions.mode", "none")).toBe(
      "None, toolPermissions.mode: none"
    );
    expect(schemaAriaLabel("Execution Mode", "executionMode")).toBe(
      "Execution Mode, property executionMode"
    );
  });

  it("states the YAML written by an omit pseudo-option", () => {
    expect(schemaTitle("toolPermissions", { omit: true })).toBe(
      "omit toolPermissions"
    );
    expect(
      schemaAriaLabel("Inherit (None)", "toolPermissions", { omit: true })
    ).toBe("Inherit (None), omit toolPermissions");
  });
});
