# Full-diff Download streams unredacted secrets from the hosted server

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli subagent, reproduced against the compiled server)
- **Area:** `src/server/CtrlYokeHostedServer.ts` (`/api/workspace-viewer/git-ref-diff-download`, ~2275-2345), `src/server/HostedWorkspaceViewerService.ts` (`spawnGitRefDiffDownload`, ~3642), `src/server/SecretRedactionMiddleware.ts`
- **Resolution:** fixed in this commit

## Symptom

In a repo with a committed `app.env` (`PORT=3000`) and an uncommitted
`API_KEY=sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c` line added to it, requesting `ref=~diff` from
the hosted server:

- `GET /api/workspace-viewer/git-ref-diff` (JSON): the value is `[REDACTED]`.
- `GET /api/workspace-viewer/file?path=app.env`: the value is redacted.
- `GET /api/workspace-viewer/git-ref-diff-download`: the response body contains
  `+API_KEY=sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c` in plain text.

Run-scoped exact secrets (managed secrets granted to a running workflow) leak the same way.

## Steps to Reproduce

1. Create the repo above and start `CtrlYokeHostedServer` on it.
2. Fetch the three routes above with the access token and `ref=~diff`.
3. Only the download route returns the secret.

## Root Cause

`installSecretRedactionMiddleware` (`SecretRedactionMiddleware.ts`) only wraps `res.json` and
`res.send`. 44cb1ea2d (`fix: stream workspace diff downloads`) moved Download from the redacted
JSON route to `download.stdout.pipe(res, { end: false })`, which writes through `res.write` and
skips both wrappers. `dev/implemented/SECRETS_AND_REDACTION_PLAN.md` (Phase 4) promises every
hosted HTTP/WebSocket transport redacts.

## Suggested Fix

Insert a redacting `Transform` between git stdout and `res`: buffer by line (a unified diff is
line-oriented, and credential-file redaction is line/pattern based), pass each complete line
through `secretRedactionService.redactText`, and flush the trailing partial line on end. Keep the
existing streaming behavior (no full buffering), headers, and error handling. Add a test in the
"workspace file redaction" suite of `src/test/unit/CtrlYokeHostedServer.test.ts` that downloads
`~diff` for a credential file and asserts the value is absent and `[REDACTED]` is present,
including a value that would straddle a chunk boundary if practical.
