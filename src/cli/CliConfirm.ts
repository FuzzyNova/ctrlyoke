/**
 * Ask a yes/no question on stderr (stdout stays clean for `--json` and piped
 * output). Anything but an answer starting with "y" is a no.
 */
export async function confirmYesNo(question: string): Promise<boolean> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await rl.question(question);
    return answer.toLowerCase().startsWith("y");
  } finally {
    rl.close();
  }
}

/** Terminal access needed to confirm a mutating CLI command. */
export interface CliConfirmIo {
  readonly isInteractive: boolean;
  confirm(question: string): Promise<boolean>;
}

/**
 * Confirm a mutating command: `--yes` approves it, a non-interactive terminal
 * declines it, and otherwise the user is asked.
 */
export async function confirmMutation(
  yes: boolean,
  io: CliConfirmIo,
  question: string
): Promise<boolean> {
  if (yes) return true;
  if (!io.isInteractive) return false;
  return io.confirm(question);
}
