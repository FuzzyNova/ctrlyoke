import { encode } from "gpt-tokenizer";
import { WebviewLog } from "./logger";

/**
 * Count tokens in text using GPT tokenizer
 * Wrapper around gpt-tokenizer npm package
 */
export function countTokens(text: string): number {
  try {
    const tokens = encode(text);
    return tokens.length;
  } catch (error) {
    WebviewLog.error(`Token counting failed: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
}
