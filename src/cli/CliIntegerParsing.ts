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
  const range =
    minimum !== undefined && maximum !== undefined
      ? `between ${minimum} and ${maximum}`
      : minimum !== undefined
        ? `at least ${minimum}`
        : maximum !== undefined
          ? `at most ${maximum}`
          : "a safe integer";
  if (!/^-?\d+$/.test(value)) {
    throw new InvalidArgumentError(
      `Invalid ${optionName} value "${value}"; expected an integer ${range}.`
    );
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    (minimum !== undefined && parsed < minimum) ||
    (maximum !== undefined && parsed > maximum)
  ) {
    throw new InvalidArgumentError(
      `Invalid ${optionName} value "${value}"; expected an integer ${range}.`
    );
  }
  return parsed;
}
