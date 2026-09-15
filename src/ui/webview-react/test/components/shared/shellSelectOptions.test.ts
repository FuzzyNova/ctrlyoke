import { describe, expect, it } from "vitest";
import {
  CUSTOM_SHELL_OPTION,
  INHERIT_DEFAULT_OPTION,
  UI_PLATFORMS,
} from "@root/types/DashboardConstants";
import {
  buildShellOptions,
  isKnownShell,
  shellSelectValue,
  usesCustomShellPath,
} from "@components/shared/shellSelectOptions";

function values(platform: (typeof UI_PLATFORMS)[keyof typeof UI_PLATFORMS]) {
  return buildShellOptions(undefined, platform).map((option) => option.value);
}

describe("buildShellOptions", () => {
  it("offers Auto first and a custom-path escape hatch last", () => {
    const options = buildShellOptions(undefined, UI_PLATFORMS.MAC);

    expect(options[0].value).toBe(INHERIT_DEFAULT_OPTION);
    expect(options[options.length - 1].value).toBe(CUSTOM_SHELL_OPTION);
  });

  it("lists only the shells the platform normally has", () => {
    expect(values(UI_PLATFORMS.WINDOWS)).toContain("cmd");
    expect(values(UI_PLATFORMS.WINDOWS)).not.toContain("zsh");
    expect(values(UI_PLATFORMS.MAC)).toContain("zsh");
    expect(values(UI_PLATFORMS.MAC)).not.toContain("cmd");
  });

  it("keeps a shell pinned on another platform selectable, with a note", () => {
    const options = buildShellOptions("zsh", UI_PLATFORMS.WINDOWS);
    const pinned = options.find((option) => option.value === "zsh");

    expect(pinned).toBeDefined();
    expect(pinned?.description).toBe("Not typically available on Windows");
    expect(pinned?.descriptionClassName).toBe("text-warning-fg");
  });

  it("adds a differently-spelled but available shell without a note", () => {
    const options = buildShellOptions("pwsh.exe", UI_PLATFORMS.WINDOWS);
    const pinned = options.find((option) => option.value === "pwsh.exe");

    expect(pinned).toBeDefined();
    expect(pinned?.description).toBeUndefined();
  });

  it("does not duplicate a shell already listed for this platform", () => {
    const options = buildShellOptions("zsh", UI_PLATFORMS.MAC);

    expect(options.filter((option) => option.value === "zsh")).toHaveLength(1);
  });

  it("leaves an unrecognized path out of the list — the path input owns it", () => {
    const options = buildShellOptions(
      "C:\\tools\\myshell.exe",
      UI_PLATFORMS.WINDOWS
    );

    expect(
      options.some((option) => option.value === "C:\\tools\\myshell.exe")
    ).toBe(false);
  });
});

describe("shell picker mode", () => {
  it("treats a catalog shell written any way as known", () => {
    expect(isKnownShell("zsh")).toBe(true);
    expect(isKnownShell("/bin/zsh")).toBe(true);
    expect(isKnownShell("cmd.exe")).toBe(true);
    expect(isKnownShell(undefined)).toBe(false);
    expect(isKnownShell("C:\\tools\\myshell.exe")).toBe(false);
  });

  it("switches to the path input only for an unrecognized executable", () => {
    expect(usesCustomShellPath(undefined)).toBe(false);
    expect(usesCustomShellPath("pwsh")).toBe(false);
    expect(usesCustomShellPath("/opt/weird/runner")).toBe(true);
  });

  it("maps the pinned value onto the dropdown's selected value", () => {
    expect(shellSelectValue(undefined, false)).toBe(INHERIT_DEFAULT_OPTION);
    expect(shellSelectValue("bash", false)).toBe("bash");
    expect(shellSelectValue("bash", true)).toBe(CUSTOM_SHELL_OPTION);
  });
});
