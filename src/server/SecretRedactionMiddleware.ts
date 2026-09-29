import type express from "express";
import { secretRedactionService } from "../utils/SecretRedactionService";

/**
 * Installs the hosted-server output boundary described in
 * dev/implemented/SECRETS_AND_REDACTION_PLAN.md: every JSON/text response
 * passes through `secretRedactionService` before it reaches the client.
 *
 * Routes that serve ctrlyoke-generated output containing credentials (the
 * standalone shim, service worker, manifest, and patched HTML) must set
 * `res.locals.skipSecretRedaction = true` before calling `res.send`/`res.json`
 * to opt out. Those responses are application output, never user data, and
 * the heuristic `credential-assignment` rule in `PreviewRedactor.ts` matches
 * generated token query strings as well as ordinary JS like
 * `token=${encodeURIComponent(token)}`. Redacting them corrupts the auth URLs
 * clients need to connect to the hosted server.
 */
export function installSecretRedactionMiddleware(app: express.Express): void {
  app.use((_req, res, next) => {
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    let sendingRedactedJson = false;
    res.json = ((body: unknown) => {
      const safeBody = res.locals.skipSecretRedaction
        ? body
        : secretRedactionService.redactValue(body);
      sendingRedactedJson = true;
      try {
        return originalJson(safeBody);
      } finally {
        sendingRedactedJson = false;
      }
    }) as typeof res.json;
    res.send = ((body: unknown) =>
      originalSend(
        !res.locals.skipSecretRedaction &&
          !sendingRedactedJson &&
          typeof body === "string"
          ? secretRedactionService.redactText(body)
          : body
      )) as typeof res.send;
    next();
  });
}
