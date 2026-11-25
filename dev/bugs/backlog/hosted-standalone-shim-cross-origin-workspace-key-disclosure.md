# Any website can load `/standalone-shim.js` cross-origin and learn that ctrlyoke is running and which project is open

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude subagent; read-only, not run in a browser)
- **Area:** `src/server/CtrlYokeHostedServer.ts` (`/standalone-shim.js` route ~1320-1326), `src/server/HostedStandaloneShimScript.ts` (~19-49), `src/server/standalone-shim.js`, `src/utils/ProjectStatePaths.ts` (~116-123)
- **Severity:** low (security: cross-origin information disclosure)

## Symptom

`/standalone-shim.js` is served without the token and without a
`Cross-Origin-Resource-Policy` header. No route in `src/server` sends one. The script has
the workspace's `workspaceKey` baked in (`buildHostedStandaloneShimScript(this.workspaceKey)`),
which is `<folder basename slug>-<hash12>` (`ProjectStatePaths.ts`). The shim uses it to
name its `localStorage` entries (`fpState-<workspaceKey>-…`).

A page on any origin can include
`<script src="http://localhost:<port>/standalone-shim.js"></script>`. Classic scripts load
cross-origin without CORS, so the shim runs in the attacker's page, where its
`localStorage` writes, and any stubbed `WebSocket`/`localStorage` the page installs, reveal
the key. The page learns that the ctrlyoke hosted server is running and the name of the
folder being worked on, with no DNS rebinding and no token.

## Steps to Reproduce

By inspection:

1. Enable the hosted server (`ctrlyoke.enableServer`).
2. From an unrelated origin, load the script tag above (after stubbing `localStorage`).
3. Observe `fpState-<slug>-<hash>` keys containing the project folder name.

## Root Cause

The shim is public so the token-gated HTML can load it without a query string, but nothing
stops other origins from embedding it, and it carries a workspace-specific value.

## Suggested Fix

Send `Cross-Origin-Resource-Policy: same-origin` on `/standalone-shim.js`. The dashboard
HTML that loads it (~2631) is same-origin, so it keeps working, while browsers refuse no-cors
loads from other origins. Consider adding the header to the other public, token-free routes
too (service worker, icons, manifest), but not to `HOSTED_CERT_DOWNLOAD.PATH`, which is a
top-level navigation download, where CORP doesn't apply anyway. Alternatively, move
`workspaceKey` into the token-gated HTML and keep the public shim workspace-neutral.

Test: a request for `/standalone-shim.js` returns `Cross-Origin-Resource-Policy: same-origin`.
