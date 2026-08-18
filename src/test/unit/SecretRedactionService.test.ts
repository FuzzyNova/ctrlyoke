import * as assert from "node:assert";
import { suite, test } from "mocha";
import {
  RunSecretRedactor,
  secretRedactionService,
} from "../../utils/SecretRedactionService";

suite("SecretRedactionService", () => {
  test("redacts exact values recursively at a transport boundary", () => {
    const redactor = new RunSecretRedactor();
    redactor.addResolvedValues({ TOKEN: "resolved-token" });
    const release = secretRedactionService.register(redactor);

    const result = secretRedactionService.redactValue({
      message: "failure: resolved-token",
      nested: ["resolved-token"],
    });

    release();
    assert.deepStrictEqual(result, {
      message: "failure: [REDACTED]",
      nested: ["[REDACTED]"],
    });
  });

  test("retains heuristic redaction when no exact value was resolved", () => {
    assert.strictEqual(
      secretRedactionService.redactText(
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"
      ),
      "Authorization: Bearer [REDACTED]"
    );
  });

  test("clears a run's exact values when it is released", () => {
    const redactor = new RunSecretRedactor();
    redactor.addResolvedValues({ TOKEN: "run-only-value" });
    const release = secretRedactionService.register(redactor);
    release();

    assert.strictEqual(
      secretRedactionService.redactText("run-only-value"),
      "run-only-value"
    );
  });
});
