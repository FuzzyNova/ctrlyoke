# Raw media route returns 404 for working-tree files under any dot-directory

- **Found:** 2026-11-01 by Claude Code (bug-hunt final step, reading `d795ebbf4`/`bd23b6f4a`)
- **Area:** `src/server/CtrlYokeHostedServer.ts` (`/api/workspace-viewer/raw`, working-tree branch)
- **Severity:** medium

## Symptom

The workspace viewer shows "This image can't be displayed" / "This browser can't play this
file" for any working-tree image, video, audio or PDF whose absolute path has a segment
starting with `.`, for example:

- `.github/logo.png`, `.vscode/icon.png`, `docs/.assets/demo.mp4`, `.hidden.png`
- **every** media file when the workspace itself lives under a dotted directory, such as the
  onboarding dev host's `.vscode-dev-tempdir/workspace` or anything under `~/.something/`.

The route answers `404 {"error":"Unable to serve media file"}`. Committed and index blobs
(`ref=HEAD`, `ref=:`) still work because they don't go through `sendFile`. Working-tree sides
of media diffs fail the same way.

This is a regression from `bd23b6f4a`: images used to be inlined as data URIs from `readFile`
and rendered fine in dot-directories.

## Steps to Reproduce

1. In a workspace, add `.github/logo.png` and `logo.png` (any valid PNG).
2. Request `/api/workspace-viewer/raw?path=logo.png&token=…` → `200`.
3. Request `/api/workspace-viewer/raw?path=.github%2Flogo.png&token=…` → `404`.

Reproduced with the repo's own Express 5.3.0 / send 1.2.1 and the route's exact `sendFile`
call and options.

## Root Cause

The working-tree branch calls
`res.sendFile(media.absolutePath, { acceptRanges: true, cacheControl: false }, cb)` with no
`root`. send then splits the whole absolute path into segments and runs `containsDotFile()`
on them (`node_modules/send/index.js` ~line 458). Its `dotfiles` option defaults to
`"ignore"`, which turns any dotted segment into a 404. The path has already been confined to
the workspace by `safeResolveWorkspacePath` and checked against the media allowlist, so send's
dotfile filter adds no protection here — it only rejects legitimate files.

## Suggested Fix

Pass `dotfiles: "allow"` in the `sendFile` options. Add a raw-media route test in
`src/test/unit/CtrlYokeHostedServer.test.ts` (suite "CtrlYokeHostedServer raw media route")
that serves `.github/x.png` from the working tree and asserts `200` with the file's bytes.

Related, smaller: when send rejects a range with 416, it only attaches
`Content-Range: bytes */<size>` to `err.headers`; the callback replies without it, unlike the
blob branch. Copying `err.headers` onto `res` before replying fixes that in the same callback.
