import * as fs from "fs";

/** Return the first existing worker script path from the ordered candidates. */
export function findExistingWorkerPath(
  candidates: readonly string[]
): string | undefined {
  return candidates.find((candidate) => fs.existsSync(candidate));
}
