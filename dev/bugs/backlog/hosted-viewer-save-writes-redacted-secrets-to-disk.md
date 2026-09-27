# Saving a file in the hosted workspace viewer overwrites real secrets with `[REDACTED]`

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/server/SecretRedactionMiddleware.ts`, `src/server/CtrlYokeHostedServer.ts` (workspace-viewer file routes), `src/server/HostedWorkspaceViewerService.ts` (`readFile`, `saveFile`)
- **Severity:** high

## Symptom

If a workspace file contains something that looks like a credential, opening it in the hosted
dashboard's file viewer shows the secret masked as `[REDACTED]`. The file is not marked read-only.
If the user edits any other line and saves, the masked text is written back to disk and the real
secret is lost, with no warning.

Reproduced by running the real `CtrlYokeHostedServer` over HTTP under `npx tsx`:

1. `app.env` contains `# config\nAPI_KEY=sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c\nPORT=3000\n`.
2. `GET /api/workspace-viewer/file?path=app.env` returns content `API_KEY=[REDACTED]` with
   `readOnly: undefined`.
3. Change `PORT=3000` to `PORT=4000` and `PUT` the content back. The server returns 200.
4. The file on disk now reads `API_KEY=[REDACTED]\nPORT=4000\n`.

Expected: an edit to an unrelated line keeps the secret intact.

## Steps to Reproduce

1. Enable the hosted server and open the hosted dashboard's workspace viewer.
2. Open a file containing a credential-looking assignment (e.g. `API_KEY=sk-live-...` in a `.env`).
3. Edit an unrelated line and save.
4. The credential on disk has been replaced by `[REDACTED]`.

## Root Cause

`installSecretRedactionMiddleware` (`SecretRedactionMiddleware.ts:18-35`) wraps `res.json`, so
every JSON response goes through `secretRedactionService.redactValue`. That includes the
workspace-viewer `GET` route (`CtrlYokeHostedServer.ts:~1062-1081`), which returns
`viewerService.readFile()` as-is. The editor treats the redacted text as the file's real content.
The `PUT` route (`~1083`) passes that text to `saveFile()`, which writes it verbatim.

## Suggested Fix

- In `HostedWorkspaceViewerService.readFile()` (or the GET route), redact explicitly and compare
  with the original. If redaction changed the content, return it `readOnly` with a reason saying
  the file contains secrets and can't be edited in the hosted viewer. The route then sets
  `res.locals.skipSecretRedaction` so the response isn't redacted a second time.
- Defence in depth: `saveFile()` refuses content containing the redaction marker when the file on
  disk doesn't already contain it.
- Tests (`src/test/**`): a file with a credential comes back read-only; a save that would introduce
  `[REDACTED]` is rejected and the file is unchanged; an ordinary file still round-trips.
