import * as fs from "fs/promises";
import * as path from "path";
import type { HistorySearchDocument } from "../../types/WorkflowTimelineTypes";
import { streamFileLines } from "../../utils/TextLines";
import {
  DOCUMENTS_SHARD_EXTENSION,
  getDocumentsShardFileName,
  type HistorySearchIndexManifest,
} from "./historySearchRebuildWorker";

const FILE_NOT_FOUND_ERROR_CODE = "ENOENT";
const NON_ASCII_PATTERN = /[^\x00-\x7f]/;

export type HistorySearchLinePrefilter = (rawLine: string) => boolean;
export type HistorySearchDocumentScannedCallback = () => void;

export interface HistorySearchScanOptions {
  /**
   * Whether the shards being scanned carry the serialized `textLower` key,
   * which only exists from index schema 4.2.0 onward. It is false for exactly
   * one window: a schema-upgrading rebuild builds into `rebuild-<ts>/` and
   * swaps at the end, so until that swap the live documents directory still
   * holds pre-4.2.0 shards, and a search running beside it (the
   * `buildInProgress` path in `HistorySearchIndexService.search`) streams
   * them.
   */
  hasPersistedLowercaseKey: boolean;
  /**
   * The loaded index manifest's `indexedRuns`, used to visit shards in
   * descending run `startedAt` order without any extra file reads (see
   * `resolveShardVisitOrder`). Omit only when no manifest could be loaded —
   * every shard is then treated as unresolved and its order derived from its
   * first document instead.
   */
  indexedRuns?: HistorySearchIndexManifest["indexedRuns"];
  /**
   * A previously resolved shard visit order (see `listDocumentShardEntries`),
   * used to scan a specific shard (or a specific resumption slice of the
   * full order) without re-reading the directory or re-deriving every
   * shard's `startedAt`. When omitted, the order is resolved from scratch.
   */
  resolvedShardOrder?: readonly string[];
}

/** One shard in visit order, with the run `startedAt` it was resolved to. */
export interface HistorySearchShardEntry {
  shardName: string;
  startedAt: number;
}

/**
 * Orders shard file names by descending run `startedAt` so that a scan visits
 * newer runs' documents first — the property the primary sort key
 * (`compareMatches`'s `startedAt desc`) needs to hold across shards, which is
 * what lets a later scan stop early once a page is full.
 *
 * `indexedRuns` gives the `startedAt` for every shard the manifest knows about
 * with no extra I/O (one hash per entry, no file reads). A shard present on
 * disk but absent from the manifest — an in-flight write, a manifest that
 * failed to load — is never dropped: its `startedAt` is instead derived by
 * reading its own first document, since every document in a run shares that
 * run's `startedAt`. Ties (including every shard when no manifest is
 * available) fall back to file-name order so the result is deterministic.
 */
export async function resolveShardVisitOrder(
  documentsDirectory: string,
  shardNames: readonly string[],
  indexedRuns: HistorySearchIndexManifest["indexedRuns"] | undefined
): Promise<string[]> {
  const entries = await resolveShardVisitEntries(
    documentsDirectory,
    shardNames,
    indexedRuns
  );
  return entries.map((entry) => entry.shardName);
}

async function resolveShardVisitEntries(
  documentsDirectory: string,
  shardNames: readonly string[],
  indexedRuns: HistorySearchIndexManifest["indexedRuns"] | undefined
): Promise<HistorySearchShardEntry[]> {
  const startedAtByShardName = new Map<string, number>();
  for (const entry of Object.values(indexedRuns ?? {})) {
    startedAtByShardName.set(
      getDocumentsShardFileName(entry.manifestPath),
      entry.startedAt
    );
  }

  const shardsWithStartedAt = await Promise.all(
    shardNames.map(async (shardName) => {
      const knownStartedAt = startedAtByShardName.get(shardName);
      return {
        shardName,
        startedAt:
          knownStartedAt ??
          (await deriveShardStartedAt(
            path.join(documentsDirectory, shardName)
          )),
      };
    })
  );

  return shardsWithStartedAt.sort(
    (left, right) =>
      right.startedAt - left.startedAt ||
      left.shardName.localeCompare(right.shardName)
  );
}

/**
 * Lists every JSONL shard in a documents directory and resolves its visit
 * order and `startedAt`, in one place — the full-index equivalent of
 * `resolveShardVisitOrder`, retained (rather than re-derived per request) so
 * a caller doing early-terminated scanning can compute a resumption index
 * from `startedAt` without re-reading the directory or re-deriving shards
 * already accounted for.
 */
