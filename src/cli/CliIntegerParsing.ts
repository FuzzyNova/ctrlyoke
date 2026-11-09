import { InvalidArgumentError } from "commander";

export interface StrictIntegerOptions {
  minimum?: number;
  maximum?: number;
}

/** Parse decimal integer text without accepting Number()'s alternate formats. */
export function parseStrictInteger(
  value: string,
  optionName: string,
  options: StrictIntegerOptions = {}
): number {
  const { minimum, maximum } = options;
  const expected =
    minimum !== undefined && maximum !== undefined
      ? `an integer between ${minimum} and ${maximum}`
      : minimum !== undefined
        ? `an integer of at least ${minimum}`
        : maximum !== undefined
          ? `an integer of at most ${maximum}`
          : "a safe integer";
  if (!/^-?\d+$/.test(value)) {
    throw new InvalidArgumentError(
      `Invalid ${optionName} value "${value}"; expected ${expected}.`
    );
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    (minimum !== undefined && parsed < minimum) ||
    (maximum !== undefined && parsed > maximum)
  ) {
    throw new InvalidArgumentError(
      `Invalid ${optionName} value "${value}"; expected ${expected}.`
    );
  }
  return parsed;
}
