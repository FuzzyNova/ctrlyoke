import {
  SESSION_KINDS,
  SHELL_KINDS,
  SHELL_TYPES,
  TERMINAL_SESSION_STATUS,
  type ShellKind,
} from "@/types/messages";
import type { TerminalSession } from "@store/terminalStore";

function normalizeShellName(name: string | undefined): string | undefined {
  const trimmed = name?.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\.exe$/i, "");
}

export function inferShellKind(
  shellKind: ShellKind | undefined,
  stepName: string | undefined
): ShellKind | undefined {
  if (shellKind) {
    return shellKind;
  }

  const name = normalizeShellName(stepName);
  if (!name) {
    return undefined;
  }

  if (/^pwsh([.-]|$)/.test(name)) return SHELL_KINDS.PWSH;
  if (name.startsWith("powershell")) return SHELL_KINDS.POWERSHELL;
  if (name === SHELL_TYPES.ZSH) return SHELL_KINDS.ZSH;
  if (name === SHELL_TYPES.BASH) return SHELL_KINDS.BASH;
  if (name === SHELL_TYPES.FISH) return SHELL_KINDS.FISH;
  if (name === SHELL_TYPES.CMD) return SHELL_KINDS.CMD;
  if (name === SHELL_TYPES.WSL) return SHELL_KINDS.WSL;
  if (name === SHELL_TYPES.NU || name === SHELL_TYPES.NUSHELL) {
    return SHELL_KINDS.NUSHELL;
  }
  if (
    name === SHELL_TYPES.SH ||
    name === SHELL_TYPES.DASH ||
    name === SHELL_TYPES.KSH
  ) {
    return SHELL_KINDS.SH;
  }
  if (name.endsWith("sh")) return SHELL_KINDS.SH;
  return undefined;
}

export function getShellCompactLabel(
  shellKind: ShellKind | undefined,
  stepName: string | undefined
): string {
  const resolvedKind = inferShellKind(shellKind, stepName);
  switch (resolvedKind) {
    case SHELL_KINDS.PWSH:
      return "pwsh";
    case SHELL_KINDS.POWERSHELL:
      return "ps";
    case SHELL_KINDS.ZSH:
      return SHELL_TYPES.ZSH;
    case SHELL_KINDS.BASH:
      return SHELL_TYPES.BASH;
    case SHELL_KINDS.SH:
      return SHELL_TYPES.SH;
    case SHELL_KINDS.FISH:
      return SHELL_TYPES.FISH;
    case SHELL_KINDS.CMD:
      return SHELL_TYPES.CMD;
    case SHELL_KINDS.WSL:
      return SHELL_TYPES.WSL;
    case SHELL_KINDS.NUSHELL:
      return SHELL_TYPES.NU;
    default: {
      const fallback = normalizeShellName(stepName);
      if (!fallback) {
        return SHELL_TYPES.SH;
      }
      return fallback.length <= 4 ? fallback : fallback.slice(0, 4);
    }
  }
}

/**
 * A session is closeable unless it is the live PTY a currently-running step is
 * driving right now. Retention (see TERMINAL_SESSION_RETENTION_PLAN.md) keeps
 * ai-cli sessions alive beyond the step that spawned them so a later step can
 * inject into them, so "workflow is executing" is not the right gate — only
 * *this* session's own `stepIndex` matching one of the steps currently running
 * means closing it would kill work in progress. `activeStepIndices`
 * (WorkflowInstance.getActiveStepIndices()) uses the signed convention for
 * final-step attempts: `-(loopIndex + 1)`. The `kind` check remains required
 * because only ai-cli sessions are ever step-owned; shell sessions stay
 * closeable regardless of stepIndex or execution state.
 */
export function isTerminalSessionInUseByActiveStep(
  session: Pick<TerminalSession, "status" | "stepIndex" | "kind">,
  activeStepIndices: readonly number[]
): boolean {
  return (
    session.kind === SESSION_KINDS.AI_CLI &&
    session.status === TERMINAL_SESSION_STATUS.RUNNING &&
    session.stepIndex !== undefined &&
    activeStepIndices.includes(session.stepIndex)
  );
}

export function getShellCodiconName(
  shellKind: ShellKind | undefined,
  stepName: string | undefined
): string | undefined {
  const resolvedKind = inferShellKind(shellKind, stepName);
  switch (resolvedKind) {
    case SHELL_KINDS.POWERSHELL:
      return "codicon-terminal-powershell";
    case SHELL_KINDS.ZSH:
    case SHELL_KINDS.BASH:
    case SHELL_KINDS.SH:
    case SHELL_KINDS.FISH:
    case SHELL_KINDS.WSL:
      return "codicon-terminal-bash";
    case SHELL_KINDS.PWSH:
    case SHELL_KINDS.CMD:
    case SHELL_KINDS.NUSHELL:
      return "codicon-terminal";
    default:
      return undefined;
  }
}
