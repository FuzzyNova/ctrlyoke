# Hosted dashboard injects `server.iconBgColor`/`iconFgColor` unescaped into its HTML (stored XSS)

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli), code reading
- **Area:** `src/server/CtrlYokeHostedServer.ts` (`buildHtml`, `buildManifest`, `serveColorizedSvg`, `serveColorizedPng`), `src/server/IconColorizer.ts`
- **Resolution:** fixed in this commit

## Symptom

A `.ctrlyoke/settings.json` that sets a non-hex icon color gets that value
written verbatim into the hosted dashboard page. A workspace settings file is
committed repo content. So a cloned repo can run script in the dashboard origin
the moment the user opens the hosted dashboard. That script can read the access
token from `location.search` and drive every token-gated API and the WebSocket:
run workflows, write files, and answer approval prompts.

## Steps to Reproduce

1. In a workspace, write `.ctrlyoke/settings.json`:
   ```json
   { "server": { "iconBgColor": "#000\" /><script>alert(document.location)</script><link x=\"" } }
   ```
2. Start the hosted server (`ctrlyoke.enableServer`) and open its URL.
3. The `<script>` runs. The page CSP allows `script-src 'self' 'unsafe-inline'`.

A non-string value (`"iconBgColor": 1`) makes `.replace` throw instead, so every
SPA route and `/manifest.webmanifest` return a 500.

## Root Cause

- `buildHtml` (~1927-1946) does the following with the raw config values:
  `` `?bg=${iconBgColor.replace("#", "")}&fg=${iconFgColor.replace("#", "")}` ``
  It then interpolates them into `href="..."` attributes with no escaping.
- `buildManifest` (~2070-2074) does the same.
- `colorizeSvg` (`IconColorizer.ts`) puts the raw value into the SVG's
  `fill:` style. The token-free `/favicon.svg` and `/app-icon.svg` routes serve
  that SVG, and `pngIconService` renders it.
- `FileConfigBackend.load()` never validates settings against
  `schemas/settings-schema.json`, so the schema's `^#[0-9a-fA-F]{6}$` pattern
  is not enforced at runtime.

## Suggested Fix

Add one single-sourced resolver, for example `resolveHostedIconColors()` in
`IconColorizer.ts` or a sibling module. It reads `server.iconBgColor` and
`server.iconFgColor` and accepts a value only if it is a string matching the
schema's hex pattern; anything else falls back to `ICON_BG_COLOR_DEFAULT` /
`ICON_FG_COLOR_DEFAULT`. Use it at all four call sites. Keep the pattern as a
shared constant next to the defaults (`src/types/IconColorDefaults.ts`). Also
HTML-attribute-escape the generated icon query string in `buildHtml`, as
defense in depth.
