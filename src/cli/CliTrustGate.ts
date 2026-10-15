import { promptYesNo } from "./CliPrompt";

/** Terminal access for the CLI's trust prompts; prompts and errors use stderr. */
export interface CliTrustIo {
  writeOut(message: string): void;
  writeErr(message: string): void;
  readonly isInteractive: boolean;
  confirm(question: string): Promise<boolean>;
}

export function createCliTrustIo(): CliTrustIo {
  return {
    writeOut: (message) => process.stdout.write(`${message}\n`),
    writeErr: (message) => process.stderr.write(`${message}\n`),
    isInteractive: !!process.stdin.isTTY && !!process.stderr.isTTY,
    confirm: promptYesNo,
  };
}

/** Values a workspace or workflow requests that need the user's decision. */
export interface CliTrustRequest {
  /** One line introducing the list, e.g. what is requesting what. */
  heading: string;
  /** The values awaiting a decision, one per line. Empty means none. */
  items: readonly string[];
  /** The full command that reviews these outside a run. */
  reviewCommand: string;
  /** Ask in the terminal and record the answers. */
  ask(io: CliTrustIo): Promise<void>;
}

/** An `ask` that settles the whole list with a single yes/no. */
export function askOnceForAll(
  question: string,
  record: (allow: boolean) => Promise<void>
): CliTrustRequest["ask"] {
  return async (io) => record(await io.confirm(`${question} [y/N] `));
}

/**
 * The gate every `run`-family trust check goes through. With nothing
 * pending it does nothing. In a terminal it lists the values and asks, then
 * lets the run continue, whatever the answer: a denied value stays blocked
 * and the code that uses it enforces that. With no terminal to ask in it
 * fails closed with exit code 2 and names the command that reviews them.
 *
 * Returns `undefined` to proceed, or the exit code to stop with.
 */
export async function ensureCliTrustDecided(
  request: CliTrustRequest,
  io: CliTrustIo
): Promise<number | undefined> {
  if (request.items.length === 0) {
    return undefined;
  }

  io.writeErr(request.heading);
  request.items.forEach((item) => io.writeErr(`  - ${item}`));

  if (!io.isInteractive) {
    io.writeErr(
      `Error: these have not been approved. Run \`${request.reviewCommand}\` to review them.`
    );
    return 2;
  }

  await request.ask(io);
  return undefined;
}
