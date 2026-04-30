import { SHELL_KINDS, type ShellKind } from "@/types/messages";

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
  if (name === "zsh") return SHELL_KINDS.ZSH;
  if (name === "bash") return SHELL_KINDS.BASH;
  if (name === "fish") return SHELL_KINDS.FISH;
  if (name === "cmd") return SHELL_KINDS.CMD;
  if (name === "wsl") return SHELL_KINDS.WSL;
  if (name === "nu" || name === "nushell") return SHELL_KINDS.NUSHELL;
  if (name === "sh" || name === "dash" || name === "ksh") {
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
      return "zsh";
    case SHELL_KINDS.BASH:
      return "bash";
    case SHELL_KINDS.SH:
      return "sh";
    case SHELL_KINDS.FISH:
      return "fish";
    case SHELL_KINDS.CMD:
      return "cmd";
    case SHELL_KINDS.WSL:
      return "wsl";
    case SHELL_KINDS.NUSHELL:
      return "nu";
    default: {
      const fallback = normalizeShellName(stepName);
      if (!fallback) {
        return "sh";
      }
      return fallback.length <= 4 ? fallback : fallback.slice(0, 4);
    }
  }
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
