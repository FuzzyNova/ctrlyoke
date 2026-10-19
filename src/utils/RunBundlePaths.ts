/**
 * Path portability for run bundles (dev/backlog/RUN_EXPORT_PLAN.md §2.1).
 *
 * A run's timeline is full of absolute paths: every `CliOutput` carries its
 * `workingDirectory`, tool events carry the paths the harness touched, and
 * response text links files the way the harness wrote them. Export rewrites
 * every path under the workspace to `${workspaceFolder}/<forward/slash/rest>`
 * and every other path under the exporter's home to `~/<rest>`, so a bundle
 * names neither the exporting checkout nor its user. Loading a bundle reverses
 * only the workspace token, onto the loading workspace; `~` is left as written.
 *
 * This works on text, not on known fields, because the same path appears in
 * structured fields, Markdown links, shell commands and JSON nested inside
 * strings. Every spelling one root has in practice is matched: either
 * separator (or a doubled `\\` from nested JSON), any drive-letter case, the
 * MSYS form `/c/dev/x` and the URI-encoded colon of `file:///c%3A/dev/x`.
 * A drive-rooted root matches case-insensitively, like the filesystem it came
 * from; a POSIX root matches exactly. The root's shape decides this, not the
 * current platform, because bundles move between platforms.
 *
 * Uses only Node built-ins so the CLI bundle can load it.
 */

/** Stands in for the exporting workspace root inside a bundle. */
export const BUNDLE_WORKSPACE_TOKEN = "${workspaceFolder}";
/** Stands in for the exporter's home directory inside a bundle. */
export const BUNDLE_HOME_TOKEN = "~";

/** One or more separators; a doubled `\\` is JSON nested inside a string. */
const SEPARATOR = String.raw`[\\/]+`;
/** A character that ends a path inside prose, Markdown, shell, JSON or ANSI output. */
const PATH_DELIMITERS = String.raw`\x00-\x1f\s"'\x60<>|*?:()\[\]{},;`;
const PATH_NAME_CHAR = `[^\\\\/${PATH_DELIMITERS}]`;
/** Everything after the root that still belongs to the same path. */
const PATH_TAIL = `((?:${SEPARATOR}${PATH_NAME_CHAR}*)*)`;
/** The root must end where a path segment ends, so `/x/app` never matches `/x/app2`. */
const ROOT_END = `(?!${PATH_NAME_CHAR})`;

/**
 * The root must start where a word starts. A letter that closes an ANSI
 * escape (`\x1b[90m`) does not count: colored CLI output prints paths right
 * after one.
 */
