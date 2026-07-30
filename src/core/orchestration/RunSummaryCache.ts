import * as fs from "fs/promises";
import * as path from "path";
import type { RunSummaryRecord } from "./OutputHistoryManager";

/**
 * Process-wide cache for the manifest + working-file pair behind one run's
 * `RunSummary`.
 *
 * `OutputHistoryManager.getRunSummaries` reads **two files per run in the
 * lineage**, and retention is off by default (`runs.maxRuns: -1`), so that cost
 * grows without bound while the runs themselves stop changing the moment they
 * finish. Every run-view load and every definition mutation pays it.
 *
 * Cached values are display metadata only — harness/model disclosure and the
 * run's lifecycle state. The addressed run's own definition, its timeline, and
 * the lineage descriptor are deliberately **not** cached, because those carry
 * the optimistic-concurrency state that mutations are validated against. Keep it
 * that way: **no cached value may ever participate in a revision check.** The
 * worst a stale entry can then do is show a wrong badge in the run list until
 * the next load, never reject an edit or lose one.
 *
 * The lineage's run *listing* (`getRunsForWorkflow`'s readdir) is likewise
 * uncached — it is one syscall rather than O(runs), and it must never lag a
 * promotion. It also means a deleted run needs no eviction: it simply stops
 * appearing, and its orphaned entry is never consulted again.
 *
 * ## Staying fresh
 *
 * Three mechanisms, each covering the others' gap:
 *
 * 1. **Write-through invalidation** for in-process writes, hooked at the two
 *    single writers of the cached files — `writeWorkingFileAtomicTo` in
 *    `WorkingFileManager` and `TimelineRecorder.writeManifestDirect`. Precise
 *    and immediate. Hook new writers there, never at the mutation handler:
 *    the executor's per-step `_runtime` writes never reach `invalidateRunViews`.
 * 2. **Stamp validation on read** (below), the only mechanism that can see a
 *    write from another process — the CLI binary, the MCP server, the hosted
 *    server, or a hand-edited file.
 * 3. **The CLI-owned run's existing watcher** (`CliWatchSession`), which covers
 *    the one out-of-process writer that writes in a tight loop.
 *
 * Mechanism 2 cannot stand alone, which is why 1 and 3 exist: Windows sets file
 * timestamps from a system clock that ticks at ~15.6 ms, so two writes inside
 * one tick share an mtime exactly. `size` narrows that window but does not close
 * it, and an executing run is written far faster than 15.6 ms apart.
 */

/** Identity of one file version. */
interface FileStamp {
  mtimeMs: number;
  size: number;
}

/**
 * Identity of the pair a summary is derived from. `null` means the file is
 * absent, which is a legitimate cacheable state — `readRunFileSummaryFields`
 * falls back to the manifest for a run that never wrote a working file.
 */
export interface RunFilesStamp {
  manifest: FileStamp | null;
  definition: FileStamp | null;
}

interface CacheEntry {
  stamp: RunFilesStamp;
  record: RunSummaryRecord;
}

/**
 * Bounded because nothing else evicts: entries are small, but a long session
 * across many lineages would otherwise grow the extension host's heap forever,
 * and this host is already OOM-sensitive. Insertion order is LRU order — a hit
 * re-inserts.
 */
const MAX_ENTRIES = 500;

const entries = new Map<string, CacheEntry>();

/**
 * Windows paths compare case-insensitively, and these keys arrive from both
 * `WorkflowPaths` helpers and a watcher's own URI — a casing difference would
 * silently split one run into two entries, so an invalidation could miss the
 * entry a read had stored.
 */
function cacheKey(runDirectoryPath: string): string {
  const resolved = path.resolve(runDirectoryPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function stampFile(filePath: string): Promise<FileStamp | null> {
  try {
    const stat = await fs.stat(filePath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

/**
 * Stamps both files a run summary is read from.
 *
 * Callers must stamp **before** reading. A write that lands between the stamp
 * and the read then stores an older stamp against newer content, which costs
 * one spurious miss on the next read; stamping afterwards would store a newer
 * stamp against content read before it and serve that stale record until the
 * following write.
 */
export async function stampRunFiles(
  manifestPath: string,
  definitionPath: string
): Promise<RunFilesStamp> {
  const [manifest, definition] = await Promise.all([
    stampFile(manifestPath),
    stampFile(definitionPath),
  ]);
  return { manifest, definition };
}

function sameStamp(a: FileStamp | null, b: FileStamp | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/** The cached record for this run, if both files still match `stamp`. */
export function lookupRunSummary(
  runDirectoryPath: string,
  stamp: RunFilesStamp
): RunSummaryRecord | undefined {
  const key = cacheKey(runDirectoryPath);
  const entry = entries.get(key);
  if (!entry) {
    return undefined;
  }
  if (
    !sameStamp(entry.stamp.manifest, stamp.manifest) ||
    !sameStamp(entry.stamp.definition, stamp.definition)
  ) {
    entries.delete(key);
    return undefined;
  }
  entries.delete(key);
  entries.set(key, entry);
  return entry.record;
}

/** Stores a freshly read record against the stamp it was read at. */
export function storeRunSummary(
  runDirectoryPath: string,
  stamp: RunFilesStamp,
  record: RunSummaryRecord
): void {
  const key = cacheKey(runDirectoryPath);
  entries.delete(key);
  entries.set(key, { stamp, record });
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    entries.delete(oldest);
  }
}

/**
 * Drops the entry for whichever run directory contains `filePath` — the
 * manifest and the working file are siblings inside it, so either writer can
 * call this with its own path. A path outside any cached run (a draft, a
 * staging directory) is a harmless no-op.
 */
export function invalidateRunSummaryFor(filePath: string): void {
  entries.delete(cacheKey(path.dirname(filePath)));
}

/** Drops every entry. For host disposal and tests. */
export function clearRunSummaryCache(): void {
  entries.clear();
}

/** @internal test seam — the cache is otherwise unobservable. */
export function runSummaryCacheSize(): number {
  return entries.size;
}
