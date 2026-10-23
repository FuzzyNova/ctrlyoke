import * as fs from "fs";

export interface IncrementalJsonlReadResult<TRecord> {
  records: TRecord[];
  nextOffset: number;
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
