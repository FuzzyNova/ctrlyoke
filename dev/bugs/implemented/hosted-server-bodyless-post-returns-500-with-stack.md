# Hosted server returns a 500 with a stack trace for POST/PUT requests without a JSON body

- **Found:** 2026-10-15 by Claude Code (bug-hunt final step; code reading)
- **Area:** `src/server/CtrlYokeHostedServer.ts`
- **Resolution:** fixed in this commit

## Symptom

An authenticated POST/PUT to a workspace-viewer route with no body, or with a non-JSON content
type (for example `POST /api/workspace-viewer/stage` with `text/plain`), gets Express's default
500 error page instead of a 400. Outside `NODE_ENV=production` that page includes the server
stack trace and local file paths.

## Steps to Reproduce

1. Start the hosted server.
2. `curl -X POST -H "Authorization: Bearer <token>" <url>/api/workspace-viewer/stage`
3. The response is 500 with an HTML stack trace (`TypeError: Cannot read properties of undefined`).

## Root Cause

The server uses Express 5 (`package.json`: `"express": "^5.2.1"`), whose `express.json()` leaves
`req.body` `undefined` when it doesn't parse a body (Express 4 defaulted it to `{}`). Handlers
such as the watch route (`CtrlYokeHostedServer.ts:1573`) and the PUT file route (`:1591`), and
the other viewer mutation routes, read `(req.body as {...}).path` directly, so they throw before
validating. The push, pull and generate-commit-message routes already use `req.body?.`, which
shows the inconsistency.

## Suggested Fix

Normalize the body once, for example with a small `readJsonBody(req)` helper that returns
`req.body ?? {}`, used by every route, or an `app.use` that defaults `req.body` after the JSON
parsers. Add a final Express error handler that returns a JSON 500 without the stack. Cover a
body-less request with a test in `src/test/unit/CtrlYokeHostedServer.test.ts`.
