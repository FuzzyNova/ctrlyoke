import type { FailureKind, FailureRecord } from "../../../types/CtrlYokeTypes";

/** A typed failure raised while launching a harness process. */
export class CliTransportError extends Error {
  constructor(
    message: string,
    readonly failureKind: FailureKind,
    options?: ErrorOptions,
    readonly failureSource?: FailureRecord["source"],
    readonly failureDetail?: FailureRecord["detail"]
  ) {
    super(message, options);
    this.name = "CliTransportError";
  }
}
