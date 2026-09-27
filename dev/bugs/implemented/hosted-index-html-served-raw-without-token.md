# `/index.html` is served raw by `express.static`, bypassing the token check and HTML patching

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/server/CtrlYokeHostedServer.ts` (static and page route registration)
- **Resolution:** fixed in this commit

## Symptom

- `GET /index.html` with no token returns 200 and the raw Vite HTML, instead of the themed 401
  that `/` returns.
- `GET /index.html?token=<valid>` returns the same raw page. It has no standalone shim, and the
  `{{cspSource}}`, `{{codiconsUri}}`, `{{customIconsUri}}` and `{{typoUri}}` placeholders are
  left in, so the page can't work.
- `/` without a token correctly returns 401, and `/?token=` returns the patched page.

Reproduced with the real server under `npx tsx`. Nothing sensitive is disclosed (it is the public
Vite shell), but it breaks the rule that the HTML entry requires the token and goes through
`buildHtml`, and anyone following an `/index.html` link gets a broken page.

## Steps to Reproduce

1. Start the hosted server.
2. Request `/index.html` without a token: 200 with raw HTML.
3. Request `/index.html?token=<token>`: the same raw HTML, with `{{...}}` placeholders left in.

## Root Cause

`this.app.use(express.static(webviewDist, { index: false }))` (`~886`) is registered before
`this.app.get(["/", "/index.html"], requireTokenForPage, …)` (`~965`). `index: false` only
disables directory-index serving. An explicit request for `/index.html` still matches the file, so
the static handler answers first and the `/index.html` half of the page route never runs.

## Suggested Fix

Register the `/`/`/index.html` page route before `express.static`, or make the static handler
skip `index.html` (e.g. a small wrapper that calls `next()` for that path). Add a test: `/index.html`
without a token returns 401; with a token it returns the same patched HTML as `/`.
