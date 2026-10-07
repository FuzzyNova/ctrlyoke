import * as assert from "node:assert";
import * as http from "node:http";
import express from "express";
import { suite, test } from "mocha";
import { installSecretRedactionMiddleware } from "../../server/SecretRedactionMiddleware";
import { buildHostedStandaloneShimScript } from "../../server/HostedStandaloneShimScript";
import {
  RunSecretRedactor,
  secretRedactionService,
} from "../../utils/SecretRedactionService";

/** Starts an ephemeral express app and returns its base URL plus a stopper. */
async function startTestServer(
  app: express.Express
): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

suite("installSecretRedactionMiddleware", () => {
  test("redacts a plain response body matching the credential-assignment heuristic", async () => {
    const app = express();
    installSecretRedactionMiddleware(app);
    app.get("/plain", (_req, res) => {
      res.send("token=abcdefghijk123");
    });
    const { baseUrl, stop } = await startTestServer(app);
    try {
      const response = await fetch(`${baseUrl}/plain`);
      assert.strictEqual(await response.text(), "token=[REDACTED]");
    } finally {
      await stop();
    }
  });

  test("skips redaction for a route that opts out via res.locals.skipSecretRedaction", async () => {
    const app = express();
    installSecretRedactionMiddleware(app);
    app.get("/opt-out", (_req, res) => {
      res.locals.skipSecretRedaction = true;
      res.send("token=abcdefghijk123");
    });
    const { baseUrl, stop } = await startTestServer(app);
    try {
      const response = await fetch(`${baseUrl}/opt-out`);
      assert.strictEqual(await response.text(), "token=abcdefghijk123");
    } finally {
      await stop();
    }
  });

  // Regression: the standalone shim's WebSocket URL builder —
  // `token=${encodeURIComponent(token)}` — matches the credential-assignment
  // heuristic (`token=` followed by 8+ non-punctuation chars, which the
  // template-literal syntax satisfies). Serving the shim through the same
  // redaction boundary as ordinary API responses truncated the builder to
  // `token=[REDACTED]}`, so every browser client sent a literal "[REDACTED]"
  // as its auth token on `/ws` and never connected.
  test("serves the real standalone shim script byte-for-byte when opted out", async () => {
    const script = buildHostedStandaloneShimScript("test-workspace");
    assert.ok(
      script.includes("token=${encodeURIComponent(token)}"),
      "expected the shim's WebSocket URL builder to be present in the template"
    );

    const app = express();
    installSecretRedactionMiddleware(app);
    app.get("/standalone-shim.js", (_req, res) => {
      res.locals.skipSecretRedaction = true;
      res.type("application/javascript").send(script);
    });
    const { baseUrl, stop } = await startTestServer(app);
    try {
      const response = await fetch(`${baseUrl}/standalone-shim.js`);
      assert.strictEqual(await response.text(), script);
    } finally {
      await stop();
    }
  });

  test("redacts secret-shaped values inside JSON response bodies", async () => {
    const app = express();
    installSecretRedactionMiddleware(app);
    app.get("/json", (_req, res) => {
      res.json({ message: "token=abcdefghijk123" });
    });
    const { baseUrl, stop } = await startTestServer(app);
    try {
      const response = await fetch(`${baseUrl}/json`);
      assert.deepStrictEqual(await response.json(), {
        message: "token=[REDACTED]",
      });
    } finally {
      await stop();
    }
  });

  test("redacts JSON values once without corrupting serialized strings", async () => {
    const secret = "resolved-json-secret-value";
    const redactor = new RunSecretRedactor();
    redactor.addResolvedValues({ TOKEN: secret });
    const release = secretRedactionService.register(redactor);
    const app = express();
    installSecretRedactionMiddleware(app);
    app.get("/json", (_req, res) => {
      res.json({
        ordinary: 'const password=abcdefg"; // short',
        credential: `token=${secret}`,
      });
    });
    const { baseUrl, stop } = await startTestServer(app);
    try {
      const response = await fetch(`${baseUrl}/json`);
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(await response.json(), {
        ordinary: 'const password=abcdefg"; // short',
        credential: "token=[REDACTED]",
      });
    } finally {
      release();
      await stop();
    }
  });
});
