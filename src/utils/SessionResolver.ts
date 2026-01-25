import { PromptFile, PromptItem, Provider } from "../types/FlightPathTypes";
import { PropertyResolver } from "./PropertyResolver";
import { Log } from "./Log";

/**
 * Validation result for session references
 */
export interface SessionValidationResult {
  valid: boolean;
  error?: string;
  warning?: string;
}

/**
 * Session resolution and validation utilities.
 *
 * Enables per-prompt session tracking so different prompts in a workflow can
 * resume different CLI sessions. Supports three input formats:
 *
 * 1. **Prompt Number Reference**: `sessionId: 1` - Reuse session from prompt 1
 * 2. **Exact Session ID**: `sessionId: "550e8400-e29b-41d4..."` - Direct session ID
 * 3. **Auto-Resume**: No sessionId specified - Automatically resume previous prompt's session
 *
 * Resolution respects workflow-level properties and validates cross-provider compatibility.
 *
 * @example
 * ```typescript
 * // Resolve session ID for current prompt
 * const sessionId = SessionResolver.resolve(
 *   prompt,
 *   promptIndex,
 *   allPrompts,
 *   workflow
 * );
 *
 * // Validate session reference before execution
 * const validation = SessionResolver.validate(
 *   prompt,
 *   promptIndex,
 *   allPrompts,
 *   workflow
 * );
 * if (!validation.valid) {
 *   throw new Error(validation.error);
 * }
 * ```
 */
export class SessionResolver {
  /**
   * Check if two providers are compatible for session sharing.
   *
   * **Strict provider matching:**
   * - Both defined and equal → Compatible
   * - One undefined, one defined → **NOT compatible**
   * - Both defined but different → **NOT compatible**
   *
   * This prevents cross-provider session references (Copilot ↔ Claude ↔ Codex).
   *
   * @param provider1 First provider (may be undefined)
   * @param provider2 Second provider (may be undefined)
   * @returns true if providers are compatible for session sharing
   */
  private static areProvidersCompatible(
    provider1: Provider | undefined,
    provider2: Provider | undefined
  ): boolean {
    // Strict equality check: Both must be defined and match
    // This prevents cross-provider session references (Copilot ↔ Claude ↔ Codex)
    return !!(provider1 && provider2 && provider1 === provider2);
  }
  /**
   * Resolve session ID for a prompt.
   *
   * Resolution order:
   * 1. If resumeSession=false → undefined (new session)
   * 2. If sessionId is number → resolve from referenced prompt
   * 3. If sessionId is string → use directly
   * 4. Otherwise → auto-resume from previous prompt (same provider)
   *
   * @param prompt The prompt to resolve session for
   * @param promptIndex Current prompt's index in queue (0-based)
   * @param allPrompts All prompts in queue (with runtime metadata)
   * @param workflow Workflow file for workflow-level defaults (optional)
   * @returns Resolved session ID or undefined for new session
   */
  static resolve(
    prompt: PromptItem,
    promptIndex: number,
    allPrompts: PromptItem[],
    workflow?: PromptFile
  ): string | undefined {
    const resolved = workflow
      ? PropertyResolver.resolve(prompt, workflow)
      : undefined;

    // 1. Check if session should NOT be resumed (i.e., start new session)
    if (!this.shouldResumeSession(prompt, workflow)) {
      return undefined;
    }

    // 2. Use resolved sessionId (includes workflow-level sessionId via PropertyResolver)
    const resolvedSessionId = resolved?.sessionId;
    if (resolvedSessionId !== undefined) {
      // 2a. Numeric reference (prompt number)
      if (typeof resolvedSessionId === "number") {
        return this.resolveNumericReference(
          prompt,
          resolvedSessionId,
          promptIndex,
          allPrompts,
          resolved?.provider
        );
      }

      // 2b. Exact session ID string
      return resolvedSessionId;
    }

    // 3. Auto-resume previous prompt in same workflow
    return this.autoResumeFromPrevious(
      prompt,
      promptIndex,
      allPrompts,
      resolved?.provider
    );
  }

