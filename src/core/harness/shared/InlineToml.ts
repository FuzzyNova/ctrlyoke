/** Encode a JavaScript string as a TOML basic string. */
export function quoteTomlBasicString(value: string): string {
  return JSON.stringify(value);
}
