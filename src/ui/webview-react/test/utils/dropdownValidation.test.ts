import { describe, expect, it } from "vitest";
import {
  agentWarning,
  dropdownBorderClass,
  dropdownWarningClass,
  modelWarning,
  skillsWarning,
} from "@utils/dropdownValidation";

const AGENTS = [
  { name: "reviewer", path: "/workspace/.agents/reviewer.agent.md" },
];
const SKILLS = [{ name: "lint", path: "/workspace/.agents/skills/lint" }];

describe("dropdown validation", () => {
  it("does not warn for inherited, explicitly disabled, or available values", () => {
    expect(agentWarning(undefined, AGENTS)).toBeNull();
    expect(agentWarning(null, AGENTS)).toBeNull();
    expect(agentWarning("reviewer", AGENTS)).toBeNull();
    expect(skillsWarning(null, SKILLS)).toBeNull();
    expect(skillsWarning(["lint"], SKILLS)).toBeNull();
  });

  it("identifies unavailable agents and skills", () => {
    expect(agentWarning("missing", AGENTS)).toBe(
      'Agent "missing" is not available in this workspace.'
    );
    expect(skillsWarning(["lint", "missing", "other"], SKILLS)).toBe(
      '2 skills not found: "missing", "other".'
    );
    expect(agentWarning(AGENTS[0].path, AGENTS)).toBe(
      `Agent "${AGENTS[0].path}" is not available in this workspace.`
    );
    expect(skillsWarning([SKILLS[0].path], SKILLS)).toBe(
      `1 skill not found: "${SKILLS[0].path}".`
    );
  });

  it("identifies models unavailable for the selected harness", () => {
    expect(
      modelWarning("missing", "codex-cli", [{ value: "gpt-5", label: "GPT-5" }])
    ).toBe('Model "missing" is not available for codex-cli.');
    expect(
      modelWarning("gpt-5", "codex-cli", [{ value: "gpt-5", label: "GPT-5" }])
    ).toBeNull();
    expect(modelWarning("gpt-5", "codex-cli", [])).toBeNull();
  });

  it("uses warning tokens only when a warning is present", () => {
    expect(dropdownBorderClass(null)).toBe("border-dropdown-border");
    expect(dropdownBorderClass("Unavailable")).toBe("border-warning-fg");
    expect(dropdownWarningClass(undefined)).toBe("text-description-fg");
    expect(dropdownWarningClass("Unavailable")).toBe("text-warning-fg");
    expect(dropdownBorderClass(false, "error")).toBe("border-input-border");
    expect(dropdownBorderClass(true, "error")).toBe(
      "border-input-error-border"
    );
  });
});
