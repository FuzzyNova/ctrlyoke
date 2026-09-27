# Hosted workspace viewer can't save files larger than 64 KB (HTTP 413)

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli)
- **Area:** `src/server/CtrlYokeHostedServer.ts` (global JSON body parser vs. `PUT /api/workspace-viewer/file`)
- **Severity:** high

## Symptom

In the hosted dashboard's workspace viewer, saving an edited file whose JSON body
exceeds 64 KB fails with `413 PayloadTooLargeError`. The viewer opens files up to 2 MB
for editing (`HostedWorkspaceViewerService.ts` `MAX_FILE_SIZE`), so any file between
~64 KB and 2 MB can be opened and edited but never saved.

Reproduced against a real `CtrlYokeHostedServer` (served on a free port, with the
access token): `PUT /api/workspace-viewer/file` with
`{ path: "big.txt", content: "a".repeat(1000) }` → 200;
with `"a".repeat(100000)` → **413**.

## Steps to Reproduce

1. Enable the hosted server and open the workspace viewer in a browser.
2. Open any text file larger than ~64 KB, change a character, save.
3. The save fails with a 413.

## Root Cause

`CtrlYokeHostedServer.ts:253` installs `app.use(express.json({ limit: "64kb" }))` for
every request. The file-save route (`:1062-1065`) adds its own
`express.json({ limit: "5mb" })`, but the global parser runs first: the client sends
`Content-Type: application/json` (`hostedApi.ts`), so the global parser reads the body
and rejects it at 64 KB before the route-level parser is reached (and a body that was
already parsed is skipped by the second parser anyway).

## Suggested Fix

Don't let the global 64 KB parser handle routes that declare their own limit. For
example, install the global parser through a small wrapper that skips paths registered
with a larger limit, or remove the global parser and attach `express.json` per route
with named limit constants (`DEFAULT_JSON_BODY_LIMIT`, `WORKSPACE_FILE_BODY_LIMIT`),
deriving the file-save limit from the viewer's `MAX_FILE_SIZE` plus JSON-escaping
headroom so the two can't drift. Keep `installSecretRedactionMiddleware` working for
parsed bodies. Add a server test that PUTs a >64 KB (e.g. 1 MB) file body and expects
200 and the file written, and one that a normal small-body route still rejects >64 KB.
