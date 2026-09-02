import { SHELL_KINDS, SHELL_TYPES, type ShellKind } from "@/types/messages";

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
