import * as crypto from "crypto";
import { PromptItem } from "../types/FlightPathTypes";

/**
 * Generates a SHA-256 hash of prompt content
 * Normalizes whitespace to make hashing more robust
 */
export function hashPromptContent(promptText: string): string {
  // Normalize whitespace to make hashing more robust
  const normalized = promptText.trim().replace(/\s+/g, " ");
  return crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * Determines if dynamic queue extension instructions should be injected for a prompt.
 * Extension instructions are only injected when explicitly enabled via allowDynamicExtension.
 */
export function shouldInjectExtensionInstructions(
  prompt: PromptItem,
  allowDynamicExtension?: boolean
): boolean {
  if (allowDynamicExtension === false) return false;
  return prompt.allowDynamicExtension === true;
}
