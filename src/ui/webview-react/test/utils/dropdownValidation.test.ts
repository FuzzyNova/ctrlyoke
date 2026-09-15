import { describe, expect, it } from "vitest";
import {
  agentWarning,
  dropdownBorderClass,
  dropdownWarningClass,
  dropdownWarningIcon,
  modelWarning,
  shellWarning,
  skillsWarning,
} from "@utils/dropdownValidation";
import { UI_PLATFORMS } from "@root/types/DashboardConstants";

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

  it("warns only for a pinned shell this platform does not normally have", () => {
    expect(shellWarning("zsh", UI_PLATFORMS.WINDOWS)).toBe(
      'Shell "zsh" is not typically available on Windows.'
    );
    expect(shellWarning("/bin/zsh", UI_PLATFORMS.WINDOWS)).toBe(
      'Shell "/bin/zsh" is not typically available on Windows.'
    );
    expect(shellWarning("cmd", UI_PLATFORMS.MAC)).toBe(
      'Shell "cmd" is not typically available on macOS.'
    );
    expect(shellWarning("pwsh", UI_PLATFORMS.LINUX)).toBeNull();
    expect(shellWarning("zsh", UI_PLATFORMS.MAC)).toBeNull();
    expect(shellWarning(undefined, UI_PLATFORMS.WINDOWS)).toBeNull();
    // An unrecognized custom path is the user's business, not a warning.
    expect(
      shellWarning("C:\\tools\\myshell.exe", UI_PLATFORMS.WINDOWS)
    ).toBeNull();
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
    expect(dropdownWarningClass("Broken", "error")).toBe("text-error-fg");
    expect(dropdownWarningIcon()).toBe("warning");
    expect(dropdownWarningIcon("error")).toBe("error");
  });
});
