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
import { readdirSync, rmSync, statSync } from "node:fs";
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

/** Removes every stale directory found, best-effort. Never throws. */
export function cleanStaleTestTempDirs(options) {
  const stale = findStaleTempDirs(options);
  let removed = 0;
  for (const dir of stale) {
    try {
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
