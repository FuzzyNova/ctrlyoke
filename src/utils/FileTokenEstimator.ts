import * as fs from "fs";
import { encode } from "gpt-tokenizer";
import {
  ESTIMATED_CHARS_PER_TOKEN,
  MAX_CONTENT_SIZE,
} from "../types/DashboardConstants";

export interface FileTokenEstimate {
  /** Token count — exact (tokenized) at or under MAX_CONTENT_SIZE, approximate above it. */
  tokens: number;
  byteCount: number;
  mtimeMs: number;
  /** True when `tokens` is a size-based approximation rather than an exact tokenization. */
  estimated: boolean;
}

/**
 * Single-sourced token estimate for a file's content, shared between the live
 * editor attachment counter (`PromptEditorSupportService`/`ContextExpander`)
 * and the dry-run preview's Tier 1 file-reference estimate
 * (`CliPromptPreparer`), so both surfaces report the same number for the same
 * file.
 *
 * Files at or under MAX_CONTENT_SIZE are read and tokenized exactly with
 * gpt-tokenizer. Larger files are never read into memory — a single huge
 * allocation is the documented extension-host OOM failure mode (a 10 GB
 * attachment read in one `readFile` call) — and instead get a size-based
 * approximation from `stat()` alone, using the same ~4-characters-per-token
 * heuristic `PromptFileSplitter.countTokens` already falls back to when the
 * real tokenizer throws.
 */
export async function estimateFileTokens(
  absolutePath: string
): Promise<FileTokenEstimate> {
  const stat = await fs.promises.stat(absolutePath);
  if (stat.size <= MAX_CONTENT_SIZE) {
    const content = await fs.promises.readFile(absolutePath, "utf8");
    return {
      tokens: encode(content).length,
      byteCount: stat.size,
      mtimeMs: stat.mtimeMs,
      estimated: false,
    };
  }
  return {
    tokens: Math.ceil(stat.size / ESTIMATED_CHARS_PER_TOKEN),
    byteCount: stat.size,
    mtimeMs: stat.mtimeMs,
    estimated: true,
  };
}
