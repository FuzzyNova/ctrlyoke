import { HARNESS_HOME_ENV_VARS } from "../../utils/HarnessHome";

/** OpenCode's config-file overrides, read alongside its XDG config home. */
const OPENCODE_CONFIG_OVERRIDE_ENV_VARS = [
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
] as const;

/** Variables that point a harness away from the user's home directory. */
const HOME_OVERRIDE_ENV_VARS: readonly string[] = [
  ...Object.values(HARNESS_HOME_ENV_VARS),
  ...OPENCODE_CONFIG_OVERRIDE_ENV_VARS,
];

/**
 * Point `HOME`/`USERPROFILE` at `home` and clear every variable that moves a
 * harness's home (`XDG_CONFIG_HOME`, `CODEX_HOME`, …), so config discovery
 * reads only the fake home. CI runners set some of these (GitHub's Ubuntu
 * images export `XDG_CONFIG_HOME`), so setting `HOME` alone is not enough.
 *
 * `overrides` is applied last; an `undefined` value deletes the variable.
 * Returns a function that restores every variable it touched.
 */
export function useFakeUserHome(
  home: string,
  overrides: Readonly<Record<string, string | undefined>> = {}
): () => void {
  const values: Record<string, string | undefined> = {
    HOME: home,
    USERPROFILE: home,
    ...Object.fromEntries(
      HOME_OVERRIDE_ENV_VARS.map((name) => [name, undefined])
    ),
    ...overrides,
  };
  const previous = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]])
  );
  applyEnv(values);
  return () => applyEnv(previous);
}

function applyEnv(values: Readonly<Record<string, string | undefined>>): void {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
