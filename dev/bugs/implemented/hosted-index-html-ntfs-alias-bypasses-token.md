# Hosted /index.html token guard bypassable via NTFS aliases on Windows

- **Found:** 2026-09-29 by bug-hunt final step (claude-cli)
- **Area:** `src/server/CtrlYokeHostedServer.ts` (static-file guard before `express.static`)
- **Resolution:** fixed in this commit

## Symptom

Without a token, `GET /index.html::$DATA` and `GET /INDEX~1.HTM` (8.3 short name) return 200 with the raw `index.html` from `express.static` on Windows. `favicon.svg` is exposed the same way. Follow-up to the fixed `hosted-index-html-encoded-path-bypasses-token.md`.

## Steps to Reproduce

1. On Windows, run the hosted server.
2. Request `/index.html::$DATA` with no token → 200 with raw HTML.

## Root Cause

The guard compares the decoded, normalized request path textually against `/index.html` and `/favicon.svg`. NTFS resolves alternate data stream (`::$DATA`) and short-name (`~1`) aliases to the same file, and `send` passes them to `fs`.

## Suggested Fix

Reject static request paths containing `:` or `~` segments (no legitimate built asset uses them), or compare file identity (resolved `realpath`/`stat` ino) against the protected files instead of path strings. Add a test.
