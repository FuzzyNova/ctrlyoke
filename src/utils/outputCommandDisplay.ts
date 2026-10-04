export function formatCliCommandDisplay(
  command: string,
  workingDirectory?: string,
  wasInjected?: boolean
): string {
  if (wasInjected) {
    return `Prompt was injected into running terminal: ${command}`;
  }

  return `${workingDirectory || "workspace"}> ${command}`;
}
