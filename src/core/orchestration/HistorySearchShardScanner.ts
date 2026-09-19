import * as fs from "fs/promises";
import * as path from "path";
import type { HistorySearchDocument } from "../../types/WorkflowTimelineTypes";
import { streamFileLines } from "../../utils/TextLines";
import { DOCUMENTS_SHARD_EXTENSION } from "./historySearchRebuildWorker";

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

/**
 * Streams candidate documents from every JSONL shard in a directory.
 * Documents are parsed only after the raw-line prefilter passes, and no
 * parsed documents are retained by this generator.
 */
export async function* streamHistorySearchDocuments(
  documentsDirectory: string,
  normalizedQuery: string,
  options: HistorySearchScanOptions,
  onDocumentScanned?: HistorySearchDocumentScannedCallback
): AsyncGenerator<HistorySearchDocument, void, undefined> {
  const prefilter = createHistorySearchLinePrefilter(normalizedQuery, options);
  let shardEntries: import("fs").Dirent[];
  try {
    shardEntries = await fs.readdir(documentsDirectory, {
      withFileTypes: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === FILE_NOT_FOUND_ERROR_CODE) {
      return;
    }
    throw error;
  }
  const shardNames = shardEntries
    .filter(
      (entry) =>
        entry.isFile() && entry.name.endsWith(DOCUMENTS_SHARD_EXTENSION)
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  for (const shardName of shardNames) {
    try {
      for await (const rawLine of streamFileLines(
        path.join(documentsDirectory, shardName)
      )) {
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
