import { describe, expect, it } from "vitest";
import {
  discoveryLocationTitle,
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

  it("leads an option tooltip with its full label and description, then only the YAML it writes", () => {
    expect(
      schemaOptionTitle(
        "Named",
        "Targets a worktree you own.",
        "worktree",
        "named"
      )
    ).toBe(
      "Named\n\nTargets a worktree you own.\n\nproperty: worktree = named"
    );
    // The field's own schema help stays on the field label, never the row.
    expect(
      schemaOptionTitle("Markdown", undefined, "general.defaultFormat", "md")
    ).toBe("Markdown\n\nproperty: general.defaultFormat = md");
    expect(
      schemaOptionTitle("None", undefined, "agent", { writes: "agent: null" })
    ).toBe("None\n\nagent: null\n\nproperty: agent");
    expect(
      schemaOptionTitle("Inherit", undefined, "agent", { omit: true })
    ).toBe("Inherit\n\nomit agent");
    expect(schemaOptionTitle("Plain", undefined)).toBe("Plain");
    expect(schemaFieldTitle("Format", "general.defaultFormat")).toBe(
      "Format\n\nDefault file format for new workflows.\n\nproperty: general.defaultFormat"
    );
  });

  it("lists where a discovered agent or skill is saved and its same-named copies", () => {
    expect(discoveryLocationTitle({})).toBeUndefined();
    expect(
      discoveryLocationTitle({ displayPath: ".ctrlyoke/skills/a/SKILL.md" })
    ).toBe("Saved at: .ctrlyoke/skills/a/SKILL.md");
    expect(
      discoveryLocationTitle({
        displayPath: ".ctrlyoke/skills/a/SKILL.md",
        shadowedCopies: [
          { displayPath: "~/.ctrlyoke/skills/a/SKILL.md", identical: true },
        ],
      })
    ).toBe(
      "Saved at: .ctrlyoke/skills/a/SKILL.md\nIdentical copy: ~/.ctrlyoke/skills/a/SKILL.md"
    );
    // Only a differing copy earns the "how to pick it" hint.
    expect(
      discoveryLocationTitle({
        displayPath: ".ctrlyoke/skills/a/SKILL.md",
        shadowedCopies: [
          { displayPath: "~/.claude/skills/a/SKILL.md", identical: false },
        ],
      })
    ).toBe(
      "Saved at: .ctrlyoke/skills/a/SKILL.md\nDifferent copy, not used: ~/.claude/skills/a/SKILL.md\nTo use a different copy, move it into .ctrlyoke/ (workspace) or ~/.ctrlyoke/ (user). Workspace wins over user."
    );
  });

  it("places option detail between the description and the YAML", () => {
    expect(
      schemaOptionTitle(
        "lint",
        "Lints code.",
        "skills",
        undefined,
        "Saved at: x"
      )
    ).toBe("lint\n\nLints code.\n\nSaved at: x\n\nproperty: skills");
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
