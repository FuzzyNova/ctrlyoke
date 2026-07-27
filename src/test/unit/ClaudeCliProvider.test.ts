import * as assert from "assert";
import { suite, test } from "mocha";
import { ClaudeCliProvider } from "../../core/harness/claude/ClaudeCliProvider";

suite("ClaudeCliProvider", () => {
  test("keeps invalid-session spawn errors recoverable", () => {
    const provider = new ClaudeCliProvider();

    for (const message of [
      "--resume requires a valid session ID",
      "Session IDs must be in UUID format",
      "No conversation found with session ID abc",
    ]) {
      assert.strictEqual(provider.isRecoverableSessionError(message), true);
    }

    assert.strictEqual(
      provider.isRecoverableSessionError("Claude authentication failed"),
      false
    );
  });
});
