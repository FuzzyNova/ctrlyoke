import { encode } from "gpt-tokenizer";
import { WebviewLog } from "./logger";
import { getErrorMessage } from "../../../utils/ErrorUtils";

/**
 * Count tokens in text using GPT tokenizer
 * Wrapper around gpt-tokenizer npm package
 */
export function countTokens(text: string): number {
  try {
    const tokens = encode(text);
    return tokens.length;
  } catch (error) {
    WebviewLog.error(
      `[tokenizer] Token counting failed: ${getErrorMessage(error)}`
    );
    return 0;
  }
}
