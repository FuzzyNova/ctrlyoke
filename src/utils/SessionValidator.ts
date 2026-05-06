import {
  HARNESS_IDS,
  HARNESS_INFO,
  type HarnessId,
} from "../types/DashboardConstants";
import { Log } from "./Log";

/**
 * Session ID format validation utilities.
 *
 * Different CLI harnesses use different session ID formats:
 * - Copilot CLI: UUID v4 (strict format)
 * - Claude CLI: UUID v4 (strict format)
 * - Codex CLI: Thread ID string (thread_xxx format, flexible)
 * - OpenCode CLI: ses_ prefix + alphanumeric string (e.g., ses_34106de37ffeG7oh0Bvq9cmRki)
 * - Qwen CLI: UUID v4 (strict format)
 * - Gemini CLI: UUID v4 (strict format)
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
   * OpenCode session ID regex pattern.
   *
   * Format: "ses_" prefix followed by alphanumeric characters (mixed case).
   * Example: ses_34106de37ffeG7oh0Bvq9cmRki
   */
  private static readonly OPENCODE_SESSION_REGEX = /^ses_[A-Za-z0-9]+$/;

  /**
   * Validate session ID format for a specific harness.
   *
   * Validation rules by harness:
   * - **Copilot CLI**: Strict UUID v4 format required
   * - **Claude CLI**: Strict UUID v4 format required (rejects invalid with error)
   * - **Codex CLI**: Any non-empty string (typically thread_xxx)
   * - **OpenCode CLI**: Must start with "ses_" followed by alphanumeric characters
   * - **Qwen CLI**: Strict UUID v4 format required
   * - **Gemini CLI**: Strict UUID v4 format required
   * - **Copilot Chat**: Not applicable (no session IDs)
   *
   * @param sessionId Session ID to validate
   * @param harness Harness to validate against
   * @returns True if valid format, false if invalid (with warning logged)
   */
  static validate(sessionId: string, harness: HarnessId): boolean {
    switch (harness) {
      case HARNESS_IDS.COPILOT_CLI:
        return this.validateUuid(
          sessionId,
          HARNESS_INFO[HARNESS_IDS.COPILOT_CLI].name
        );

      case HARNESS_IDS.CLAUDE_CLI:
        return this.validateUuid(
          sessionId,
          HARNESS_INFO[HARNESS_IDS.CLAUDE_CLI].name
        );

      case HARNESS_IDS.CODEX_CLI:
        return this.validateCodexThreadId(sessionId);

      case HARNESS_IDS.OPENCODE_CLI:
        return this.validateOpenCodeSessionId(sessionId);

      case HARNESS_IDS.QWEN_CLI:
        return this.validateUuid(
          sessionId,
          HARNESS_INFO[HARNESS_IDS.QWEN_CLI].name
        );

      case HARNESS_IDS.GEMINI_CLI:
        return this.validateUuid(
          sessionId,
          HARNESS_INFO[HARNESS_IDS.GEMINI_CLI].name
        );

      case HARNESS_IDS.COPILOT_CHAT:
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
  private static validateUuid(sessionId: string, harnessName: string): boolean {
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
      Log.warn(`⚠️ Empty session ID for Codex. Starting new session instead.`);
      return false;
    }
    return true;
  }

  /**
   * Validate OpenCode session ID format.
   *
   * OpenCode assigns session IDs with a "ses_" prefix followed by alphanumeric
   * characters (mixed case). Example: ses_34106de37ffeG7oh0Bvq9cmRki
   *
   * @param sessionId Session ID to validate
   * @returns True if valid OpenCode session ID, false otherwise
   */
  private static validateOpenCodeSessionId(sessionId: string): boolean {
    if (!this.OPENCODE_SESSION_REGEX.test(sessionId)) {
      Log.warn(
        `⚠️ Session ID "${sessionId}" is not a valid OpenCode session ID. ` +
          `Starting new session instead. ` +
          `Expected format: ses_<alphanumeric> (e.g., ses_34106de37ffeG7oh0Bvq9cmRki)`
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
