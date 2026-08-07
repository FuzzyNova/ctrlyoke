import { encode } from "gpt-tokenizer";
import { Log } from "./Log";

// gpt-tokenizer applies BPE merges to each regex match. A large minified or
// same-character input can become one enormous match and make the merge pass
// effectively block the extension host. Chunking is conservative (a boundary
// can prevent a merge and slightly over-count) and keeps every tokenizer call
// bounded without weakening the configured per-file limits.
const MAX_TOKENIZER_INPUT_CHARS = 8 * 1024;
const TOKENIZER_BOUNDARY_RESERVE_RATIO = 0.01;

/**
 * Result of prompt splitting operation
 */
export interface SplitResult {
  /** Whether splitting was needed */
  needsSplit: boolean;

  /** Array of prompt chunks (length 1 if no split needed) */
  chunks: string[];

  /** Token counts for each chunk */
  tokenCounts: number[];

  /** Line counts for each chunk */
  lineCounts: number[];
}

/**
 * Configuration for prompt splitting
 */
export interface SplitConfig {
  /** Maximum tokens per file (default: 15000) */
  maxTokensPerFile?: number;

  /** Maximum lines per file (default: 1800, 90% of Claude's 2K limit) */
  maxLinesPerFile?: number;

  /** Minimum chunk size to avoid tiny fragments (default: 3000) */
  minChunkSize?: number;

  /**
   * When true, prefer splitting on </attachment> boundaries so that each
   * <attachment>…</attachment> block is kept atomic and never split mid-way.
   * Falls back to paragraph splitting for oversized individual attachments.
   * (default: true)
   */
  splitOnAttachmentBoundaries?: boolean;
}

/**
 * PromptFileSplitter - Intelligently splits large prompts into multiple files
 *
 * Splits on paragraph boundaries first, then lines, then sentences to preserve structure.
 * Conservative defaults work for both Copilot and Claude CLI harnesses.
 *
 * Claude CLI has a 2,000 line limit per request; other limits depend on underlying model context windows.
 */
export class PromptFileSplitter {
  private readonly config: Required<SplitConfig>;

  // Conservative defaults: avoid Claude's 2K line limit, keep file sizes manageable
  private static readonly DEFAULT_CONFIG: Required<SplitConfig> = {
    maxTokensPerFile: 10000, // Claude Code CLI limit is 10K tokens per file
    maxLinesPerFile: 1800, // 90% of Claude's 2K line limit
    minChunkSize: 3000,
    splitOnAttachmentBoundaries: true,
  };

  constructor(config?: SplitConfig) {
    this.config = {
      ...PromptFileSplitter.DEFAULT_CONFIG,
      ...config,
    };
  }

  /**
   * Bounded tokenization can conservatively count a few extra tokens where an
   * artificial boundary prevents a BPE merge. Reserve a small packing margin
   * so the published chunk counts still honor maxTokensPerFile.
   */
  private get packingTokenLimit(): number {
    return Math.max(
      1,
      Math.floor(
        this.config.maxTokensPerFile * (1 - TOKENIZER_BOUNDARY_RESERVE_RATIO)
      )
    );
  }

  /**
   * Check if prompt needs splitting based on token/line limits
   */
  needsSplitting(promptText: string): boolean {
    const tokens = this.countTokens(promptText);
    const lines = this.countLines(promptText);

    return (
      tokens > this.config.maxTokensPerFile ||
      lines > this.config.maxLinesPerFile
    );
  }

