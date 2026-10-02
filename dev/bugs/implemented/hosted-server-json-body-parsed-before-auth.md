# Hosted server parses up to ~12 MB JSON bodies before checking the token

- **Found:** 2026-10-01 by bug-hunt final step (claude-cli), code reading plus a scratch Express reproduction outside the repo
- **Area:** `src/server/CtrlYokeHostedServer.ts` (middleware setup ~274-286)
- **Resolution:** fixed in this commit

## Symptom

The JSON body parser is installed with `this.app.use(...)` before
`setupRoutes()`, so it runs ahead of `requireToken` on every route. For
`PUT` + `WORKSPACE_FILE_ROUTE_PATH` it uses `WORKSPACE_FILE_JSON_BODY_LIMIT_BYTES`
(about 12 MB, ~118-120). On every other route it uses `DEFAULT_JSON_BODY_LIMIT`.

A client without the token can make the extension host buffer and
`JSON.parse` a ~12 MB body before getting `401`. When remote access binds
`0.0.0.0`, anyone on the LAN can send this concurrently. That pushes the
extension-host heap toward the OOM crash pattern described in the project's
debugging notes.

## Steps to Reproduce

1. Start the hosted server.
2. Send an unauthenticated `PUT` to the workspace-viewer file route with an
   11 MB JSON string body.
3. The response is `401`, but only after the whole body has been read and
   parsed. Rebuilding the same middleware order in a scratch Express app
   confirmed the 11,534,336-byte string was parsed before the 401.

## Root Cause

The body-parsing middleware is ordered before authentication.

## Suggested Fix

Check the token before parsing the body. Either attach the parsers per route
after `requireToken` (e.g. `app.put(ROUTE, requireToken, workspaceFileJsonParser, handler)`),
or run a global token gate for `/api/*` before the parser middleware. Keep the
existing public (unauthenticated) routes working; they take no JSON bodies.
`installSecretRedactionMiddleware` must keep wrapping responses.
