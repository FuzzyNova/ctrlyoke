# Remote-access entitlement is enforced only on the WebSocket upgrade; every token-gated HTTP API route is reachable from non-loopback clients

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/server/CtrlYokeHostedServer.ts`
- **Severity:** low

## Symptom

This is a security issue (licensing/access-control bypass). Remote access requires Pro or the trial, but this is enforced only when a client opens a WebSocket. Every token-gated HTTP route keeps answering LAN clients: workspace file read/write/delete/copy/move, search, the SCM stage/discard/commit/push/pull/checkout routes, and `/api/workflow-files`. This holds after the remote-access trial has expired, as long as the server is still running. A client that only uses REST never starts the trial clock, so it gets unlimited remote access.

## Steps to Reproduce

1. On a Free license with no trial started, set the hosted server bind address to `0.0.0.0` and start it. `enforceRemoteBindBeforeListen()` allows the bind because `canUseRemoteAccess()` returns true while `startedAt === null`.
2. From another LAN machine, call `GET /api/workspace-viewer/file?...&token=<token>` (or `PUT`, or `POST` to the commit/push routes) without ever opening `/ws`. The request succeeds and `beginRemoteAccess()` is never called, so the trial never starts.
3. Alternatively, start the trial by connecting the dashboard from a LAN device, keep the server running past `REMOTE_ACCESS_TRIAL_MS`, then reconnect. The `/ws` upgrade now gets 403 Forbidden, but the same LAN client can still read and write files and run git operations over HTTP with the token until the server restarts.

## Root Cause

The entitlement gate exists only in the upgrade handler, at `src/server/CtrlYokeHostedServer.ts:450` (`isClientAllowed`, defined at `:3100-3112`). The HTTP auth middlewares `requireToken` and `requireTokenForPage` (`:1254-1264`) and the pre-auth body-parser middleware (`:596`) check only `requestHasValidToken`.

The bind-time check `enforceRemoteBindBeforeListen` (`:3061-3079`) runs once, via `resolveRemoteAccess` -> `canUseRemoteAccess`, which returns true for an unstarted trial and does not start it (`src/license/LicenseService.ts:314-326`). Only `beginRemoteAccess` (`LicenseService.ts:328`) starts the trial. Nothing re-evaluates or rebinds the server when the trial expires: the only relevant `onDidChangeEntitlement` subscriber, `src/ui/DashboardApplication.ts:214`, just pushes a UI update.

## Suggested Fix

Use one remote-access gate for HTTP and WS alike. For example, after the token check in `requireToken` and `requireTokenForPage`, call `await this.isClientAllowed(req.socket.remoteAddress)` and return 403 when it is false. Every non-loopback HTTP request then starts the trial and is refused once it expires. `isClientAllowed` already short-circuits for loopback, and `LicenseService` caches the entitlement, so the per-request cost is small. Alternatively, install it as a single app-level middleware ahead of `setupRoutes()`.

Optionally, when the trial expires, close existing non-loopback WebSocket connections or restart the server bound to localhost.

Add a test that a non-loopback HTTP request to a `requireToken` route gets 403 when `begin()` returns false.
