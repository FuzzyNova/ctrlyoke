import { describe, expect, it } from "vitest";
import {
  SESSION_KINDS,
  SHELL_KINDS,
  TERMINAL_SESSION_STATUS,
} from "@/types/messages";
import {
  getAiCliCompactLabel,
  getShellCodiconName,
  getShellCompactLabel,
  inferShellKind,
  isTerminalSessionInUseByActiveStep,
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
    expect(getShellCodiconName(undefined, "zsh")).toBe("codicon-terminal-bash");
    expect(getShellCodiconName(undefined, "cmd")).toBe("codicon-terminal");
  });

  it("infers expanded shell kinds from common executable names", () => {
    expect(inferShellKind(undefined, "pwsh-preview")).toBe(SHELL_KINDS.PWSH);
    expect(inferShellKind(undefined, "dash")).toBe(SHELL_KINDS.SH);
    expect(inferShellKind(undefined, "wsl")).toBe(SHELL_KINDS.WSL);
    expect(inferShellKind(undefined, "nushell")).toBe(SHELL_KINDS.NUSHELL);
  });
});

describe("isTerminalSessionInUseByActiveStep", () => {
  it("is in use when the running session's stepIndex is currently active", () => {
    expect(
      isTerminalSessionInUseByActiveStep(
        {
          status: TERMINAL_SESSION_STATUS.RUNNING,
          stepIndex: 2,
          kind: SESSION_KINDS.AI_CLI,
        },
        [2, 5]
      )
    ).toBe(true);
  });

  it("is not in use when the session's stepIndex is not among the active steps", () => {
    expect(
      isTerminalSessionInUseByActiveStep(
        {
          status: TERMINAL_SESSION_STATUS.RUNNING,
          stepIndex: 1,
          kind: SESSION_KINDS.AI_CLI,
        },
        [2, 5]
      )
    ).toBe(false);
  });

  it("is not in use once the session has ended, even if its stepIndex is still active", () => {
    expect(
      isTerminalSessionInUseByActiveStep(
        {
          status: TERMINAL_SESSION_STATUS.COMPLETED,
          stepIndex: 2,
          kind: SESSION_KINDS.AI_CLI,
        },
        [2]
      )
    ).toBe(false);
  });

  it("is not in use when stepIndex is undefined", () => {
    expect(
      isTerminalSessionInUseByActiveStep(
        {
          status: TERMINAL_SESSION_STATUS.RUNNING,
          stepIndex: undefined,
          kind: SESSION_KINDS.AI_CLI,
        },
        [0]
      )
    ).toBe(false);
  });

  it("is in use for a running final-step AI session using the signed index", () => {
    // Final-step attempts use -(loopIndex + 1) for terminal identity,
    // including -1 on the first loop.
    expect(
      isTerminalSessionInUseByActiveStep(
        {
          status: TERMINAL_SESSION_STATUS.RUNNING,
          stepIndex: -1,
          kind: SESSION_KINDS.AI_CLI,
        },
        [-1]
      )
    ).toBe(true);
  });

  it("is never in use for a standalone shell session, even if -1 is active for a final-step loop", () => {
    expect(
      isTerminalSessionInUseByActiveStep(
        {
          status: TERMINAL_SESSION_STATUS.RUNNING,
          stepIndex: -1,
          kind: SESSION_KINDS.SHELL,
        },
        [-1]
      )
    ).toBe(false);
  });
});

describe("getAiCliCompactLabel", () => {
  it("numbers a queue step one-based", () => {
    expect(getAiCliCompactLabel({ stepIndex: 2 })).toBe("3");
  });

  it("keeps a final-step attempt's label short instead of using its step name", () => {
    // The collapsed rail is sized for the 1-4 character labels the shell side
    // produces, so a signed final-step index must not fall through to an
    // arbitrary-length stepName.
    const label = getAiCliCompactLabel({ stepIndex: -1 });
    expect(label).toBe("fin");
    expect(label.length).toBeLessThanOrEqual(4);
  });

  it("falls back to the short marker when the session carries no step index", () => {
    expect(getAiCliCompactLabel({ stepIndex: undefined })).toBe("fin");
  });
});
