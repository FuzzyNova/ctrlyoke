/**
 * GPT Tokenizer Bundle
 * Exports encode function to window.gptTokenizer for webview use
 */
import { encode } from "gpt-tokenizer";

// Expose to global scope
window.gptTokenizer = { encode };
