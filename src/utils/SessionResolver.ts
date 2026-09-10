import {
  PromptFile,
  PromptStep,
  WorkflowStep,
  HarnessId,
} from "../types/CtrlYokeTypes";
import { SESSION_ID_SENTINELS } from "../types/DashboardConstants";
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
 * Resolution respects workflow-level properties and validates cross-harness compatibility.
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
   * Check if two harnesses are compatible for session sharing.
   *
   * **Strict harness matching:**
   * - Both defined and equal → Compatible
   * - One undefined, one defined → **NOT compatible**
   * - Both defined but different → **NOT compatible**
   *
   * This prevents cross-harness session references (Copilot ↔ Claude ↔ Codex).
   *
   * @param harness1 First harness (may be undefined)
   * @param harness2 Second harness (may be undefined)
   * @returns true if harnesses are compatible for session sharing
   */
  private static areHarnessesCompatible(
    harness1: HarnessId | undefined,
    harness2: HarnessId | undefined
  ): boolean {
    // Strict equality check: Both must be defined and match
    // This prevents cross-harness session references (Copilot ↔ Claude ↔ Codex)
    return !!(harness1 && harness2 && harness1 === harness2);
  }
  /**
   * Resolve session ID for a prompt.
   *
   * Resolution order:
   * 1. If resumeSession=false → undefined (new session)
   * 2. If sessionId is "finalStep" sentinel → return finalStepSessionId (prior loop's session)
   * 3. If sessionId is number → resolve from referenced prompt
   * 4. If sessionId is string → use directly
   * 5. Otherwise → auto-resume from previous prompt (same harness)
   *
   * @param prompt The prompt to resolve session for
   * @param promptIndex Current prompt's index in queue (0-based)
   * @param allPrompts All prompts in queue (with runtime metadata)
   * @param workflow Workflow file for workflow-level defaults (optional)
   * @param finalStepSessionId Session ID from the most recent finalStep execution.
   *   Used when sessionId is the "finalStep" sentinel on any prompt.
   * @returns Resolved session ID or undefined for new session
   */
  static resolve(
    prompt: PromptStep,
    promptIndex: number,
    allPrompts: WorkflowStep[],
    workflow?: PromptFile,
    finalStepSessionId?: string,
    groupStartBoundary: number = promptIndex
  ): string | undefined {
    const resolved = workflow
      ? PropertyResolver.resolve(prompt, workflow)
      : undefined;
    return this.resolveWithProperties(
      prompt,
      promptIndex,
      allPrompts,
      resolved,
      finalStepSessionId,
      groupStartBoundary
    );
  }

  /**
   * Resolve against execution properties that were already inherited,
   * defaulted, and variable-substituted by a caller such as group preflight.
   */
  static resolveWithProperties(
    prompt: PromptStep,
    promptIndex: number,
    allPrompts: WorkflowStep[],
    resolved: Pick<
      import("../types/ExecutionPropertyTypes").ResolvedProperties,
      "resumeSession" | "sessionId" | "harness"
    > | undefined,
    finalStepSessionId?: string,
    groupStartBoundary: number = promptIndex,
    logWarnings: boolean = true
  ): string | undefined {
    // 1. Check if session should NOT be resumed (i.e., start new session)
    if (
      resolved ? !resolved.resumeSession : !this.shouldResumeSession(prompt)
    ) {
      return undefined;
    }

    // 2. Use the supplied effective sessionId.
    const resolvedSessionId = resolved?.sessionId;
    if (resolvedSessionId !== undefined) {
      // 2a. "finalStep" sentinel — resume the previous final step loop's session
      if (resolvedSessionId === SESSION_ID_SENTINELS.FINAL_STEP) {
        if (finalStepSessionId) {
          Log.debug(
            `[SessionResolver] Resuming finalStep loop session: ${finalStepSessionId}`
          );
        } else {
          Log.debug(
            `[SessionResolver] sessionId "finalStep": no prior loop session, starting new session`
          );
        }
        return finalStepSessionId;
      }

      // 2b. Numeric reference (prompt number)
      if (typeof resolvedSessionId === "number") {
        return this.resolveNumericReference(
          prompt,
          resolvedSessionId,
          groupStartBoundary,
          allPrompts,
          resolved?.harness,
          logWarnings
        );
      }

      // 2c. Exact session ID string
      return resolvedSessionId;
    }

    // 3. Auto-resume previous prompt in same workflow
    return this.autoResumeFromPrevious(
      prompt,
      groupStartBoundary,
      allPrompts,
      resolved?.harness,
      logWarnings
    );
  }

  /**
   * Resolve numeric session reference (e.g., sessionId: 1).
   *
   * Validates that:
   * - Reference is within bounds (1 to current prompt index)
   * - Referenced prompt has completed and has a session ID
   * - Harnesses are compatible (same harness or undefined)
   *
   * @param prompt Current prompt being resolved
   * @param refNumber Numeric reference (1-based prompt number)
   * @param promptIndex Current prompt's index (0-based)
   * @param allPrompts All prompts in queue
   * @param resolvedHarness Resolved harness for current prompt
   * @returns Session ID from referenced prompt or undefined if invalid
   */
  private static resolveNumericReference(
    prompt: PromptStep,
    refNumber: number,
    groupStartBoundary: number,
    allPrompts: WorkflowStep[],
    resolvedHarness?: HarnessId,
    logWarnings: boolean = true
  ): string | undefined {
    const refIndex = refNumber - 1; // 1-based to 0-based

    // Validate reference is within bounds and points to previous prompt
    if (refIndex < 0 || refIndex >= groupStartBoundary) {
      if (logWarnings) {
        Log.warn(
          `[SessionResolver] Invalid sessionId reference: ${refNumber}. ` +
            `Must reference a completed prompt (1-${groupStartBoundary}). ` +
            `Starting new session instead.\n` +
            `   To fix: Use a valid prompt number (1-${groupStartBoundary}) or remove sessionId to auto-resume.`
        );
      }
      return undefined;
    }

    const referencedPrompt = allPrompts[refIndex];
    const sessionId = referencedPrompt._runtime?.sessionId;

    if (!sessionId) {
      if (logWarnings) {
        Log.warn(
          `[SessionResolver] Prompt ${refNumber} has no session ID. Starting new session instead.\n` +
            `   This usually means prompt ${refNumber} hasn't been executed yet.\n` +
            `   To fix: Ensure prompts run in order, or use a different prompt number.`
        );
      }
      return undefined;
    }

    // Runtime sessionId should always be string (actual CLI session ID)
    // If it's somehow a number, that's an error in runtime metadata
    if (typeof sessionId === "number") {
      if (logWarnings) {
        Log.warn(
          `[SessionResolver] Prompt ${refNumber} has invalid runtime sessionId (number instead of string). ` +
            `Starting new session.`
        );
      }
      return undefined;
    }

    // Validate harness compatibility using shared method
    const refHarness = referencedPrompt._runtime?.harness;
    const currentHarness = resolvedHarness ?? prompt.harness;

    if (!this.areHarnessesCompatible(refHarness, currentHarness)) {
      if (logWarnings) {
        Log.warn(
          `[SessionResolver] Cross-harness session reference detected!\n` +
            `   Prompt ${refNumber} used ${refHarness}, but current prompt uses ${currentHarness}.\n` +
            `   Sessions cannot be shared across different harnesses (Copilot Claude Codex).\n` +
            `   Starting new ${currentHarness} session instead.\n` +
            `   To fix: Either:\n` +
            `     1. Use same harness for all prompts that share a session, OR\n` +
            `     2. Remove sessionId to auto-resume from last prompt with matching harness`
        );
      }
      return undefined;
    }

    Log.debug(`[SessionResolver] Resolved sessionId from prompt ${refNumber}: ${sessionId}`);
    return sessionId;
  }

  /**
   * Auto-resume from previous prompt in same workflow.
   *
   * Searches backward through prompts to find the most recent completed prompt
   * with the same harness (or any harness if current harness is undefined).
   *
   * @param prompt Current prompt being resolved
   * @param promptIndex Current prompt's index (0-based)
   * @param allPrompts All prompts in queue
   * @param resolvedHarness Resolved harness for current prompt
   * @returns Session ID from previous prompt or undefined if none found
   */
  private static autoResumeFromPrevious(
    prompt: PromptStep,
    groupStartBoundary: number,
    allPrompts: WorkflowStep[],
    resolvedHarness?: HarnessId,
    logWarnings: boolean = true
  ): string | undefined {
    if (groupStartBoundary === 0) {
      return undefined; // First prompt, no previous
    }

    // Find most recent completed prompt with same harness
    for (let i = groupStartBoundary - 1; i >= 0; i--) {
      const prevPrompt = allPrompts[i];
      const prevHarness = prevPrompt._runtime?.harness;
      const prevSessionId = prevPrompt._runtime?.sessionId;
      const currentHarness = resolvedHarness ?? prompt.harness;

      // Check harness compatibility using shared method
      const harnessesMatch = this.areHarnessesCompatible(
        currentHarness,
        prevHarness
      );

      // Skip prompts with mismatched harnesses (log for debugging)
      if (!harnessesMatch && prevSessionId) {
        Log.debug(
          `[SessionResolver] Skipping prompt ${i + 1} (harness mismatch: ${prevHarness} vs ${currentHarness})`
        );
        continue;
      }

      if (harnessesMatch && prevSessionId) {
        // Runtime sessionId should always be string (actual CLI session ID)
        if (typeof prevSessionId === "number") {
          if (logWarnings) {
            Log.warn(
              `[SessionResolver] Prompt ${i + 1} has invalid runtime sessionId (number instead of string). ` +
                `Skipping auto-resume.`
            );
          }
          continue;
        }

        Log.debug(
          `[SessionResolver] Auto-resuming session from prompt ${i + 1}: ${prevSessionId}`
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
   * 3. Global ctrlyoke.resumeExistingSession setting (lowest priority)
   *
   * @param prompt The prompt to check
   * @param workflow Workflow file for workflow-level defaults (optional)
   * @returns True if session should be resumed, false to start new session
   */
  static shouldResumeSession(
    prompt: PromptStep,
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
    prompt: PromptStep,
    promptIndex: number,
    allPrompts: PromptStep[],
    workflow?: PromptFile,
    groupStartBoundary: number = promptIndex
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
      if (refIndex >= groupStartBoundary) {
        return {
          valid: false,
          error:
            `Invalid sessionId reference: ${sessionId}. ` +
            `Cannot reference a prompt at or after the execution boundary (${groupStartBoundary + 1}).`,
        };
      }
    }

    return { valid: true };
  }
}
