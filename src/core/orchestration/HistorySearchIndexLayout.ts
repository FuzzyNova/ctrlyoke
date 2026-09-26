/**
 * HistorySearchIndexLayout — where the history search index lives on disk.
 *
 * The index is kept per schema version, under
 * `<projectStateRoot>/.search-index/v<INDEX_SCHEMA_VERSION>/`. The VS Code
 * extension and the npm CLI can run different ctrlyoke versions against one
 * project; with a shared directory, each would find the other's index at the
 * wrong schema and rebuild it on every search
 * (dev/backlog/CLI_DISTRIBUTION_PLAN.md §3.4 rule 4).
 *
 * Directories for versions no live installation uses are pruned after a
 * rebuild. `installations.json` drops a host 30 days after it was last seen,
 * so an index outlives its last user by that long.
 */

import * as fs from "fs";
import * as path from "path";
import type { RunHistoryLocation } from "../../types/CtrlYokeSettings";
import { PATH_CONSTANTS } from "../../utils/ConfigurationUtils";
import { readLiveInstallations } from "../../utils/CtrlyokeInstallations";
import { projectStateRoot } from "../../utils/ProjectStatePaths";

/** Bump for any change to the manifest or document shard format. */
export const INDEX_SCHEMA_VERSION = 1 as const;

const VERSION_DIR_PREFIX = "v";
const VERSION_DIR_PATTERN = /^v\d/u;

/** `<projectStateRoot>/.search-index`, the parent of every version's index. */
export function getSearchIndexRoot(
  workspaceFolderPath: string,
  runHistoryLocation: RunHistoryLocation
): string {
  return path.join(
    projectStateRoot(workspaceFolderPath, runHistoryLocation),
    PATH_CONSTANTS.SEARCH_INDEX_DIR
  );
}

export function searchIndexVersionDirName(version: number): string {
  return `${VERSION_DIR_PREFIX}${version}`;
}

/** This build's index directory. */
export function getSearchIndexDir(
  workspaceFolderPath: string,
  runHistoryLocation: RunHistoryLocation
): string {
  return path.join(
    getSearchIndexRoot(workspaceFolderPath, runHistoryLocation),
    searchIndexVersionDirName(INDEX_SCHEMA_VERSION)
  );
}

/**
 * Remove index directories that no live installation uses. This build's
 * version is always kept. Files from before per-version directories sit
 * directly in the root; they are removed only once every live installation
 * records an index version, since an installation that records none may be an
 * older build still using them. Best effort; never throws.
 */
export async function pruneSearchIndexVersions(
  indexRoot: string
): Promise<void> {
  try {
    const installations = await readLiveInstallations();
    const keep = new Set([searchIndexVersionDirName(INDEX_SCHEMA_VERSION)]);
    let legacyInUse = false;
    for (const installation of installations) {
      if (installation.indexSchemaVersion === undefined) {
        legacyInUse = true;
      } else {
        keep.add(searchIndexVersionDirName(installation.indexSchemaVersion));
      }
    }
    const entries = await fs.promises.readdir(indexRoot, {
      withFileTypes: true,
    });
    await Promise.all(
      entries
        .filter((entry) =>
          entry.isDirectory() && VERSION_DIR_PATTERN.test(entry.name)
            ? !keep.has(entry.name)
            : !legacyInUse
        )
        .map((entry) =>
          fs.promises.rm(path.join(indexRoot, entry.name), {
            recursive: true,
            force: true,
          })
        )
    );
  } catch {
    // Opportunistic cleanup only.
  }
}
