# An empty `CTRLYOKE_SERVER_TOKEN` turns off authentication for the hosted server

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (confirmed with a scratch `npx tsx` script against `createNodeHostedServer`)
- **Area:** `src/platform/ServerTokenStore.ts` (`resolveServerToken`), `src/server/CtrlYokeHostedServer.ts` (`timingSafeStringEqual`)
- **Severity:** high (security: unauthenticated access to file read/write, git and workflow execution)

## Symptom

When `CTRLYOKE_SERVER_TOKEN` is set but empty, `ctrlyoke server` starts with an
empty access token and prints `http://localhost:<port>/?token=`. A request with
`?token=` or an empty `x-ctrlyoke-token` header then passes every token check:
all `/api/*` routes (workspace viewer file read/write, git commit/push, ...) and
the `/ws` and `/ws/lsp` WebSockets, which can run workflows. The WebSocket
upgrade has no Origin check, so any web page the user visits can open
`ws://127.0.0.1:4747/ws?token=` and drive the dashboard; with `--bind 0.0.0.0`
any LAN device can too.

An empty value is easy to end up with by accident, e.g.
`CTRLYOKE_SERVER_TOKEN=${TOKEN}` with `TOKEN` unset in a compose file or CI, or
`export CTRLYOKE_SERVER_TOKEN=` to "clear" it. `docs/cli/server.md` only says
the env var supplies the token; nothing documents empty as "no auth".

## Steps to Reproduce

1. Set `CTRLYOKE_SERVER_TOKEN=""` and start a server with
   `createNodeHostedServer({ cwd })` (or `ctrlyoke server`).
2. `GET /api/workspace-viewer/file?path=secret.txt` without a token → 401.
3. The same request with `&token=` → 200 with the file contents. Header
   `x-ctrlyoke-token: ""` → 200.
4. `new WebSocket("ws://host/ws?token=")` reaches OPEN.

## Root Cause

`src/platform/ServerTokenStore.ts:31`:
`return envToken ?? regenerated ?? (await store.getOrCreate());` — `??` only
falls through on `null`/`undefined`, so `""` becomes the token.
`timingSafeStringEqual` in `src/server/CtrlYokeHostedServer.ts` then accepts
`"" === ""`. Neither the `CtrlYokeHostedServer` constructor nor `listen()`
rejects an empty token.

## Suggested Fix

- In `resolveServerToken`, treat an empty or whitespace-only env value as unset
  (fall back to the persisted token).
- Defence in depth: have `CtrlYokeHostedServer` refuse to construct/listen with
  an empty token, so every host gets the guarantee in one place.

Tests: `src/test/unit/ServerTokenStore.test.ts` (`resolveServerToken(store, "")`
must not return `""`), and a server-level test (e.g.
`src/test/integration/nodeHostedServer.integration.test.ts` or the hosted
server unit tests) asserting the server rejects an empty token / `?token=` gets 401.
