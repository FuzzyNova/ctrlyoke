export const HTTP_BYTE_RANGE_RESULT_KINDS = {
  NONE: "none",
  RANGE: "range",
  UNSATISFIABLE: "unsatisfiable",
} as const;

export type HttpByteRangeResult =
  | { kind: typeof HTTP_BYTE_RANGE_RESULT_KINDS.NONE }
  | {
      kind: typeof HTTP_BYTE_RANGE_RESULT_KINDS.RANGE;
      start: number;
      end: number;
    }
  | { kind: typeof HTTP_BYTE_RANGE_RESULT_KINDS.UNSATISFIABLE };

/** Parse a single bytes range. Multiple or malformed ranges are ignored. */
export function parseHttpByteRange(
  header: string | undefined,
  size: number
): HttpByteRangeResult {
  if (!header || !Number.isSafeInteger(size) || size < 0) {
    return { kind: HTTP_BYTE_RANGE_RESULT_KINDS.NONE };
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return { kind: HTTP_BYTE_RANGE_RESULT_KINDS.NONE };

  const [, startText, endText] = match;
  if (!startText && !endText)
    return { kind: HTTP_BYTE_RANGE_RESULT_KINDS.NONE };

  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength)) {
      return { kind: HTTP_BYTE_RANGE_RESULT_KINDS.NONE };
    }
    if (suffixLength === 0 || size === 0) {
      return { kind: HTTP_BYTE_RANGE_RESULT_KINDS.UNSATISFIABLE };
    }
    return {
      kind: HTTP_BYTE_RANGE_RESULT_KINDS.RANGE,
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }

  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0
  ) {
    return { kind: HTTP_BYTE_RANGE_RESULT_KINDS.NONE };
  }
  if (start >= size)
    return { kind: HTTP_BYTE_RANGE_RESULT_KINDS.UNSATISFIABLE };
  if (requestedEnd < start) return { kind: HTTP_BYTE_RANGE_RESULT_KINDS.NONE };
  return {
    kind: HTTP_BYTE_RANGE_RESULT_KINDS.RANGE,
    start,
    end: Math.min(requestedEnd, size - 1),
  };
}
