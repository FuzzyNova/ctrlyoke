import { describe, expect, it } from "vitest";
import {
  schemaAriaLabel,
  schemaFieldTitle,
  schemaOptionTitle,
  schemaTitle,
} from "../../utils/schemaPropertyLabels";

describe("schemaPropertyLabels", () => {
  it("adds a property path and literal value after the schema description", () => {
    expect(
      schemaTitle("toolPermissions.mode", "none", "Permission mode.")
    ).toBe("Permission mode.\n\nproperty: toolPermissions.mode = none");
    expect(schemaTitle("worktree", false, "")).toBe(
      "property: worktree = false"
    );
    expect(schemaTitle("toolPermissions", null, "")).toBe(
      "property: toolPermissions = null"
    );
  });

  it("uses generated descriptions when no description is supplied", () => {
    expect(schemaTitle("general.defaultFormat")).toBe(
      "Default file format for new workflows.\n\nproperty: general.defaultFormat"
    );
  });

  it("leads an option tooltip with its full label, then its own description, then schema help", () => {
    expect(
      schemaOptionTitle(
        "reviewer",
        "Reviews diffs.",
        "toolPermissions.mode",
        "none"
      )
    ).toBe(
      `reviewer\n\nReviews diffs.\n\n${schemaTitle("toolPermissions.mode", "none")}`
    );
    expect(schemaOptionTitle("Plain", undefined)).toBe("Plain");
    expect(schemaFieldTitle("Format", "general.defaultFormat")).toBe(
      "Format\n\nDefault file format for new workflows.\n\nproperty: general.defaultFormat"
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
