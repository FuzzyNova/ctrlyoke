import * as fs from "fs";
import * as path from "path";

/**
 * Splitting the extension-host suite across VS Code instances, and the
 * recorded timings that make the split even.
 *
 * Balance is the whole game: the run is only as fast as its slowest shard, so a
 * six-way split that puts three minutes of work in one shard and one minute in
 * another buys far less than the six processes suggest. That is exactly what
 * splitting on compiled file size produced -- size turned out to be a poor
 * proxy for runtime, because the slow files in this tree are slow for waiting
 * on spawned CLIs and timers, not for being large. So each shard records how
 * long its files actually took and the next run splits on that, falling back to
 * file size only when there is nothing recorded yet.
 */

/** Where merged timings live: outside `out/`, which `precompile-tests` wipes. */
export function timingsPath(repoRoot: string): string {
  return path.join(repoRoot, ".vscode-test", "ctrlyoke-test-timings.json");
}

function shardTimingsPath(repoRoot: string, shardIndex: number): string {
  return path.join(
    repoRoot,
    ".vscode-test",
    `ctrlyoke-test-timings.shard-${shardIndex}.json`
  );
}

/** Recorded milliseconds per test file, keyed by `testKey`. */
export type TestTimings = Record<string, number>;

/**
 * Keys are relative to the compiled test root with forward slashes, so the file
 * survives being read on another platform or from another checkout.
 */
export function testKey(testsRoot: string, file: string): string {
  return path.relative(testsRoot, file).split(path.sep).join("/");
}

export function readTimings(file: string): TestTimings {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    const timings: TestTimings = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        timings[key] = value;
      }
    }
    return timings;
  } catch {
    // No timings yet, or a half-written file from an interrupted run. Either
    // way the caller falls back to file size -- this is an optimization, and it
    // must never be able to fail a run.
    return {};
  }
}

export function writeShardTimings(
  repoRoot: string,
  shardIndex: number,
  timings: TestTimings
): void {
  const file = shardTimingsPath(repoRoot, shardIndex);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(timings, undefined, 2));
  } catch {
    // Best effort; a shard that cannot record its timings still ran its tests.
  }
}

/**
 * Folds each shard's recorded timings into the single file the next run reads,
 * and removes the per-shard files.
 *
 * Shards only ever cover disjoint files, so the merge is a plain union -- but
 * it starts from the existing merged file so a `MOCHA_GREP`-narrowed run, which
 * legitimately times only a handful of files, tops up the record instead of
 * replacing it with a near-empty one.
 */
export function mergeShardTimings(
  repoRoot: string,
  shardCount: number
): TestTimings {
  const merged = readTimings(timingsPath(repoRoot));
  for (let shardIndex = 0; shardIndex < shardCount; shardIndex++) {
    const file = shardTimingsPath(repoRoot, shardIndex);
    Object.assign(merged, readTimings(file));
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // A leftover shard file is only ever re-read and re-merged.
    }
  }
  try {
    const target = timingsPath(repoRoot);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(merged, undefined, 2));
  } catch {
    // Best effort -- the next run just splits on file size instead.
  }
  return merged;
}

/**
 * Picks the weight function for a split: recorded milliseconds when the record
 * covers most of the files, otherwise compiled file size.
 *
 * The two are never mixed, because they are not in the same units -- a run
 * weighing some files in milliseconds and the rest in bytes would be worse
 * balanced than one using either alone. A file the record misses (newly added,
 * or skipped by a grep) is weighed at the median of the recorded files, so it
 * is treated as ordinary work rather than as free.
 */
export function createWeigher(
  files: readonly string[],
  timings: TestTimings,
  keyOf: (file: string) => string
): (file: string) => number {
  const recorded = files
    .map((file) => timings[keyOf(file)])
    .filter((value): value is number => value !== undefined);
  if (recorded.length * 2 < files.length) return statSize;

  const sorted = [...recorded].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return (file) => timings[keyOf(file)] ?? median;
}

/**
 * Splits `files` into `count` disjoint slices and returns the one a given
 * extension host owns.
 *
 * Longest-first greedy bin packing: repeatedly give the heaviest remaining file
 * to the lightest shard. Ties break on how many files a shard already holds, so
 * a run with no weights at all (nothing recorded, every size equal) still
 * spreads the files instead of piling them into the first shard.
 *
 * Callers must pass a stably ordered list -- glob stream order is
 * filesystem-dependent, and the split has to come out identical in every host
 * or files get run twice or not at all.
 */
export function selectShardFiles(
  files: readonly string[],
  index: number,
  count: number,
  weigh: (file: string) => number = statSize
): string[] {
  if (count <= 1) return [...files];

  const weighted = files
    .map((file) => ({ file, weight: weigh(file) }))
    .sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file));

  const buckets: string[][] = Array.from({ length: count }, () => []);
  const loads = new Array<number>(count).fill(0);
  for (const { file, weight } of weighted) {
    let lightest = 0;
    for (let bucket = 1; bucket < count; bucket++) {
      if (
        loads[bucket] < loads[lightest] ||
        (loads[bucket] === loads[lightest] &&
          buckets[bucket].length < buckets[lightest].length)
      ) {
        lightest = bucket;
      }
    }
    buckets[lightest].push(file);
    loads[lightest] += weight;
  }
  return buckets[index] ?? [];
}

/** Reads an integer shard coordinate from the environment, with a fallback. */
export function shardCoordinate(
  value: string | undefined,
  fallback: number
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function statSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}