  /**
   * Split prompt into chunks if needed, preserving structure.
   *
   * When splitOnAttachmentBoundaries is enabled (default), first attempts to
   * split on </attachment> tag boundaries so no attachment block is ever split
   * mid-way. Falls back to paragraph splitting for text without attachments or
   * for oversized individual attachment blocks.
   */
  split(promptText: string): SplitResult {
    const totalTokens = this.countTokens(promptText);
    const totalLines = this.countLines(promptText);

    // Check if splitting needed
    if (
      totalTokens <= this.config.maxTokensPerFile &&
      totalLines <= this.config.maxLinesPerFile
    ) {
      return {
        needsSplit: false,
        chunks: [promptText],
        tokenCounts: [totalTokens],
        lineCounts: [totalLines],
      };
    }

    // Try attachment-boundary splitting first (keeps attachment blocks atomic)
    if (this.config.splitOnAttachmentBoundaries) {
      const attachmentChunks = this.splitOnAttachmentBoundaries(promptText);
      if (attachmentChunks && attachmentChunks.length > 1) {
        Log.debug(
          `[PromptFileSplitter] Split at ${attachmentChunks.length} attachment boundaries`
        );
        const tokenCounts = attachmentChunks.map((c) => this.countTokens(c));
        const lineCounts = attachmentChunks.map((c) => this.countLines(c));
        return {
          needsSplit: true,
          chunks: attachmentChunks,
          tokenCounts,
          lineCounts,
        };
      }
    }

    // Fall back to paragraph splitting
    const chunks = this.splitIntoChunks(promptText);

    // Calculate stats for each chunk
    const tokenCounts = chunks.map((chunk) => this.countTokens(chunk));
    const lineCounts = chunks.map((chunk) => this.countLines(chunk));

    return {
      needsSplit: true,
      chunks,
      tokenCounts,
      lineCounts,
    };
  }

  /**
   * Count tokens using gpt-tokenizer
   * Falls back to character approximation if tokenizer fails
   */
  private countTokens(text: string): number {
    try {
      if (text.length <= MAX_TOKENIZER_INPUT_CHARS) {
        return encode(text).length;
      }

      let tokenCount = 0;
      for (let start = 0; start < text.length; ) {
        let end = Math.min(start + MAX_TOKENIZER_INPUT_CHARS, text.length);
        // Keep a UTF-16 surrogate pair together at an artificial boundary.
        if (
          end < text.length &&
          text.charCodeAt(end - 1) >= 0xd800 &&
          text.charCodeAt(end - 1) <= 0xdbff
        ) {
          end--;
        }
        tokenCount += encode(text.slice(start, end)).length;
        start = end;
      }
      return tokenCount;
    } catch (error) {
      Log.warn(
        `Token counting failed, using character approximation: ${error}`
      );
      // Fallback: rough approximation (1 token ≈ 4 characters for English)
      return Math.ceil(text.length / 4);
    }
  }

  /**
   * Count lines (simple newline count)
   */
  private countLines(text: string): number {
    if (!text) return 0;
    return text.split("\n").length;
  }

  /**
   * Split text at <attachment>…</attachment> boundaries, treating each block
   * as an atomic unit that is never split internally.
   *
   * @returns Array of chunks (length ≥ 2) when attachments are present and
   *          splitting is needed, or null when no attachments are found.
   */
  private splitOnAttachmentBoundaries(text: string): string[] | null {
    // Match complete attachment blocks (non-greedy to handle adjacent blocks)
    const attachmentPattern = /<attachment\s[^>]*>[\s\S]*?<\/attachment>/g;
    const blocks: { start: number; end: number; content: string }[] = [];
    let match: RegExpExecArray | null;

    while ((match = attachmentPattern.exec(text)) !== null) {
      blocks.push({
        start: match.index,
        end: match.index + match[0].length,
        content: match[0],
      });
    }

    if (blocks.length === 0) {
      return null; // No attachment blocks — fall back to paragraph splitting
    }

    // Build ordered segments: preamble | attachment blocks | trailing text
    const segments: string[] = [];
    let pos = 0;

    for (const block of blocks) {
      // Text before this attachment (preamble or inter-attachment text)
      if (block.start > pos) {
        const before = text.slice(pos, block.start).trim();
        if (before) {
          segments.push(before);
        }
      }
      // Each attachment block is atomic
      segments.push(block.content);
      // Advance past block, skipping trailing whitespace/newlines
      pos = block.end;
      while (
        pos < text.length &&
        (text[pos] === "\n" || text[pos] === "\r" || text[pos] === " ")
      ) {
        pos++;
      }
    }

    // Trailing text after the last attachment (e.g. user prompt)
    if (pos < text.length) {
      const trailing = text.slice(pos).trim();
      if (trailing) {
        segments.push(trailing);
      }
    }

    return this.binPackSegments(segments);
  }

