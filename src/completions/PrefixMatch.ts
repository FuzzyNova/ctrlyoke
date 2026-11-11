/** Return whether `value` begins with `prefix`, ignoring locale-aware case. */
export function matchesPrefix(value: string, prefix: string): boolean {
  return value.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase());
}
