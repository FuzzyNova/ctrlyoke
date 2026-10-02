# Hosted server token is written in plain text to the session log

- **Found:** 2026-10-01 by bug-hunt final step (claude-cli), code reading
- **Area:** `src/extension.ts` (hosted server start), `src/server/CtrlYokeHostedServer.ts`
- **Resolution:** fixed in this commit

## Symptom

Each time the hosted server starts, `src/extension.ts` (~1566) logs
`` `[Extension] ctrlyoke: Hosted server started at ${url}` ``. The `url` here is
`publicUrl`, which `CtrlYokeHostedServer.listen` builds as `...?token=<token>`
(~2502). `Log` runs messages through `secretRedactionService.redactText`, but
`extension.ts` (~1477) exempts the token on purpose with `protectValue(token)`.
As a result the full access token lands in `.ctrlyoke/logs/ctrlyoke-<ts>.log` in
plain text.

That log is the project's standard debugging artefact: people attach it to bug
reports, and any harness agent working in the workspace can read it. The token
persists across restarts and is shared by every workspace's server (see
`hosted-server-port-probe-sends-token-to-port-owner.md`).

## Steps to Reproduce

1. Enable the hosted server.
2. Open the newest `.ctrlyoke/logs/ctrlyoke-*.log` and search for `token=`.

## Root Cause

The URL is logged verbatim, and the redaction exemption that keeps the token
usable in the dashboard's copy-URL path also stops it being redacted in logs.

## Suggested Fix

Log the URL with the token masked, e.g. `?token=…`, through one small helper
(e.g. `maskServerUrlToken(url)` next to the server URL builders). Check every
other `Log.*` call that interpolates `publicUrl` or `buildPublicUrl(...)`,
including the sibling-detected and port-fallback messages and any dev-host
script output that ends up in the session log. Leave
`.ctrlyoke/dev/server-url.txt` unchanged: it is a gitignored, dev-build-only
file that exists so tooling can read the URL.