function notAfter(chars: string): string {
  return String.raw`(?<!(?<!\x1b\[[0-9;]*)${chars})`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rootPattern(root: string): RegExp | undefined {
  const segments = root.split(/[\\/]+/).filter(Boolean);
  const drive = /^([A-Za-z]):$/.exec(segments[0] ?? "");
  if (drive) {
    const letter = drive[1];
    const rest = segments.slice(1).map(escapeRegExp).join(SEPARATOR);
    if (!rest) return undefined;
    // `C:\x`, `c:/x`, `file:///c%3A/x` and MSYS `/c/x`.
    const prefix = `${notAfter("[A-Za-z0-9]")}(?:${letter}(?::|%3A)|${notAfter(String.raw`[\w.~-]`)}/${letter})`;
    return new RegExp(
      `${prefix}${SEPARATOR}${rest}${ROOT_END}${PATH_TAIL}`,
      "gi"
    );
  }
  if (!root.startsWith("/") || segments.length === 0) return undefined;
  const body = segments.map(escapeRegExp).join(SEPARATOR);
  return new RegExp(
    `${notAfter(String.raw`[\w.~-]`)}/${body}${ROOT_END}${PATH_TAIL}`,
    "g"
  );
}

function tokenRewrite(
  root: string,
  token: string
): ((text: string) => string) | undefined {
  const pattern = rootPattern(root);
  if (!pattern) return undefined;
  return (text) =>
    text.replace(
      pattern,
      (_match, tail: string) => `${token}${tail.replace(/[\\/]+/g, "/")}`
    );
}

export interface PortablePathRoots {
  /** Rewritten to `${workspaceFolder}`. */
  workspaceRoot?: string;
  /** Rewritten to `~`; the workspace wins where both apply. */
  homeDir?: string;
}

/** Returns the export-side text transform for one source workspace. */
export function createPortablePathRewriter(
  roots: PortablePathRoots
): (text: string) => string {
  const rewrites = [
    roots.workspaceRoot
      ? tokenRewrite(roots.workspaceRoot, BUNDLE_WORKSPACE_TOKEN)
      : undefined,
    roots.homeDir ? tokenRewrite(roots.homeDir, BUNDLE_HOME_TOKEN) : undefined,
    roots.homeDir ? userNameRewrite(roots.homeDir) : undefined,
  ].filter((rewrite): rewrite is (text: string) => string => !!rewrite);
  return (text) =>
    rewrites.reduce((current, rewrite) => rewrite(current), text);
}

/** Replaces the home folder's name where a home path survived without its separators. */
export const BUNDLE_USER_TOKEN = "<user>";

/** Matches `value` in any letter case without the `i` flag, which would also fold the lookahead. */
function anyCase(value: string): string {
  return [...value]
    .map((char) =>
      char.toLowerCase() !== char.toUpperCase()
        ? `[${char.toLowerCase()}${char.toUpperCase()}]`
        : escapeRegExp(char)
    )
    .join("");
}

/**
 * Catches the home folder's name right after its parent (`Users`, `home`)
 * where a shell ate the separators (`C:UsersalexAppData`), which no path
 * pattern can see. The next character must not continue a lowercase name, so
 * `alexander` is left alone when the user is `alex`.
 */
function userNameRewrite(
  homeDir: string
): ((text: string) => string) | undefined {
  const segments = homeDir.split(/[\\/]+/).filter(Boolean);
  const user = segments.at(-1);
  const parent = segments.at(-2);
  if (!user || !parent || /^[A-Za-z]:$/.test(parent)) return undefined;
  const pattern = new RegExp(
    `(?<![A-Za-z])(${anyCase(parent)}[\\\\/]*)${anyCase(user)}(?![a-z0-9_.-])`,
    "g"
  );
  return (text) => text.replace(pattern, `$1${BUNDLE_USER_TOKEN}`);
}

const WORKSPACE_TOKEN_PATTERN = new RegExp(
  `${escapeRegExp(BUNDLE_WORKSPACE_TOKEN)}${PATH_TAIL}`,
  "g"
);

/**
 * Returns the load-side transform: `${workspaceFolder}/a/b` becomes
 * `<workspaceRoot>/a/b`. The whole result uses `separator`, forward slash by
 * default, which every platform and every consumer of Windows paths here
 * accepts, and which stays valid inside JSON nested in a string, where a
 * restored backslash would become an escape sequence.
 */
export function createWorkspacePathResolver(
  workspaceRoot: string,
  separator: "/" | "\\" = "/"
): (text: string) => string {
  const root = workspaceRoot
    .replace(/[\\/]+$/, "")
    .replace(/[\\/]+/g, separator);
  return (text) =>
    text.includes(BUNDLE_WORKSPACE_TOKEN)
      ? text.replace(
          WORKSPACE_TOKEN_PATTERN,
          (_match, tail: string) => `${root}${tail.replace(/\//g, separator)}`
        )
      : text;
}

/**
 * Applies `transform` to every string in a JSON value, keys excluded, and
 * returns a new value. `key` is the property the string sits under (an array
 * item reports its array's property). The input is not mutated.
 */
export function mapJsonStrings<T>(
  value: T,
  transform: (text: string, key: string | undefined) => string
): T {
  return mapValue(value, undefined, transform) as T;
}

function mapValue(
  value: unknown,
  key: string | undefined,
  transform: (text: string, key: string | undefined) => string
): unknown {
  if (typeof value === "string") return transform(value, key);
  if (Array.isArray(value)) {
    return value.map((item) => mapValue(item, key, transform));
  }
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [childKey, item] of Object.entries(value)) {
    result[childKey] = mapValue(item, childKey, transform);
  }
  return result;
}

const ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/;

/** Whether a rewritten value is still an absolute path, i.e. outside both roots. */
export function isExternalAbsolutePath(value: string): boolean {
  return (
    ABSOLUTE_PATH_PATTERN.test(value) &&
    !value.startsWith(BUNDLE_WORKSPACE_TOKEN) &&
    !value.startsWith(`${BUNDLE_HOME_TOKEN}/`)
  );
}
