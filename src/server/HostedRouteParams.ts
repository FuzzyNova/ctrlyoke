export function optionalTrimmedQueryString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmedValue = value.trim();
  return trimmedValue || undefined;
}

export function optionalNonEmptyQueryString(
  value: unknown
): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function parseHostedRoutePagingParams(
  offsetValue: unknown,
  pageSizeValue: unknown
): { offset: number; pageSize: number | undefined } {
  const rawOffset = typeof offsetValue === "string" ? offsetValue : "0";
  const rawPageSize =
    typeof pageSizeValue === "string" ? pageSizeValue : undefined;

  return {
    offset: Number.parseInt(rawOffset, 10),
    pageSize:
      rawPageSize === undefined ? undefined : Number.parseInt(rawPageSize, 10),
  };
}