  /**
   * Resolve numeric session reference (e.g., sessionId: 1).
   *
   * Validates that:
   * - Reference is within bounds (1 to current prompt index)
   * - Referenced prompt has completed and has a session ID
   * - Providers are compatible (same provider or undefined)
   *
   * @param prompt Current prompt being resolved
   * @param refNumber Numeric reference (1-based prompt number)
   * @param promptIndex Current prompt's index (0-based)
   * @param allPrompts All prompts in queue
   * @param resolvedProvider Resolved provider for current prompt
   * @returns Session ID from referenced prompt or undefined if invalid
   */
  private static resolveNumericReference(
    prompt: PromptItem,
    refNumber: number,
    promptIndex: number,
    allPrompts: PromptItem[],
    resolvedProvider?: Provider
  ): string | undefined {
    const refIndex = refNumber - 1; // 1-based to 0-based

    // Validate reference is within bounds and points to previous prompt
    if (refIndex < 0 || refIndex >= promptIndex) {
      Log.warn(
        `⚠️ Invalid sessionId reference: ${refNumber}. ` +
          `Must reference a completed prompt (1-${promptIndex}). ` +
          `Starting new session instead.\n` +
          `   To fix: Use a valid prompt number (1-${promptIndex}) or remove sessionId to auto-resume.`
      );
      return undefined;
    }

    const referencedPrompt = allPrompts[refIndex];
    const sessionId = referencedPrompt._runtime?.sessionId;

    if (!sessionId) {
      Log.warn(
        `⚠️ Prompt ${refNumber} has no session ID. Starting new session instead.\n` +
          `   This usually means prompt ${refNumber} hasn't been executed yet.\n` +
          `   To fix: Ensure prompts run in order, or use a different prompt number.`
      );
      return undefined;
    }

    // Runtime sessionId should always be string (actual CLI session ID)
    // If it's somehow a number, that's an error in runtime metadata
    if (typeof sessionId === "number") {
      Log.warn(
        `⚠️ Prompt ${refNumber} has invalid runtime sessionId (number instead of string). ` +
          `Starting new session.`
      );
      return undefined;
    }

    // Validate provider compatibility using shared method
    const refProvider = referencedPrompt._runtime?.provider;
    const currentProvider = resolvedProvider ?? prompt.provider;

    if (!this.areProvidersCompatible(refProvider, currentProvider)) {
      Log.warn(
        `⚠️ Cross-provider session reference detected!\n` +
          `   Prompt ${refNumber} used ${refProvider}, but current prompt uses ${currentProvider}.\n` +
          `   Sessions cannot be shared across different providers (Copilot ↔ Claude ↔ Codex).\n` +
          `   Starting new ${currentProvider} session instead.\n` +
          `   To fix: Either:\n` +
          `     1. Use same provider for all prompts that share a session, OR\n` +
          `     2. Remove sessionId to auto-resume from last prompt with matching provider`
      );
      return undefined;
    }

    Log.debug(`✅ Resolved sessionId from prompt ${refNumber}: ${sessionId}`);
    return sessionId;
  }

