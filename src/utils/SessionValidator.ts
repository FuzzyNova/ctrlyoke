import { Harness } from "../types/FlightPathTypes";
import { Log } from "./Log";

/**
 * Session ID format validation utilities.
 *
 * Different CLI harnesses use different session ID formats:
 * - Copilot CLI: UUID v4 (strict format)
 * - Claude CLI: UUID v4 (strict format)
 * - Codex CLI: Thread ID string (thread_xxx format, flexible)
 *
 * This validator ensures session IDs match the expected format for each harness
 * before passing to CLI commands, preventing CLI errors and enabling graceful fallback.
 *
 * @example
 * ```typescript
 * // Validate before passing to CLI
 * if (!SessionValidator.validate(sessionId, harness)) {
 *   // Invalid format - start new session instead
 *   sessionId = undefined;
 * }
 * ```
 */
export class SessionValidator {
  /**
   * UUID v4 regex pattern (RFC 4122 compliant)
   *
   * Format: 8-4-4-4-12 hexadecimal characters
   * Example: 550e8400-e29b-41d4-a716-446655440000
   */
  private static readonly UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /**
   * Validate session ID format for a specific harness.
   *
   * Validation rules by harness:
   * - **Copilot CLI**: Strict UUID v4 format required
   * - **Claude CLI**: Strict UUID v4 format required (rejects invalid with error)
   * - **Codex CLI**: Any non-empty string (typically thread_xxx)
   * - **Copilot Chat**: Not applicable (no session IDs)
   *
   * @param sessionId Session ID to validate
   * @param harness Harness to validate against
   * @returns True if valid format, false if invalid (with warning logged)
   */
  static validate(sessionId: string, harness: Harness): boolean {
    switch (harness) {
      case Harness.CopilotCli:
        return this.validateUuid(sessionId, "Copilot CLI");

      case Harness.ClaudeCli:
        return this.validateUuid(sessionId, "Claude CLI");

      case Harness.CodexCli:
        return this.validateCodexThreadId(sessionId);

      case Harness.CopilotChat:
        // Chat mode doesn't use session IDs
        Log.warn(
          `⚠️ Session ID validation not applicable for Copilot Chat mode. ` +
            `Session IDs are only used in CLI modes.`
        );
        return false;

      default:
        Log.warn(
          `⚠️ Unknown harness: ${harness}. Cannot validate session ID format.`
        );
        return false;
    }
  }

  /**
   * Validate UUID v4 format (used by Copilot and Claude CLI)
   *
   * @param sessionId Session ID to validate
   * @param harnessName Harness display name for error messages
   * @returns True if valid UUID, false otherwise
   */
  private static validateUuid(
    sessionId: string,
    harnessName: string
  ): boolean {
    if (!this.UUID_REGEX.test(sessionId)) {
      Log.warn(
        `⚠️ Session ID "${sessionId}" is not a valid UUID for ${harnessName}. ` +
          `Starting new session instead. ` +
          `Expected format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
      );
      return false;
    }
    return true;
  }

  /**
   * Validate Codex thread ID format (flexible validation)
   *
   * Codex uses thread IDs like "thread_abc123xyz".
   * We allow any non-empty string for maximum compatibility.
   *
   * @param sessionId Session ID to validate
   * @returns True if non-empty string, false otherwise
   */
  private static validateCodexThreadId(sessionId: string): boolean {
    const trimmed = sessionId.trim();
    if (trimmed.length === 0) {
      Log.warn(
        `⚠️ Empty session ID for Codex CLI. Starting new session instead.`
      );
      return false;
    }
    return true;
  }

  /**
   * Check if a session ID looks like a UUID (for diagnostics)
   *
   * Useful for debugging when harnesses receive unexpected formats.
   *
   * @param sessionId Session ID to check
   * @returns True if appears to be UUID format
   */
  static isUuidFormat(sessionId: string): boolean {
    return this.UUID_REGEX.test(sessionId);
  }
}
