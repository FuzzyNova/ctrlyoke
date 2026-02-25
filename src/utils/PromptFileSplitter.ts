import { encode } from "gpt-tokenizer";
import { Log } from "./Log";

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
    maxTokensPerFile: 15000,
    maxLinesPerFile: 1800, // 90% of Claude's 2K line limit
    minChunkSize: 3000,
  };

  constructor(config?: SplitConfig) {
    this.config = {
      ...PromptFileSplitter.DEFAULT_CONFIG,
      ...config,
    };
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
   * Split prompt into chunks if needed, preserving structure
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

    // Split into chunks
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
      return encode(text).length;
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
        (currentTokens + paraTokens > this.config.maxTokensPerFile ||
          currentLines + paraLines > this.config.maxLinesPerFile)
      ) {
        // Finalize current chunk if it meets minimum size
        if (currentTokens >= this.config.minChunkSize || chunks.length === 0) {
          chunks.push(currentChunk.trim());
          currentChunk = "";
          currentTokens = 0;
          currentLines = 0;
        }
      }

      // If single paragraph exceeds limits, need to split it further
      if (
        paraTokens > this.config.maxTokensPerFile ||
        paraLines > this.config.maxLinesPerFile
      ) {
        // Split on lines within paragraph
        const lines = para.split("\n");

        for (const line of lines) {
          const lineTokens = this.countTokens(line + "\n");

          // Check if adding this line would exceed limits
          if (
            currentChunk &&
            (currentTokens + lineTokens > this.config.maxTokensPerFile ||
              currentLines + 1 > this.config.maxLinesPerFile)
          ) {
            chunks.push(currentChunk.trim());
            currentChunk = "";
            currentTokens = 0;
            currentLines = 0;
          }

          // If single line exceeds token limit, force character-level split
          if (lineTokens > this.config.maxTokensPerFile) {
            const lineParts = this.forceCharacterSplit(
              line,
              this.config.maxTokensPerFile
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