  /**
   * Pack an ordered list of atomic segments into chunks that respect the
   * configured token and line limits. Oversized individual segments are
   * sub-split via splitIntoChunks (paragraph fallback).
   */
  private binPackSegments(segments: string[]): string[] {
    const chunks: string[] = [];
    let currentChunk = "";
    let currentTokens = 0;
    let currentLines = 0;

    for (const segment of segments) {
      const segTokens = this.countTokens(segment);
      const segLines = this.countLines(segment);

      // Flush current chunk when adding this segment would exceed limits
      if (
        currentChunk &&
        (currentTokens + segTokens > this.packingTokenLimit ||
          currentLines + segLines > this.config.maxLinesPerFile)
      ) {
        chunks.push(currentChunk.trim());
        currentChunk = "";
        currentTokens = 0;
        currentLines = 0;
      }

      // Oversized single segment: sub-split with paragraph method
      if (
        segTokens > this.packingTokenLimit ||
        segLines > this.config.maxLinesPerFile
      ) {
        if (currentChunk.trim()) {
          chunks.push(currentChunk.trim());
          currentChunk = "";
          currentTokens = 0;
          currentLines = 0;
        }
        const subChunks = this.splitIntoChunks(segment);
        chunks.push(...subChunks);
      } else {
        currentChunk = currentChunk ? currentChunk + "\n\n" + segment : segment;
        currentTokens += segTokens;
        currentLines += segLines;
      }
    }

    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    return chunks.length > 0 ? chunks : [segments.join("\n\n")];
  }

  /**
   * Smart splitting algorithm - preserves content structure
   *
   * Strategy:
   * 1. Split on double newlines (paragraph boundaries) - best for structure
   * 2. If paragraph too large, split on single newlines (line boundaries)
   * 3. If line too large, force split with continuation markers
   *
   * @param promptText The full prompt text to split
   * @returns Array of prompt chunks
   */
  private splitIntoChunks(promptText: string): string[] {
    const chunks: string[] = [];
    let currentChunk = "";
    let currentTokens = 0;
    let currentLines = 0;

    // Split on paragraph boundaries (double newlines)
    const paragraphs = promptText.split(/\n\n+/);

    for (const para of paragraphs) {
      const paraTokens = this.countTokens(para);
      const paraLines = this.countLines(para);

      // Check if adding this paragraph would exceed limits
      if (
        currentChunk &&
        (currentTokens + paraTokens > this.packingTokenLimit ||
          currentLines + paraLines > this.config.maxLinesPerFile)
      ) {
        // Finalize the current chunk if it meets the minimum size.
        // Exception: when the next paragraph is itself oversized (it will be
        // sub-split line-by-line below), keep the existing small content in
        // currentChunk so it gets bundled with the first lines of that
        // paragraph rather than becoming a tiny isolated standalone file.
        const nextParaOversized =
          paraTokens > this.packingTokenLimit ||
          paraLines > this.config.maxLinesPerFile;
        if (
          currentTokens >= this.config.minChunkSize ||
          (!nextParaOversized && chunks.length === 0)
        ) {
          chunks.push(currentChunk.trim());
          currentChunk = "";
          currentTokens = 0;
          currentLines = 0;
        }
      }

      // If single paragraph exceeds limits, need to split it further
      if (
        paraTokens > this.packingTokenLimit ||
        paraLines > this.config.maxLinesPerFile
      ) {
        // Split on lines within paragraph
        const lines = para.split("\n");

        for (const line of lines) {
          const lineTokens = this.countTokens(line + "\n");

          // Check if adding this line would exceed limits
          if (
            currentChunk &&
            (currentTokens + lineTokens > this.packingTokenLimit ||
              currentLines + 1 > this.config.maxLinesPerFile)
          ) {
            chunks.push(currentChunk.trim());
            currentChunk = "";
            currentTokens = 0;
            currentLines = 0;
          }

          // If single line exceeds token limit, force character-level split
          if (lineTokens > this.packingTokenLimit) {
            const lineParts = this.forceCharacterSplit(
              line,
              this.packingTokenLimit
            );
            for (const part of lineParts) {
              if (currentChunk) {
                chunks.push(currentChunk.trim());
              }
              currentChunk = part + "\n";
              currentTokens = this.countTokens(currentChunk);
              currentLines = this.countLines(currentChunk);
            }
          } else {
            currentChunk += line + "\n";
            currentTokens += lineTokens;
            currentLines += 1;
          }
        }
      } else {
        // Paragraph fits, add it to current chunk
        currentChunk += para + "\n\n";
        currentTokens += paraTokens;
        currentLines += paraLines;
      }
    }

    // Add final chunk if not empty
    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    // Validate: ensure we have at least one chunk
    if (chunks.length === 0) {
      Log.warn("Splitting produced no chunks, returning original text");
      return [promptText];
    }

    return chunks;
  }

