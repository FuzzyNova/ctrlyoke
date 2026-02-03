import { encode } from "gpt-tokenizer";

/**
 * Count tokens in text using GPT tokenizer
 * Wrapper around gpt-tokenizer npm package
 */
export function countTokens(text: string): number {
  try {
    const tokens = encode(text);
    return tokens.length;
  } catch (error) {
    console.error("Token counting failed:", error);
    return 0;
  }
}
