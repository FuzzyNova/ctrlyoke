#!/usr/bin/env node
/**
 * Deletes stale ctrlyoke test-fixture directories left behind in the OS temp
 * folder by an `npm test` run that never reached its own teardown -- an
 * extension-host OOM crash, a killed shard, Ctrl+C, or `--bail` cutting the
 * remaining suites short. src/test/helpers/tempWorkspace.ts's per-test
 * cleanup handles the normal case; this is the safety net for the abnormal
 * one, since a crashed process can never run its own `afterEach`.
 *
 * Every fixture this project creates under os.tmpdir() uses one of the
 * prefixes below, so anything old enough to not belong to a run still in
 * flight is safe to remove outright.
 */
import { lstatSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Every prefix a ctrlyoke test or build script mkdtemps under os.tmpdir(). */
export const STALE_TEMP_PREFIXES = ["cy-", "ctrlyoke-", "step-palette-"];

/**
 * Longer than any suite `npm test` runs takes (the full concurrent run is a
 * few minutes; `test:harness`, which is not part of `npm test`, has its own
 * 15-minute timeout) so a run that is still in flight is never touched.
 */
export const STALE_TEMP_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** Directories under `root` old enough and prefixed to be safe to delete. */
export function findStaleTempDirs({
  root = tmpdir(),
  now = Date.now(),
  maxAgeMs = STALE_TEMP_MAX_AGE_MS,
} = {}) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const stale = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!STALE_TEMP_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) {
      continue;
    }
    const fullPath = join(root, entry.name);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (now - stat.mtimeMs < maxAgeMs) continue;
    stale.push(fullPath);
  }
  return stale;
}

/**
 * Unlinks every symlink and junction under `dir` without touching targets;
 * false if one could not be removed. Node 24's recursive `rmSync` deletes
 * *through* a Windows junction, and a fixture left by a crashed run can hold
 * one into the repo (the TypeScript language-server test junctions
 * `node_modules/typescript`). Mirrors `removeTempDir` in
 * src/test/helpers/tempWorkspace.ts, which the extension tests can't share.
 */
function unlinkLinksInTree(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return true;
  }
  let allUnlinked = true;
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    let stat;
    try {
      stat = lstatSync(entryPath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      try {
        unlinkSync(entryPath);
      } catch {
        allUnlinked = false;
      }
    } else if (stat.isDirectory() && !unlinkLinksInTree(entryPath)) {
      allUnlinked = false;
    }
  }
  return allUnlinked;
}

/** Removes every stale directory found, best-effort. Never throws. */
export function cleanStaleTestTempDirs(options) {
  const stale = findStaleTempDirs(options);
  let removed = 0;
  for (const dir of stale) {
    try {
      // A surviving link would let the recursive delete reach its target.
      if (!unlinkLinksInTree(dir)) continue;
      rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
      removed += 1;
    } catch {
      // Best-effort; a run that is somehow still using it is untouched, and
      // it stays a candidate for the next sweep.
    }
  }
  return { found: stale.length, removed };
}

function main() {
  const root = tmpdir();
  const { found, removed } = cleanStaleTestTempDirs({ root });
  if (found > 0) {
    process.stdout.write(
      `clean-stale-test-temp: removed ${removed}/${found} stale test temp dir(s) from ${root}\n`
    );
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
