import * as assert from "assert";
import { SessionValidator } from "../utils/SessionValidator";
import { HARNESS_IDS } from "../types/DashboardConstants";

suite("SessionValidator Tests", () => {
  suite("UUID Validation (Copilot and Claude CLI)", () => {
    test("Valid UUID format should pass", () => {
      const validUuid = "550e8400-e29b-41d4-a716-446655440000";

      assert.strictEqual(
        SessionValidator.validate(validUuid, HARNESS_IDS.COPILOT_CLI),
        true,
        "Valid UUID should pass for Copilot CLI"
      );

      assert.strictEqual(
        SessionValidator.validate(validUuid, HARNESS_IDS.CLAUDE_CLI),
        true,
        "Valid UUID should pass for Claude CLI"
      );
    });

    test("Uppercase UUID should pass", () => {
      const uppercaseUuid = "550E8400-E29B-41D4-A716-446655440000";

      assert.strictEqual(
        SessionValidator.validate(uppercaseUuid, HARNESS_IDS.COPILOT_CLI),
        true,
        "Uppercase UUID should pass"
      );
    });

    test("Invalid UUID format should fail", () => {
      const invalidFormats = [
        "not-a-uuid",
        "550e8400-e29b-41d4-a716", // Too short
        "550e8400-e29b-41d4-a716-446655440000-extra", // Too long
        "thread_abc123", // Codex format
        "12345678-1234-1234-1234-1234567890", // Wrong length in last segment
        "", // Empty
      ];

      invalidFormats.forEach((invalid) => {
        assert.strictEqual(
          SessionValidator.validate(invalid, HARNESS_IDS.COPILOT_CLI),
          false,
          `Invalid UUID "${invalid}" should fail for Copilot CLI`
        );

        assert.strictEqual(
          SessionValidator.validate(invalid, HARNESS_IDS.CLAUDE_CLI),
          false,
          `Invalid UUID "${invalid}" should fail for Claude CLI`
        );
      });
    });
  });

  suite("Codex Thread ID Validation", () => {
    test("Valid thread ID should pass", () => {
      const validThreadIds = [
        "thread_abc123xyz",
        "thread_123",
        "custom-session-id",
        "any-non-empty-string",
      ];

      validThreadIds.forEach((threadId) => {
        assert.strictEqual(
          SessionValidator.validate(threadId, HARNESS_IDS.CODEX_CLI),
          true,
          `Thread ID "${threadId}" should pass for Codex CLI`
        );
      });
    });

    test("Empty thread ID should fail", () => {
      assert.strictEqual(
        SessionValidator.validate("", HARNESS_IDS.CODEX_CLI),
        false,
        "Empty string should fail"
      );

      assert.strictEqual(
        SessionValidator.validate("   ", HARNESS_IDS.CODEX_CLI),
        false,
        "Whitespace-only string should fail"
      );
    });
  });

  suite("OpenCode Session ID Validation", () => {
    test("Valid ses_ session IDs should pass", () => {
      const validIds = [
        "ses_34106de37ffeG7oh0Bvq9cmRki",
        "ses_abc123XYZ",
        "ses_ABC",
        "ses_0",
      ];

      validIds.forEach((id) => {
        assert.strictEqual(
          SessionValidator.validate(id, HARNESS_IDS.OPENCODE_CLI),
          true,
          `OpenCode session ID "${id}" should pass`
        );
      });
    });

    test("Invalid OpenCode session IDs should fail", () => {
      const invalidIds = [
        "550e8400-e29b-41d4-a716-446655440000", // UUID format
        "thread_abc123", // Codex format
        "abc123", // Missing ses_ prefix
        "ses_", // Empty after prefix
        "ses_abc 123", // Contains space
        "ses_abc-123", // Contains hyphen
        "", // Empty
      ];

      invalidIds.forEach((id) => {
        assert.strictEqual(
          SessionValidator.validate(id, HARNESS_IDS.OPENCODE_CLI),
          false,
          `Invalid OpenCode session ID "${id}" should fail`
        );
      });
    });
  });

  suite("isUuidFormat Utility", () => {
    test("Should correctly identify UUID format", () => {
      assert.strictEqual(
        SessionValidator.isUuidFormat("550e8400-e29b-41d4-a716-446655440000"),
        true,
        "Valid UUID should be identified"
      );

      assert.strictEqual(
        SessionValidator.isUuidFormat("thread_abc123"),
        false,
        "Thread ID should not be identified as UUID"
      );

      assert.strictEqual(
        SessionValidator.isUuidFormat("not-a-uuid"),
        false,
        "Invalid format should not be identified as UUID"
      );
    });
  });
});
