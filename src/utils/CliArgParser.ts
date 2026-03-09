/**
 * Parses a shell-style argument string into an array of tokens.
 *
 * Supports:
 * - Whitespace-separated tokens
 * - Double-quoted strings preserved as single token: `--arg "foo bar"` → `["--arg", "foo bar"]`
 * - Single-quoted strings preserved: `--config '{"key":"val"}'` → `["--config", '{"key":"val"}']`
 * - Escaped quotes within double-quoted strings: `"foo \"bar\""` → `['foo "bar"']`
 *
 * Does NOT support bash substitution, backticks, or environment variable expansion.
 * Inputs are expected to be static strings from YAML — this is intentional.
 *
 * @param input The raw argument string to parse (e.g., `--effort high --max-turns 10`)
 * @returns Array of parsed tokens
 */
export function parseArgString(input: string): string[] {
  if (!input || input.trim().length === 0) {
    return [];
  }

  const tokens: string[] = [];
  let current = "";
  let i = 0;
  const len = input.length;

  while (i < len) {
    const ch = input[i];

    if (ch === '"') {
      // Double-quoted string — supports \" escapes inside
      i++;
      while (i < len && input[i] !== '"') {
        if (input[i] === "\\" && i + 1 < len && input[i + 1] === '"') {
          current += '"';
          i += 2;
        } else {
          current += input[i++];
        }
      }
      i++; // consume closing "
    } else if (ch === "'") {
      // Single-quoted string — no escape processing inside
      i++;
      while (i < len && input[i] !== "'") {
        current += input[i++];
      }
      i++; // consume closing '
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      i++;
    } else {
      current += ch;
      i++;
    }
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}
