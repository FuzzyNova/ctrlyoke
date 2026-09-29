# Encoded `/index.html` variants still reach the hosted static handler without a token

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/server/CtrlYokeHostedServer.ts` (page routes and `express.static(webviewDist)`, around lines 966-973)
- **Resolution:** fixed in this commit

## Symptom

`dev/bugs/implemented/hosted-index-html-served-raw-without-token.md` fixed `/index.html`. Request
paths that Express routing doesn't match, but that `send` decodes to the same file, still fall
through to `express.static` and serve the raw, unpatched HTML (`{{cspSource}}` placeholders)
without a token.

## Steps to Reproduce

Verified by an agent against the real server, without a token:

| Request                        | Result                  |
| ------------------------------ | ----------------------- |
| `/index.html`                  | 401 (correct)           |
| `/%69ndex.html`                | 200, raw HTML           |
| `/index%2ehtml`                | 200, raw HTML           |
| `/./index.html`                | 200, raw HTML           |
| `/%66avicon.svg`               | 200, uncolorized icon   |

## Root Cause

Express matches routes against the raw path, while `express.static`/`send` decode and normalize it
before resolving the file. Route order alone can't cover every spelling.

## Suggested Fix

Make the static handler itself refuse the HTML entry. For example, pass `index: false` and add a
guard in front of `express.static` that returns 404 when
`path.basename(decodeURIComponent(req.path)).toLowerCase()` is `index.html`. Or route the
decoded/normalized path to the page handler. Treat the colorized favicon the same way. Add tests
for the table above.
