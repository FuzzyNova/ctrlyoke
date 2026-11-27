/**
 * Lookup and listing shared by every author-declared preset catalog an MCP
 * caller can name (`conditions`, `worktreePresets`). A caller only ever
 * supplies the name, so the lookup reads own properties only: `use:
 * "toString"` must never resolve to an `Object.prototype` member.
 */

/** The preset the workflow declares under `name`, or undefined. */
export function getDeclaredPreset<Preset>(
  presets: Readonly<Record<string, Preset>> | undefined,
  name: string
): Preset | undefined {
  return presets && Object.hasOwn(presets, name) ? presets[name] : undefined;
}

/**
 * The declared presets as a comma-separated list, in declaration order, or
 * "none". `describe` renders one entry; it defaults to the bare name.
 */
export function formatDeclaredPresetList<Preset>(
  presets: Readonly<Record<string, Preset>> | undefined,
  describe: (name: string, preset: Preset) => string = (name) => name
): string {
  const entries = Object.entries(presets ?? {});
  if (entries.length === 0) return "none";
  return entries.map(([name, preset]) => describe(name, preset)).join(", ");
}
