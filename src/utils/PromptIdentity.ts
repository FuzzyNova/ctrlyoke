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
 * Determines if dynamic queue extension instructions should be injected for a prompt
 */
export function shouldInjectExtensionInstructions(
  prompt: PromptItem,
  index: number,
  allPrompts: PromptItem[],
  dynamicExtensionOnLastPrompt: boolean = true,
  allowDynamicExtension?: boolean
): boolean {
  // Legacy behavior when no global/workflow allow flag is provided
  if (allowDynamicExtension === undefined) {
    if (prompt.allowDynamicExtension === true) return true;
    if (prompt.allowDynamicExtension === false) return false;

    const isLastPrompt = index === allPrompts.length - 1;
    const anyExplicitFlag = allPrompts.some(
      (p) => p.allowDynamicExtension !== undefined
    );
    return isLastPrompt && !anyExplicitFlag && dynamicExtensionOnLastPrompt;
  }

  if (!allowDynamicExtension) return false;

  // Explicit enable takes precedence
  if (prompt.allowDynamicExtension === true) return true;

  // Default: inject ONLY on last prompt if:
  // 1. No prompts have explicit flags, AND
  // 2. Global setting allows extension on last prompt
  const isLastPrompt = index === allPrompts.length - 1;
  const anyExplicitFlag = allPrompts.some(
    (p) => p.allowDynamicExtension === true
  );

  return isLastPrompt && !anyExplicitFlag && dynamicExtensionOnLastPrompt;
}