  /**
   * Split prior-context XML on <step> boundaries.
   *
   * Groups <step>…</step> elements from the <priorContext> block greedily into
   * chunks that fit within maxTokensPerFile. A step that exceeds the limit by
   * itself is emitted as its own oversized chunk rather than being split
   * mid-XML (XML must remain valid).
   *
   * Falls back to split() when no <priorContext> block is detected.
   */
  splitContextContent(text: string): SplitResult {
    // Fast path: entire block fits in one file
    if (!this.needsSplitting(text)) {
      return {
        needsSplit: false,
        chunks: [text],
        tokenCounts: [this.countTokens(text)],
        lineCounts: [this.countLines(text)],
      };
    }

    // Extract <priorContext>…</priorContext> inner content
    const pcMatch = text.match(/^<priorContext>([\s\S]*?)<\/priorContext>/m);
    if (!pcMatch) {
      // No priorContext block — fall back to regular paragraph splitting
      return this.split(text);
    }

    // Extract individual <step> elements (lazy, top-level only)
    const stepPattern = /<step[^>]*>[\s\S]*?<\/step>/g;
    const steps: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = stepPattern.exec(pcMatch[1])) !== null) {
      steps.push(m[0]);
    }

    if (steps.length === 0) {
      return this.split(text);
    }

    // Overhead of the <priorContext>…</priorContext> wrapper per chunk
    const wrapperTokens = this.countTokens("<priorContext>\n</priorContext>");

    // Greedy packing of steps into chunks
    const chunks: string[] = [];
    let currentSteps: string[] = [];
    let currentTokens = wrapperTokens;

    for (const step of steps) {
      const stepTokens = this.countTokens(step);
      if (
        currentTokens + stepTokens > this.packingTokenLimit &&
        currentSteps.length > 0
      ) {
        // Flush current chunk
        chunks.push(
          `<priorContext>\n${currentSteps.join("\n")}\n</priorContext>`
        );
        currentSteps = [step];
        currentTokens = wrapperTokens + stepTokens;
      } else {
        // Add to current chunk (even if this step alone exceeds the limit)
        currentSteps.push(step);
        currentTokens += stepTokens;
      }
    }

    chunks.push(`<priorContext>\n${currentSteps.join("\n")}\n</priorContext>`);

    const tokenCounts = chunks.map((c) => this.countTokens(c));
    const lineCounts = chunks.map((c) => this.countLines(c));

    return { needsSplit: chunks.length > 1, chunks, tokenCounts, lineCounts };
  }

  /**
   * Force character-level split for extremely long lines
   * Adds continuation markers to preserve context
   *
   * @param line The line to split
   * @param maxTokens Maximum tokens per segment
   * @returns Array of line segments
   */
  private forceCharacterSplit(line: string, maxTokens: number): string[] {
    const segments: string[] = [];
    const continuationMarker = "[... continued ...]";

    // Approximate character limit (tokens * 4)
    const approxCharLimit = Math.floor(maxTokens * 3.5); // Be conservative

    let remaining = line;
    while (remaining.length > approxCharLimit) {
      // Try to split at word boundary
      let splitPos = approxCharLimit;
      const spacePos = remaining.lastIndexOf(" ", splitPos);
      if (spacePos > approxCharLimit * 0.5) {
        splitPos = spacePos;
      }

      segments.push(remaining.substring(0, splitPos).trim());
      remaining =
        continuationMarker + " " + remaining.substring(splitPos).trim();
    }

    // Add final segment
    if (remaining) {
      segments.push(remaining);
    }

    return segments;
  }
}
