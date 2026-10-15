export const SENT_PROMPT_HEADER = "Prompt sent to running terminal:";

/**
 * A command row split into its static header (only for prompts written into a
 * live TUI) and the body that was actually sent or run. Renderers style the
 * header separately; find and file-link offsets refer to `body` alone.
 */
export interface CliCommandDisplayParts {
  header?: string;
  body: string;
}

export function getCliCommandDisplayParts(
  command: string,
  workingDirectory?: string,
  sentToRunningTerminal?: boolean
): CliCommandDisplayParts {
  if (sentToRunningTerminal) {
    return { header: SENT_PROMPT_HEADER, body: command };
  }

  return { body: `${workingDirectory || "workspace"}> ${command}` };
}

export function formatCliCommandDisplay(
  command: string,
  workingDirectory?: string,
  sentToRunningTerminal?: boolean
): string {
  const { header, body } = getCliCommandDisplayParts(
    command,
    workingDirectory,
    sentToRunningTerminal
  );
  return header ? `${header}\n${body}` : body;
}
