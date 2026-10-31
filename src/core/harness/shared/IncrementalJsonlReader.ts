import * as fs from "fs";

export interface IncrementalJsonlReadResult<TRecord> {
  records: TRecord[];
  nextOffset: number;
}

const FIRST_RECORD_CHUNK_BYTES = 64 * 1024;
/** Harness headers can embed whole instruction files, so allow a large first line. */
const FIRST_RECORD_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Parse the first complete line of a JSONL file, however long it is (up to
 * `maxBytes`). Returns undefined while that line is still being written, when
 * it is malformed, or when the file does not exist.
 */
export async function readFirstJsonlRecord(
  filePath: string,
  maxBytes = FIRST_RECORD_MAX_BYTES
): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof fs.promises.open>>;
  try {
    handle = await fs.promises.open(filePath, "r");
  } catch {
    return undefined;
  }
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < maxBytes) {
      const chunk = Buffer.allocUnsafe(
        Math.min(FIRST_RECORD_CHUNK_BYTES, maxBytes - total)
      );
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) return undefined;
      const filled = chunk.subarray(0, bytesRead);
      const newline = filled.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(filled.subarray(0, newline));
        try {
          return JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return undefined;
        }
      }
      chunks.push(filled);
      total += bytesRead;
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

/** Read and parse only complete JSONL records appended at or after `fromOffset`. */
export async function readIncrementalJsonl<TRecord>(
  filePath: string,
  fromOffset: number,
  isRecord: (value: unknown) => value is TRecord
): Promise<IncrementalJsonlReadResult<TRecord>> {
  let handle: Awaited<ReturnType<typeof fs.promises.open>>;
  try {
    handle = await fs.promises.open(filePath, "r");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { records: [], nextOffset: fromOffset };
    }
    throw error;
  }

  try {
    const { size } = await handle.stat();
    const byteCount = Math.max(0, size - fromOffset);
    if (byteCount === 0) return { records: [], nextOffset: fromOffset };

    const appended = Buffer.allocUnsafe(byteCount);
    let bytesRead = 0;
    while (bytesRead < byteCount) {
      const result = await handle.read(
        appended,
        bytesRead,
        byteCount - bytesRead,
        fromOffset + bytesRead
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }

    const available = appended.subarray(0, bytesRead);
    const lastNewline = available.lastIndexOf(0x0a);
    if (lastNewline < 0) return { records: [], nextOffset: fromOffset };

    const completeBytes = available.subarray(0, lastNewline + 1);
    const records: TRecord[] = [];
    for (const line of completeBytes.toString("utf8").split(/\r?\n/u)) {
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (isRecord(value)) records.push(value);
      } catch {
        // Ignore malformed complete lines and continue with later records.
      }
    }
    return {
      records,
      nextOffset: fromOffset + completeBytes.length,
    };
  } finally {
    await handle.close();
  }
}
