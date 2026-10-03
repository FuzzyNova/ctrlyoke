/**
 * Ask a yes/no question on stderr (stdout stays clean for `--json` and piped
 * output). Anything but an answer starting with "y" is a no.
 */
export async function promptYesNo(question: string): Promise<boolean> {
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
