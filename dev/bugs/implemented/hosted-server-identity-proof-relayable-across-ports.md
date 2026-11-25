# Sibling-server identity proof can be relayed, so a process squatting the configured port is reported as a sibling with the token in its URL

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude subagent, reproduced with a temporary Mocha test against real servers)
- **Area:** `src/server/CtrlYokeHostedServer.ts` (`createServerIdentityProof` ~230-238, `SERVER_IDENTITY_ROUTE_PATH` handler ~1308-1318, EADDRINUSE fallback ~3396-3414, `probeExistingServer` ~3549-3598), `src/extension.ts` (`onSiblingServerDetected` ~1815)
- **Resolution:** fixed in this commit

## Symptom

When the configured hosted-server port is taken, ctrlyoke probes the port owner's
`/api/server-identity` with a random nonce and accepts it as a sibling ctrlyoke server if
it returns `HMAC(token, nonce + "\n" + workspaceRoot)`. It then shows a VS Code warning
containing `buildPublicUrl(port)`, i.e. `http://<host>:<squatted port>/?token=<token>`,
which VS Code renders as a clickable link.

A listener that does not hold the token can pass by relaying the nonce to a real ctrlyoke
server (any other port on the machine; the endpoint is public) and echoing its answer. The
user is then shown a link to the squatter carrying the long-lived hosted token. Clicking
it hands the squatter full dashboard access.

The threat model is the same as the already-fixed
`dev/bugs/implemented/hosted-server-port-probe-sends-token-to-port-owner.md`: another
local user or process able to bind the user's configured port.

## Steps to Reproduce

Reproduced with a temporary Mocha test (`npm run test:extension -- <file>`):

1. Start real server A for the workspace on port P (55718).
2. Start a plain HTTP "squatter" on port Q (55719) with no secret. It forwards every
   request to P and echoes the reply.
3. Start server B for the same workspace and token, configured for port Q.
4. B's `onSiblingServerDetected` receives
   `http://localhost:55719/?token=secret-token-xyz`.

Expected: a listener that does not hold the token cannot pass the identity check.

## Root Cause

The proof shows that _some_ server holding the token is reachable from the responder.
It does not show that the server answering on _the probed port_ holds it. Nothing about
the port is in the HMAC input.

## Suggested Fix

- Bind the proof to the responder's own listening port. The responder computes
  `HMAC(token, nonce \n workspaceRoot \n this.port)` from its actual bound port (never the
  request's `Host` header), and `probeExistingServer(port)` verifies against the port it
  probed. A relayed answer then carries the relay target's port and fails.
- Compatibility: the probe is only advisory. On failure the EADDRINUSE path already just
  tries the next candidate port without the warning (~3407-3414), so an older ctrlyoke
  sibling that answers with the old proof simply isn't announced. No persisted or user
  contract changes.
- Tests: the relay setup above must no longer report a sibling, and a genuine sibling on
  the probed port still is.
- Separately (behavior change, not part of this fix unless decided): the warning could name
  the port instead of including the token-bearing URL.
