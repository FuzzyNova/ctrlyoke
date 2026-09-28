import type { FailureKind } from "../../../types/CtrlYokeTypes";

/** A typed failure raised while launching a harness process. */
export class CliTransportError extends Error {
  constructor(
    message: string,
    readonly failureKind: FailureKind,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "CliTransportError";
  }
}
