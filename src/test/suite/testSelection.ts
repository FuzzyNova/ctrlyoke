import * as path from "path";

/**
 * Narrowing an extension-host run to some test files and/or a test-title grep.
 *
 * `runTest.js` runs outside the extension host and the Mocha instance runs
 * inside it, so the selection crosses that boundary as environment variables:
 * `runTest.ts` parses its command line into them, `suite/index.ts` reads them.
 * `MOCHA_GREP` predates the flags and is still honoured when set directly.
 */
export const TEST_SELECTION_ENV = {
  GREP: "MOCHA_GREP",
  /** JSON array of file filters (see `filterTestFiles`). */
  FILES: "CTRLYOKE_TEST_FILES",
} as const;

export interface TestSelection {
  readonly grep?: string;
  readonly files: readonly string[];
}

export const TEST_SELECTION_USAGE = [
  "Usage: npm run test:extension -- [--grep <pattern>] [--file <file>]... [<file>...]",
  "  --grep, -g <pattern>  run only tests whose full title matches (regex)",
  "  --file, -f <file>     run only this test file; repeatable, also positional.",
  "                        Accepts src/test/unit/Foo.test.ts, unit/Foo.test.js,",
  "                        Foo.test.ts, Foo, or a directory such as unit/lsp",
].join("\n");

const GREP_FLAGS = new Set(["--grep", "-g"]);
const FILE_FLAGS = new Set(["--file", "-f"]);

/** Parses `runTest.js`'s arguments; throws on anything it does not understand. */
export function parseTestSelectionArgs(argv: readonly string[]): TestSelection {
  let grep: string | undefined;
  const files: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = equals > 0 ? arg.slice(0, equals) : arg;
    const inline = equals > 0 ? arg.slice(equals + 1) : undefined;
    const takeValue = (): string => {
      const value = inline ?? argv[++index];
      if (value === undefined || value === "") {
        throw new Error(`${flag} needs a value.\n${TEST_SELECTION_USAGE}`);
      }
      return value;
    };
    if (GREP_FLAGS.has(flag)) {
      grep = takeValue();
    } else if (FILE_FLAGS.has(flag)) {
      files.push(takeValue());
    } else if (arg.startsWith("-")) {
      // Silently running the whole suite for a misspelt or unsupported flag is
      // exactly the failure this parser exists to prevent.
      throw new Error(`Unknown option: ${arg}\n${TEST_SELECTION_USAGE}`);
    } else {
      files.push(arg);
    }
  }
  return { grep, files };
}

export function testSelectionToEnv(
  selection: TestSelection
): Record<string, string> {
  const env: Record<string, string> = {};
  if (selection.grep !== undefined)
    env[TEST_SELECTION_ENV.GREP] = selection.grep;
  if (selection.files.length > 0) {
    env[TEST_SELECTION_ENV.FILES] = JSON.stringify(selection.files);
  }
  return env;
}

export function readTestSelection(
  env: Readonly<Record<string, string | undefined>>
): TestSelection {
  const grep = env[TEST_SELECTION_ENV.GREP] || undefined;
  const raw = env[TEST_SELECTION_ENV.FILES];
  if (!raw) return { grep, files: [] };
  const parsed: unknown = JSON.parse(raw);
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry): entry is string => typeof entry === "string")
  ) {
    throw new Error(`${TEST_SELECTION_ENV.FILES} must be a JSON string array`);
  }
  return { grep, files: parsed };
}

const COMPILED_TEST_SUFFIX = ".test.js";

/**
 * Reduces a filter to the compiled-test-root form `testKey` produces: forward
 * slashes, no `src/test/` or `out/test/` prefix, and `.ts` sources named by
 * their compiled `.js` output.
 */
function normalizeFilter(filter: string): string {
  return filter
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^(src|out)\/test\//, "")
    .replace(/\/+$/, "")
    .replace(/\.ts$/, ".js")
    .toLowerCase();
}

function matchesFilter(key: string, filter: string): boolean {
  const lowerKey = key.toLowerCase();
  if (filter.endsWith(COMPILED_TEST_SUFFIX)) {
    return lowerKey === filter || lowerKey.endsWith(`/${filter}`);
  }
  if (lowerKey.startsWith(`${filter}/`)) return true;
  const stem = path.posix
    .basename(lowerKey)
    .slice(0, -COMPILED_TEST_SUFFIX.length);
  return stem === filter;
}

/**
 * Keeps the discovered files at least one filter names. Every filter must match
 * something: a typo that selects nothing would otherwise look like a green run.
 */
export function filterTestFiles(
  files: readonly string[],
  filters: readonly string[],
  keyOf: (file: string) => string
): string[] {
  if (filters.length === 0) return [...files];
  const normalized = filters.map((filter) => ({
    filter,
    match: normalizeFilter(filter),
  }));
  const unmatched = normalized.filter(
    ({ match }) => !files.some((file) => matchesFilter(keyOf(file), match))
  );
  if (unmatched.length > 0) {
    throw new Error(
      `No extension test file matches: ${unmatched.map(({ filter }) => filter).join(", ")}`
    );
  }
  return files.filter((file) =>
    normalized.some(({ match }) => matchesFilter(keyOf(file), match))
  );
}
