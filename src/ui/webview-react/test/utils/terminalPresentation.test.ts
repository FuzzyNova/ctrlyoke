import { describe, expect, it } from "vitest";
import {
  SESSION_KINDS,
  SHELL_KINDS,
  TERMINAL_SESSION_STATUS,
} from "@/types/messages";
import {
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

  it("is in use for a running final-step AI-harness session (stepIndex === totalSteps)", () => {
    // WorkflowInstance.getActiveStepIndices() reports `steps.length` for an
    // active final-step attempt spawned via the AI-harness path.
    expect(
      isTerminalSessionInUseByActiveStep(
        {
          status: TERMINAL_SESSION_STATUS.RUNNING,
          stepIndex: 3,
          kind: SESSION_KINDS.AI_CLI,
        },
        [3]
      )
    ).toBe(true);
  });

  it("is in use for a running final-step interactive-script session at loop 0 (stepIndex -1)", () => {
    // The interactive-script spawn path encodes the final step's first loop
    // as -(0+1) === -1, the same raw number a standalone shell carries — the
    // `kind` check is what keeps this correctly gated.
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
