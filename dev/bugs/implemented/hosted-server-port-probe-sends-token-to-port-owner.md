# Port-collision probe sends the hosted server token to whatever process holds the port

- **Found:** 2026-10-01 by bug-hunt final step (claude-cli), code reading of `src/server/CtrlYokeHostedServer.ts`
- **Area:** `src/server/CtrlYokeHostedServer.ts` (`listen` → `probeExistingServer`)
- **Resolution:** fixed in this commit

## Symptom

When `server.port` (default 4747) is already in use, `listen()`'s `EADDRINUSE`
handler calls `probeExistingServer(port)` (~2482), which sends
`GET /api/workflow-files` to that port with the header
`x-ctrlyoke-token: <token>` (~2582-2593). Over TLS it also sets
`rejectUnauthorized: false`. Only after the reply arrives does it decide whether
the listener is a ctrlyoke sibling.

So any process already listening on the configured port, or on a fallback
candidate port, receives the token. The token is 32 random bytes kept in VS Code
SecretStorage (`ServerTokenStore`). It persists across restarts and every
workspace's server uses the same one, so one leak gives long-lived access to
every hosted dashboard this user runs. That access includes running workflows
and the hosted terminal.

## Steps to Reproduce

1. `node -e "require('http').createServer((q,s)=>{console.log(q.headers['x-ctrlyoke-token']);s.end()}).listen(4747)"`
2. Enable the ctrlyoke hosted server (`ctrlyoke.enableServer`).
3. The squatter process prints the token.

On a shared machine, any local user can do this.

## Root Cause

Sibling detection authenticates the _caller_ to the _listener_. It should
authenticate the listener to the caller without revealing the secret first.

## Suggested Fix

Probe without sending credentials, using a challenge-response:

- Add an unauthenticated identity route, e.g.
  `GET /api/server-identity?nonce=<random>`, that returns
  `HMAC-SHA256(token, nonce)` and nothing else.
- The prober generates a fresh random nonce, then compares the reply to its own
  HMAC with `crypto.timingSafeEqual`. If they match, the listener is a sibling
  holding the same token.
- A non-ctrlyoke listener learns only a nonce and gets nothing it can replay.

Keep `rejectUnauthorized: false` only on this credential-free probe. Single-source
the route path and the HMAC helper so server and prober can't drift. While here,
switch `requestHasValidToken` and the WebSocket token check (~2010-2016, ~2113)
to a length-checked `crypto.timingSafeEqual` (hardening only).
