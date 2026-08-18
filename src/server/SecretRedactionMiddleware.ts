import type express from "express";
import { secretRedactionService } from "../utils/SecretRedactionService";

/**
 * Installs the hosted-server output boundary described in
 * dev/implemented/SECRETS_AND_REDACTION_PLAN.md: every JSON/text response
 * passes through `secretRedactionService` before it reaches the client.
 *
 * Routes that serve ctrlyoke's own generated script sources (the standalone
 * shim, the service worker) must set `res.locals.skipSecretRedaction = true`
 * before calling `res.send`/`res.json` to opt out. That escape hatch exists
 * because those responses are pure application code, never user data, and
 * the heuristic `credential-assignment` rule in `PreviewRedactor.ts` matches
 * ordinary JS like `token=${encodeURIComponent(token)}` — redacting it
 * truncated the shim's WebSocket URL builder to `token=[REDACTED]}`,
 * corrupting the auth query string every browser client sent on connect.
 */
export function installSecretRedactionMiddleware(app: express.Express): void {
  app.use((_req, res, next) => {
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    res.json = ((body: unknown) =>
      originalJson(
        res.locals.skipSecretRedaction
          ? body
          : secretRedactionService.redactValue(body)
      )) as typeof res.json;
    res.send = ((body: unknown) =>
      originalSend(
        !res.locals.skipSecretRedaction && typeof body === "string"
          ? secretRedactionService.redactText(body)
          : body
      )) as typeof res.send;
    next();
  });
}
