# Port-collision probe reports another workspace's server as a sibling "for this workspace"

- **Found:** 2026-10-01 by bug-hunt final step (claude-cli), reviewing 88f5584a5 (code reading)
- **Area:** `src/server/CtrlYokeHostedServer.ts` (`probeExistingServer`, `SERVER_IDENTITY_ROUTE_PATH` route), `src/extension.ts` (`ctrlyoke.enableServer` sibling callback)
- **Resolution:** fixed in this commit

## Symptom

Open two VS Code windows on **different** projects and enable the hosted server
in both with the default port. The second window shows:

> ctrlyoke: A sibling ctrlyoke server is already running for this workspace at
> http://localhost:4747/?token=…

That server belongs to the other project. The link opens the other project's
dashboard, and the message claims it serves this workspace.

## Steps to Reproduce

1. Window A on project `X`: run `ctrlyoke.enableServer` (binds 4747).
2. Window B on project `Y`: run `ctrlyoke.enableServer`.
3. Window B shows the "sibling … for this workspace" warning, pointing at X's server.

## Root Cause

The server token comes from `ServerTokenStore`, which uses VS Code
`SecretStorage` (and the CLI's secret store). That storage is per-extension,
not per-workspace, so every workspace's server has the same token.

Before 88f5584a5, `probeExistingServer` treated a listener as a sibling only if
`GET /api/workflow-files` returned a `workspaceRoot` equal to this server's
(`isMatchingWorkflowFilesResponse` / `sameWorkspace`). The fix replaced this
with an HMAC challenge over `nonce` only:
`createServerIdentityProof(token, nonce)`. It also deleted the workspace
comparison. Any ctrlyoke server run by the same user now proves identity, so
"sibling" now means "any ctrlyoke server", not "one for this workspace".

## Suggested Fix

Bind the workspace into the proof without exposing the path to an
unauthenticated caller. The identity route returns
`HMAC-SHA256(token, nonce + "\n" + normalizedWorkspaceRoot)`, and the prober
computes the same value with its own normalized root. Normalize with
`path.resolve`, lower-cased on win32, as the deleted `sameWorkspace` did, via
one shared helper. Leave the route unauthenticated and credential-free, as the
probe fix requires.

Add a port-fallback test: a server with the same token but a different
`workspaceRoot` on the occupied port is **not** reported as a sibling, while
same-root is still detected.
