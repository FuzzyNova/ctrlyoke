export interface OutputTextPaging {
  cursor?: string;
  limit?: number;
  tail?: number;
}

export interface PagedOutputText {
  text: string;
  nextCursor?: string;
}

export interface OutputTextPagingInput {
  cursor?: string;
  limit?: number;
  tail?: number;
}

/** Parse the shared character paging contract used by CLI and MCP output readers. */
export function parseOutputTextPaging(
  args: OutputTextPagingInput,
  selectedItemCount: number,
  surface: string,
  selectionRequirement = "indices to name exactly one step"
): OutputTextPaging | undefined {
  const hasCursor = args.cursor !== undefined;
  const hasLimit = args.limit !== undefined;
  const hasTail = args.tail !== undefined;
  if (!hasCursor && !hasLimit && !hasTail) return undefined;

  if (hasTail && (hasCursor || hasLimit)) {
    throw new Error(
      `${surface}: tail is mutually exclusive with cursor and limit`
    );
  }
  if (selectedItemCount !== 1) {
    throw new Error(
      `${surface}: cursor, limit, and tail require ${selectionRequirement}`
    );
  }
  if (
    hasCursor &&
    (!/^\d+$/.test(args.cursor!) || !Number.isSafeInteger(Number(args.cursor)))
  ) {
    throw new Error(
      `${surface}: cursor must be a non-negative integer cursor returned by read_output`
    );
  }
  const parseCount = (name: "limit" | "tail"): number | undefined => {
    const count = args[name];
    if (count === undefined) return undefined;
    const isLimit = name === "limit";
    if (!Number.isSafeInteger(count) || count < (isLimit ? 1 : 0)) {
      throw new Error(
        `${surface}: ${name} must be a ${isLimit ? "positive" : "non-negative"} integer`
      );
    }
    return count;
  };
  return {
    ...(hasCursor ? { cursor: args.cursor } : {}),
    ...(hasLimit ? { limit: parseCount("limit")! } : {}),
    ...(hasTail ? { tail: parseCount("tail")! } : {}),
  };
}

/** Slice text on UTF-16 boundaries without splitting surrogate pairs. */
export function pageOutputText(
  text: string,
  paging: OutputTextPaging
): PagedOutputText {
  if (paging.tail !== undefined) {
    const tailStart = movePastSurrogateBoundary(
      text,
      Math.max(0, text.length - paging.tail)
    );
    return { text: paging.tail === 0 ? "" : text.slice(tailStart) };
  }
  const requestedOffset =
    paging.cursor === undefined ? 0 : Number(paging.cursor);
  const offset = movePastSurrogateBoundary(text, requestedOffset);
  const requestedEnd =
    paging.limit === undefined ? undefined : offset + paging.limit;
  const end =
    requestedEnd !== undefined && startsInsideSurrogatePair(text, requestedEnd)
      ? requestedEnd - 1 > offset
        ? requestedEnd - 1
        : requestedEnd + 1
      : requestedEnd;
  const result = text.slice(offset, end);
  return {
    text: result,
    ...(paging.limit !== undefined && end! < text.length
      ? { nextCursor: String(end) }
      : {}),
  };
}

function startsInsideSurrogatePair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const preceding = text.charCodeAt(index - 1);
  const current = text.charCodeAt(index);
  return (
    preceding >= 0xd800 &&
    preceding <= 0xdbff &&
    current >= 0xdc00 &&
    current <= 0xdfff
  );
}

function movePastSurrogateBoundary(text: string, index: number): number {
  return startsInsideSurrogatePair(text, index) ? index + 1 : index;
}
