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
 * Checks if a prompt has been completed based on ID or content hash
 */
export function isPromptCompleted(
  prompt: PromptItem,
  completedIds: Set<string>
): boolean {
  // Check explicit ID first
  if (prompt.id && completedIds.has(prompt.id)) {
    return true;
  }

  // Fallback to content hash
  const hash = hashPromptContent(prompt.prompt);
  return completedIds.has(hash);
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
