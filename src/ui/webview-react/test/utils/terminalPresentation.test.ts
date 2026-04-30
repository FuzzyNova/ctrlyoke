import { describe, expect, it } from "vitest";
import { SHELL_KINDS } from "@/types/messages";
import {
  getShellCodiconName,
  getShellCompactLabel,
  inferShellKind,
} from "@utils/terminalPresentation";

describe("terminalPresentation", () => {
  it("preserves short shell labels for known shell kinds", () => {
    expect(getShellCompactLabel(SHELL_KINDS.PWSH, "pwsh")).toBe("pwsh");
    expect(getShellCompactLabel(SHELL_KINDS.POWERSHELL, "powershell")).toBe(
      "ps"
    );
    expect(getShellCompactLabel(SHELL_KINDS.ZSH, "zsh")).toBe("zsh");
    expect(getShellCompactLabel(SHELL_KINDS.BASH, "bash")).toBe("bash");
    expect(getShellCompactLabel(SHELL_KINDS.FISH, "fish")).toBe("fish");
  });

  it("falls back to stepName when shellKind is missing", () => {
    expect(getShellCompactLabel(undefined, "pwsh")).toBe("pwsh");
    expect(getShellCompactLabel(undefined, "powershell")).toBe("ps");
    expect(getShellCompactLabel(undefined, "zsh")).toBe("zsh");
  });

  it("truncates unknown shell names to four characters", () => {
    expect(getShellCompactLabel(undefined, "murex")).toBe("mure");
  });

  it("infers codicons from stepName when shellKind is missing", () => {
    expect(getShellCodiconName(undefined, "pwsh")).toBe("codicon-terminal");
    expect(getShellCodiconName(undefined, "powershell")).toBe(
      "codicon-terminal-powershell"
    );
    expect(getShellCodiconName(undefined, "zsh")).toBe(
      "codicon-terminal-bash"
    );
    expect(getShellCodiconName(undefined, "cmd")).toBe("codicon-terminal");
  });

  it("infers expanded shell kinds from common executable names", () => {
    expect(inferShellKind(undefined, "pwsh-preview")).toBe(SHELL_KINDS.PWSH);
    expect(inferShellKind(undefined, "dash")).toBe(SHELL_KINDS.SH);
    expect(inferShellKind(undefined, "wsl")).toBe(SHELL_KINDS.WSL);
    expect(inferShellKind(undefined, "nushell")).toBe(SHELL_KINDS.NUSHELL);
  });
});
