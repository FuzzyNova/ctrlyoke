import * as path from "node:path";

/** Resolve a CLI file argument using the shell's process working directory. */
export function resolveCliFileArgument(file: string): string {
  return path.resolve(file);
}
