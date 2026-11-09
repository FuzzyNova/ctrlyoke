import * as assert from "assert";
import { suite, test } from "mocha";
import { escapeUntrustedDisplayText } from "../../utils/EscapeUntrustedDisplayText";

suite("escapeUntrustedDisplayText", () => {
  test("escapes controls, directional marks and zero-width characters", () => {
    assert.strictEqual(
      escapeUntrustedDisplayText("a\u001b\r\u0085\u202e\u200b\u2066\ufeffz"),
      "a\\u001b\\u000d\\u0085\\u202e\\u200b\\u2066\\ufeffz"
    );
  });

  test("keeps layout newlines unless asked for one-line text", () => {
    assert.strictEqual(escapeUntrustedDisplayText("a\nb"), "a\nb");
    assert.strictEqual(
      escapeUntrustedDisplayText("a\nb", { escapeNewlines: true }),
      "a\\u000ab"
    );
  });
});
