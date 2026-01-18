import * as assert from "assert";
import { SessionValidator } from "../utils/SessionValidator";
import { Provider } from "../types/FlightPathTypes";

suite("SessionValidator Tests", () => {
  suite("UUID Validation (Copilot and Claude CLI)", () => {
    test("Valid UUID format should pass", () => {
      const validUuid = "550e8400-e29b-41d4-a716-446655440000";

      assert.strictEqual(
        SessionValidator.validate(validUuid, Provider.CopilotCli),
        true,
        "Valid UUID should pass for Copilot CLI"
      );

      assert.strictEqual(
        SessionValidator.validate(validUuid, Provider.ClaudeCli),
        true,
        "Valid UUID should pass for Claude CLI"
      );
    });

    test("Uppercase UUID should pass", () => {
      const uppercaseUuid = "550E8400-E29B-41D4-A716-446655440000";

      assert.strictEqual(
        SessionValidator.validate(uppercaseUuid, Provider.CopilotCli),
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
          SessionValidator.validate(invalid, Provider.CopilotCli),
          false,
          `Invalid UUID "${invalid}" should fail for Copilot CLI`
        );

        assert.strictEqual(
          SessionValidator.validate(invalid, Provider.ClaudeCli),
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
          SessionValidator.validate(threadId, Provider.CodexCli),
          true,
          `Thread ID "${threadId}" should pass for Codex CLI`
        );
      });
    });

    test("Empty thread ID should fail", () => {
      assert.strictEqual(
        SessionValidator.validate("", Provider.CodexCli),
        false,
        "Empty string should fail"
      );

      assert.strictEqual(
        SessionValidator.validate("   ", Provider.CodexCli),
        false,
        "Whitespace-only string should fail"
      );
    });
  });

  suite("Copilot Chat (Not Applicable)", () => {
    test("Should return false and warn for Copilot Chat", () => {
      const sessionId = "any-session-id";

      assert.strictEqual(
        SessionValidator.validate(sessionId, Provider.CopilotChat),
        false,
        "Copilot Chat should not use session IDs"
      );
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
