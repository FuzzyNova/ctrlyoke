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
 * Checks if a prompt has been completed based on tracking ID format
 *
 * Tracking ID format (from markPromptCompleted):
 * - With explicit ID: "{id}:{hash}"
 * - Without ID or auto-assigned hash ID: "{hash}"
 *
 * A prompt is considered completed if:
 * 1. Exact tracking ID match (either "{id}:{hash}" or "{hash}")
 * 2. Hash fallback ONLY for prompts without explicit IDs (prevents re-execution of
 *    duplicate content that was appended without an ID, while allowing legitimate
 *    duplicate content with different explicit IDs like review-1 and review-2)
 *
 * Note: Auto-assigned hash IDs (where id === hash) are treated as "no explicit ID"
 * for deduplication purposes, ensuring they work correctly across reloads.
 */
export function isPromptCompleted(
  prompt: PromptItem,
  completedIds: Set<string>
): boolean {
  const hash = hashPromptContent(prompt.prompt);

  // Distinguish between explicit user IDs and auto-assigned hash IDs
  // Auto-assigned hash IDs (id === hash) are treated as "no explicit ID"
  const hasExplicitId = prompt.id && prompt.id !== hash;

  // Check for exact match: "{id}:{hash}" or "{hash}"
  const trackingId = hasExplicitId ? `${prompt.id}:${hash}` : hash;
  if (completedIds.has(trackingId)) {
    return true;
  }

  // Only check hash fallback for prompts WITHOUT explicit IDs
  // This allows different explicit IDs with same content to both execute
  // (e.g., review-1 and review-2 can have identical content)
  if (!hasExplicitId) {
    for (const completedId of completedIds) {
      // Check if this is a concatenated ID and extract the hash
      if (completedId.includes(":")) {
        const [, completedHash] = completedId.split(":", 2);
        if (completedHash === hash) {
          return true;
        }
      } else if (completedId === hash) {
        // Standalone hash match
        return true;
      }
    }
  }

  return false;
}

/**
 * Determines if dynamic queue extension instructions should be injected for a prompt
 */
export function shouldInjectExtensionInstructions(
  prompt: PromptItem,
  index: number,
  allPrompts: PromptItem[],
  dynamicExtensionOnLastPrompt: boolean = true
): boolean {
  // Explicit flag takes precedence
  if (prompt.allowDynamicExtension === true) return true;
  if (prompt.allowDynamicExtension === false) return false;

  // Default: inject ONLY on last prompt if:
  // 1. No prompts have explicit flags, AND
  // 2. Global setting allows extension on last prompt
  const isLastPrompt = index === allPrompts.length - 1;
  const anyExplicitFlag = allPrompts.some(
    (p) => p.allowDynamicExtension !== undefined
  );

  return isLastPrompt && !anyExplicitFlag && dynamicExtensionOnLastPrompt;
}
