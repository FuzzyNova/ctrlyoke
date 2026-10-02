import * as assert from "node:assert";
import { suite, test } from "mocha";
import {
  REDACTION_MARKER,
  RunSecretRedactor,
  secretRedactionService,
  StreamingSecretRedactor,
} from "../../utils/SecretRedactionService";
import { configService } from "../../config/CtrlYokeConfigService";

suite("SecretRedactionService", () => {
  test("streaming redaction handles secrets split across two and three chunks", () => {
    const redactor = new RunSecretRedactor();
    redactor.addResolvedValues({ TOKEN: "abcdef123456" });
    const release = secretRedactionService.register(redactor);
    try {
      const twoChunks = new StreamingSecretRedactor();
      assert.strictEqual(twoChunks.push("before abc"), "before ");
      assert.strictEqual(
        twoChunks.push("def123456 after"),
        `${REDACTION_MARKER} after`
      );
      assert.strictEqual(twoChunks.flush(), "");

      const threeChunks = new StreamingSecretRedactor();
      assert.strictEqual(threeChunks.push("before ab"), "before ");
      assert.strictEqual(threeChunks.push("cdef12"), "");
      assert.strictEqual(
        threeChunks.push("3456 after"),
        `${REDACTION_MARKER} after`
      );
    } finally {
      release();
    }
  });

  test("streaming redaction catches every split boundary", () => {
    const secret = "split-secret-value";
    const redactor = new RunSecretRedactor();
    redactor.addResolvedValues({ TOKEN: secret });
    const release = secretRedactionService.register(redactor);
    try {
      for (let boundary = 1; boundary < secret.length; boundary += 1) {
        const stream = new StreamingSecretRedactor();
        const first = stream.push(secret.slice(0, boundary));
        const second = stream.push(secret.slice(boundary));
        assert.strictEqual(first + second + stream.flush(), REDACTION_MARKER);
      }
    } finally {
      release();
    }
  });

  test("streaming redaction handles overlapping prefixes from multiple secrets", () => {
    const redactor = new RunSecretRedactor();
    redactor.addResolvedValues({ FIRST: "abcdef", SECOND: "abcxyz" });
    const release = secretRedactionService.register(redactor);
    try {
      const stream = new StreamingSecretRedactor();
      assert.strictEqual(stream.push("abc"), "");
      assert.strictEqual(stream.push("xyz!"), `${REDACTION_MARKER}!`);
    } finally {
      release();
    }
  });

  test("streaming redaction matches JSON-escaped secret representations", () => {
    const redactor = new RunSecretRedactor();
    redactor.addResolvedValues({ TOKEN: 'quoted"value' });
    const release = secretRedactionService.register(redactor);
    try {
      const escaped = 'quoted\\"value';
      const stream = new StreamingSecretRedactor();
      assert.strictEqual(stream.push(`start ${escaped.slice(0, 8)}`), "start ");
      assert.strictEqual(
        stream.push(`${escaped.slice(8)} end`),
        `${REDACTION_MARKER} end`
      );
    } finally {
      release();
    }
  });

  test("streaming redaction passes through without exact secrets and emits held nonsecret text", () => {
    const stream = new StreamingSecretRedactor();
    assert.strictEqual(stream.push("plain output"), "plain output");
    assert.strictEqual(stream.flush(), "");

    const secretRedactor = new RunSecretRedactor();
    secretRedactor.addResolvedValues({ TOKEN: "prefix" });
    const release = secretRedactionService.register(secretRedactor);
    try {
      const pending = new StreamingSecretRedactor();
      assert.strictEqual(pending.push("ordinary pre"), "ordinary ");
      assert.strictEqual(pending.push("x"), "prex");
    } finally {
      release();
    }
  });

  test("streaming redaction flushes a held tail and never holds marker output", () => {
    const redactor = new RunSecretRedactor();
    redactor.addResolvedValues({ TOKEN: "secret-value", SUFFIX: "]tail" });
    const release = secretRedactionService.register(redactor);
    try {
      const stream = new StreamingSecretRedactor();
      assert.strictEqual(stream.push("secret-value"), REDACTION_MARKER);
      assert.strictEqual(stream.push("secret-value"), REDACTION_MARKER);

      const tail = new StreamingSecretRedactor();
      assert.strictEqual(tail.push("safe ]"), "safe ");
      assert.strictEqual(tail.flush(), "]");
    } finally {
      release();
    }
  });

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

  test("permissions.heuristicSecretRedactionEnabled=false disables heuristic matching but not exact-secret redaction", () => {
    configService.setCliOverlay({
      permissions: { heuristicSecretRedactionEnabled: false },
    });
    try {
      // Heuristic-shaped but never resolved by ctrlyoke: must survive.
      assert.strictEqual(
        secretRedactionService.redactText(
          "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"
        ),
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"
      );

      // Exact resolved secrets always redact, heuristics setting or not.
      const redactor = new RunSecretRedactor();
      redactor.addResolvedValues({ TOKEN: "resolved-token" });
      const release = secretRedactionService.register(redactor);
      try {
        assert.strictEqual(
          secretRedactionService.redactText("failure: resolved-token"),
          "failure: [REDACTED]"
        );
      } finally {
        release();
      }
    } finally {
      configService.setCliOverlay({});
    }
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
