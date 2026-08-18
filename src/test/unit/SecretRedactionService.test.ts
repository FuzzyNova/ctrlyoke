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

  test("protectValue exempts a value from heuristic credential-assignment matching", () => {
    // Regression: the hosted server's own connection token legitimately
    // appears as `?token=<hex>` in its manifest link and in the settings
    // "copy URL" payload. Without this exemption the credential-assignment
    // heuristic corrupts both, breaking auth (401) and the copied link.
    const token =
      "ce5edcba9641f1bd799e8a1d0c3a792019ea05e84bc0bee59021db1ee19c3517";
    const release = secretRedactionService.protectValue(token);

    assert.strictEqual(
      secretRedactionService.redactText(`/?token=${token}`),
      `/?token=${token}`
    );

    release();
    assert.notStrictEqual(
      secretRedactionService.redactText(`/?token=${token}`),
      `/?token=${token}`
    );
  });
});
