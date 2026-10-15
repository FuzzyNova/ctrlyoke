import type { CliTrustIo } from "../../cli/CliTrustGate";

/** A scripted terminal: records what was written and answers from a queue. */
export class RecordingCliTrustIo implements CliTrustIo {
  readonly out: string[] = [];
  readonly err: string[] = [];
  readonly questions: string[] = [];

  constructor(
    readonly isInteractive: boolean,
    private readonly answers: boolean[] = []
  ) {}

  writeOut(message: string): void {
    this.out.push(message);
  }

  writeErr(message: string): void {
    this.err.push(message);
  }

  async confirm(question: string): Promise<boolean> {
    this.questions.push(question);
    return this.answers.shift() ?? false;
  }
}