  /**
   * Auto-resume from previous prompt in same workflow.
   *
   * Searches backward through prompts to find the most recent completed prompt
   * with the same provider (or any provider if current provider is undefined).
   *
   * @param prompt Current prompt being resolved
   * @param promptIndex Current prompt's index (0-based)
   * @param allPrompts All prompts in queue
   * @param resolvedProvider Resolved provider for current prompt
   * @returns Session ID from previous prompt or undefined if none found
   */
  private static autoResumeFromPrevious(
    prompt: PromptItem,
    promptIndex: number,
    allPrompts: PromptItem[],
    resolvedProvider?: Provider
  ): string | undefined {
    if (promptIndex === 0) {
      return undefined; // First prompt, no previous
    }

    // Find most recent completed prompt with same provider
    for (let i = promptIndex - 1; i >= 0; i--) {
      const prevPrompt = allPrompts[i];
      const prevProvider = prevPrompt._runtime?.provider;
      const prevSessionId = prevPrompt._runtime?.sessionId;
      const currentProvider = resolvedProvider ?? prompt.provider;

      // Check provider compatibility using shared method
      const providersMatch = this.areProvidersCompatible(
        currentProvider,
        prevProvider
      );

      // Skip prompts with mismatched providers (log for debugging)
      if (!providersMatch && prevSessionId) {
        Log.debug(
          `⏭️ Skipping prompt ${i + 1} (provider mismatch: ${prevProvider} vs ${currentProvider})`
        );
        continue;
      }

      if (providersMatch && prevSessionId) {
        // Runtime sessionId should always be string (actual CLI session ID)
        if (typeof prevSessionId === "number") {
          Log.warn(
            `⚠️ Prompt ${i + 1} has invalid runtime sessionId (number instead of string). ` +
              `Skipping auto-resume.`
          );
          continue;
        }

        Log.debug(
          `✅ Auto-resuming session from prompt ${i + 1}: ${prevSessionId}`
        );
        return prevSessionId;
      }
    }

    return undefined;
  }

  /**
   * Check if prompt should resume existing session.
   *
   * Applies three-tier precedence (using PropertyResolver):
   * 1. Prompt-level resumeSession setting (highest priority)
   * 2. Workflow-level resumeSession setting
   * 3. Global flightpath.resumeExistingSession setting (lowest priority)
   *
   * @param prompt The prompt to check
   * @param workflow Workflow file for workflow-level defaults (optional)
   * @returns True if session should be resumed, false to start new session
   */
  static shouldResumeSession(
    prompt: PromptItem,
    workflow?: PromptFile
  ): boolean {
    if (workflow) {
      return PropertyResolver.resolve(prompt, workflow).resumeSession;
    }

    // Fallback when workflow is unavailable (should be rare)
    // In this case, respect prompt-level setting or default to false
    if (prompt.resumeSession !== undefined) {
      return prompt.resumeSession;
    }

    // Default to new session when no workflow or prompt setting exists
    return false;
  }

  /**
   * Validate session reference before execution.
   *
   * Checks for:
   * - Conflicting settings (resumeSession=false + sessionId set)
   * - Invalid numeric references (out of bounds, future prompts)
   * - Other validation issues
   *
   * @param prompt The prompt to validate
   * @param promptIndex Current prompt's index (0-based)
   * @param allPrompts All prompts in queue
   * @param workflow Workflow file for workflow-level defaults (optional)
   * @returns Validation result with valid flag and optional error/warning messages
   */
  static validate(
    prompt: PromptItem,
    promptIndex: number,
    allPrompts: PromptItem[],
    workflow?: PromptFile
  ): SessionValidationResult {
    // Resolve sessionId (check prompt first, then workflow if available)
    const sessionId = workflow
      ? PropertyResolver.resolve(prompt, workflow).sessionId
      : prompt.sessionId;

    // Check for conflicting settings (ONLY if both explicitly set on prompt)
    // Note: We check prompt.resumeSession directly, not resolved value,
    // because this validation is about conflicting prompt-level settings.
    if (prompt.resumeSession === false && sessionId !== undefined) {
      return {
        valid: true,
        warning:
          "Prompt has sessionId set but resumeSession=false. " +
          "Session ID will be ignored.",
      };
    }

    // Validate numeric reference
    if (typeof sessionId === "number") {
      const refIndex = sessionId - 1;

      // Check if reference is out of bounds (beyond available prompts)
      if (refIndex < 0 || refIndex >= allPrompts.length) {
        return {
          valid: false,
          error:
            `Invalid sessionId reference: ${sessionId}. ` +
            `Must reference a prompt between 1-${allPrompts.length}.`,
        };
      }

      // Check if reference points to future prompt (not yet executed)
      if (refIndex >= promptIndex) {
        return {
          valid: false,
          error:
            `Invalid sessionId reference: ${sessionId}. ` +
            `Cannot reference future prompt (current: ${promptIndex + 1}).`,
        };
      }
    }

    return { valid: true };
  }
}
