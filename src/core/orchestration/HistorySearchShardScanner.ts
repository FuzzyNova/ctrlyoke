import * as fs from "fs/promises";
import * as path from "path";
import type { HistorySearchDocument } from "../../types/WorkflowTimelineTypes";
import { streamFileLines } from "../../utils/TextLines";
import { DOCUMENTS_SHARD_EXTENSION } from "./historySearchRebuildWorker";

const FILE_NOT_FOUND_ERROR_CODE = "ENOENT";
const NON_ASCII_PATTERN = /[^\x00-\x7f]/;

export type HistorySearchLinePrefilter = (rawLine: string) => boolean;
export type HistorySearchDocumentScannedCallback = () => void;

/**
 * Creates the cheap candidate check used before parsing a JSONL document.
 *
 * ASCII queries can be compared against the serialized lowercased text key:
 * JSON.stringify applies the same escaping that was used when the shard was
 * written. Queries containing non-ASCII characters skip the check entirely,
 * because Unicode case folding is not a safe byte-level operation.
 */
export function createHistorySearchLinePrefilter(
  normalizedQuery: string
): HistorySearchLinePrefilter {
  if (NON_ASCII_PATTERN.test(normalizedQuery)) {
    return () => true;
  }

  const serializedLoweredQuery = JSON.stringify(normalizedQuery.toLowerCase());
  const escapedLoweredQuery = serializedLoweredQuery.slice(1, -1);

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
  onDocumentScanned?: HistorySearchDocumentScannedCallback
): AsyncGenerator<HistorySearchDocument, void, undefined> {
  const prefilter = createHistorySearchLinePrefilter(normalizedQuery);
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