export async function listDocumentShardEntries(
  documentsDirectory: string,
  indexedRuns: HistorySearchIndexManifest["indexedRuns"] | undefined
): Promise<HistorySearchShardEntry[]> {
  let shardEntries: import("fs").Dirent[];
  try {
    shardEntries = await fs.readdir(documentsDirectory, {
      withFileTypes: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === FILE_NOT_FOUND_ERROR_CODE) {
      return [];
    }
    throw error;
  }
  const shardNames = shardEntries
    .filter(
      (entry) =>
        entry.isFile() && entry.name.endsWith(DOCUMENTS_SHARD_EXTENSION)
    )
    .map((entry) => entry.name);
  return resolveShardVisitEntries(documentsDirectory, shardNames, indexedRuns);
}

/**
 * Reads only as far as the first non-blank line of a shard with no manifest
 * entry, to recover the `startedAt` every document in it shares. A shard that
 * cannot be read (deleted between listing and this read) or holds no
 * documents yet sorts last — there is nothing to lose either way, since a
 * shard with no readable documents contributes no matches.
 */
async function deriveShardStartedAt(shardPath: string): Promise<number> {
  try {
    for await (const rawLine of streamFileLines(shardPath)) {
      if (rawLine.trim().length === 0) {
        continue;
      }
      return (JSON.parse(rawLine) as HistorySearchDocument).startedAt;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== FILE_NOT_FOUND_ERROR_CODE) {
      throw error;
    }
  }
  return Number.NEGATIVE_INFINITY;
}

/**
 * Creates the cheap candidate check used before parsing a JSONL document.
 *
 * ASCII queries can be compared against the serialized lowercased text key:
 * JSON.stringify applies the same escaping that was used when the shard was
 * written. Queries containing non-ASCII characters skip the check entirely,
 * because Unicode case folding is not a safe byte-level operation.
 *
 * Without that key the line holds only the original-case `text`, so matching
 * the lowercased query against it would silently drop every document whose
 * stored text is not already lowercase. Those shards fall back to lowercasing
 * the line — the cost this key exists to avoid, paid only while an upgrading
 * rebuild is in flight.
 */
export function createHistorySearchLinePrefilter(
  normalizedQuery: string,
  options: HistorySearchScanOptions
): HistorySearchLinePrefilter {
  if (NON_ASCII_PATTERN.test(normalizedQuery)) {
    return () => true;
  }

  const serializedLoweredQuery = JSON.stringify(normalizedQuery.toLowerCase());
  const escapedLoweredQuery = serializedLoweredQuery.slice(1, -1);

  if (!options.hasPersistedLowercaseKey) {
    return (rawLine) => rawLine.toLowerCase().includes(escapedLoweredQuery);
  }
  return (rawLine) => rawLine.includes(escapedLoweredQuery);
}

/** The outcome of a full, unfiltered shard read (see `readShardDocuments`). */
export interface HistorySearchShardReadResult {
  documents: HistorySearchDocument[];
  /**
   * False when the read stopped before reaching the end of the shard file —
   * cancelled via `signal`, or the shard vanished mid-read (a concurrent
   * rebuild replaces shards by atomic rename, so this is a real, if rare,
   * race rather than a bug). A caller must not cache a partial result: an
   * incomplete document list masquerading as a complete shard would answer
   * every future query for it wrong, not just slowly.
   */
  complete: boolean;
}

/**
 * Reads and parses every document in one shard, with no query prefilter —
 * used only to populate `HistorySearchDocumentCache`, where every document
 * (not just today's query's candidates) needs to be retained for future
 * queries. `streamHistorySearchDocuments` below stays the prefiltered,
 * nothing-retained path for shards the cache has no room for.
 */
export async function readShardDocuments(
  documentsDirectory: string,
  shardName: string,
  signal?: AbortSignal
): Promise<HistorySearchShardReadResult> {
  const documents: HistorySearchDocument[] = [];
  try {
    for await (const rawLine of streamFileLines(
      path.join(documentsDirectory, shardName)
    )) {
      if (signal?.aborted) {
        return { documents, complete: false };
      }
      if (rawLine.trim().length === 0) {
        continue;
      }
      documents.push(JSON.parse(rawLine) as HistorySearchDocument);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== FILE_NOT_FOUND_ERROR_CODE) {
      throw error;
    }
    return { documents, complete: false };
  }
  return { documents, complete: !signal?.aborted };
}

/**
 * Streams candidate documents from every JSONL shard in a directory.
 * Documents are parsed only after the raw-line prefilter passes, and no
 * parsed documents are retained by this generator.
 *
 * `signal`, when provided and already or later aborted, stops the scan
 * between shards **and** between lines — a shard-only check still leaves a
 * multi-second tail on a large shard, which is long enough to matter when a
 * superseded query is being cancelled in favor of a newer one.
 */
export async function* streamHistorySearchDocuments(
  documentsDirectory: string,
  normalizedQuery: string,
  options: HistorySearchScanOptions,
  onDocumentScanned?: HistorySearchDocumentScannedCallback,
  signal?: AbortSignal
): AsyncGenerator<HistorySearchDocument, void, undefined> {
  const prefilter = createHistorySearchLinePrefilter(normalizedQuery, options);
  const shardNames =
    options.resolvedShardOrder ??
    (
      await listDocumentShardEntries(documentsDirectory, options.indexedRuns)
    ).map((entry) => entry.shardName);

  for (const shardName of shardNames) {
    if (signal?.aborted) {
      return;
    }
    try {
      for await (const rawLine of streamFileLines(
        path.join(documentsDirectory, shardName)
      )) {
        if (signal?.aborted) {
          return;
        }
        if (rawLine.trim().length === 0) {
          continue;
        }
        onDocumentScanned?.();
        if (!prefilter(rawLine)) {
          continue;
        }
        yield JSON.parse(rawLine) as HistorySearchDocument;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== FILE_NOT_FOUND_ERROR_CODE) {
        throw error;
      }
    }
  }
}
