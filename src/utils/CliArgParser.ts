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
  let tokenStarted = false;
  let i = 0;
  const len = input.length;

  while (i < len) {
    const ch = input[i];

    if (ch === '"') {
      // Double-quoted string — supports \" escapes inside
      tokenStarted = true;
      i++;
      while (i < len && input[i] !== '"') {
        if (
          input[i] === "\\" &&
          i + 1 < len &&
          (input[i + 1] === '"' || input[i + 1] === "\\")
        ) {
          current += input[i + 1];
          i += 2;
        } else {
          current += input[i++];
        }
      }
      i++; // consume closing "
    } else if (ch === "'") {
      // Single-quoted string — no escape processing inside
      tokenStarted = true;
      i++;
      while (i < len && input[i] !== "'") {
        current += input[i++];
      }
      i++; // consume closing '
    } else if (/\s/.test(ch)) {
      if (tokenStarted) {
        tokens.push(current);
        current = "";
        tokenStarted = false;
      }
      i++;
    } else {
      current += ch;
      tokenStarted = true;
      i++;
    }
  }

  if (tokenStarted) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Whether an `additionalArgs` string passes any of the given flags, either as
 * a separate token (`--settings file`) or inline (`--settings=file`).
 */
export function hasCliFlag(input: string, flags: readonly string[]): boolean {
  return parseArgString(input).some((arg) =>
    flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`))
  );
}

/**
 * The values an `additionalArgs` string gives any of the given flags, in order:
 * `--flag value`, `--flag=value` and, for a one-letter short flag, the attached
 * `-fvalue` form most CLI parsers also accept. A flag with no value after it
 * contributes nothing.
 */
export function getCliFlagValues(
  input: string,
  flags: readonly string[]
): string[] {
  const args = parseArgString(input);
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    for (const flag of flags) {
      if (arg === flag) {
        if (i + 1 < args.length) values.push(args[++i]);
        break;
      }
      if (arg.startsWith(`${flag}=`)) {
        values.push(arg.slice(flag.length + 1));
        break;
      }
      if (isShortFlag(flag) && arg.startsWith(flag)) {
        values.push(arg.slice(flag.length));
        break;
      }
    }
  }
  return values;
}

/** `-c`, not `--config` or Antigravity's single-dash `-settings`. */
function isShortFlag(flag: string): boolean {
  return flag.length === 2 && flag[0] === "-" && flag[1] !== "-";
}

/**
 * Formats argument tokens as a string that {@link parseArgString} can recover.
 * Tokens containing whitespace or quote characters are double-quoted, with
 * backslashes and double quotes escaped for the parser.
 */
export function formatArgString(args: string[]): string {
  return args
    .map((arg) => {
      if (arg.length === 0 || /[\s'"]/.test(arg)) {
        return `"${arg.replace(/[\\"]/g, "\\$&")}"`;
      }
      return arg;
    })
    .join(" ");
}
