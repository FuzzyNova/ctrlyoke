/**
 * JSON with object keys sorted and `undefined` members dropped, so two equal
 * values always serialize — and therefore hash — identically regardless of
 * the order their keys were written in.
 *
 * Node-only and `vscode`-free: shared by config, run storage and the MCP
 * server bundle.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
