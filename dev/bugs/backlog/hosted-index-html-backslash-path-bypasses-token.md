# Hosted static guard is bypassed by backslash paths on Windows

- **Found:** 2026-09-29 by bug-hunt final step (claude-cli)
- **Area:** `src/server/CtrlYokeHostedServer.ts` (static-file guard before `express.static(webviewDist)`)
- **Severity:** high

## Symptom

The hosted server serves the raw `index.html` (and `favicon.svg`) without an
access token when the request path spells a separator as an encoded backslash.
This is the same class as the already-fixed `hosted-index-html-encoded-path-bypasses-token`
and `hosted-index-html-ntfs-alias-bypasses-token`, via a spelling those fixes
don't cover.

Reproduced on Windows by mounting the exact guard middleware plus
`express.static(webviewDist, { index: false })`, with no token:

- `GET /%5Cindex.html` → 200, raw HTML
- `GET /.%5Cindex.html` → 200
- `GET /a%5C..%5Cindex.html` → 200

The fix's own cases (`/index.html::$DATA`, `/INDEX~1.HTM`, `/./index.html`)
correctly return 404.

## Steps to Reproduce

1. Start the hosted server on Windows (`ctrlyoke.enableServer`).
2. Without a token, request `http://127.0.0.1:<port>/%5Cindex.html`.
3. Observe 200 with the unauthenticated HTML shell instead of 404.

## Root Cause

The guard decodes the path and then normalizes it with `path.posix.normalize`.
POSIX treats `\` as an ordinary character, so `/\index.html` never matches
`^/index(?:~\d+)?\.html?(?::.*)?$`. `send` (inside `express.static`) later
resolves the same path with the platform `path` (win32), where `\` is a
separator, so the file served is `webviewDist/index.html`.

## Suggested Fix

Normalize the decoded path the way `send` will resolve it: replace `\` with `/`
before `path.posix.normalize` (or use `path.win32` on Windows). More robust:
resolve the request against `webviewDist` with the platform `path` and compare
the result (case-folded on Windows) to the protected absolute file paths, so no
spelling can diverge from what `send` serves. Add `%5C` cases (`/%5Cindex.html`,
`/.%5Cindex.html`, `/a%5C..%5Cindex.html`, `/%5Cfavicon.svg`) to the existing
hosted-server static-guard tests.
