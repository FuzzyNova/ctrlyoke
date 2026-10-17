# README logo uses a relative image path that vsce rewrites to a GitHub raw URL

- **Found:** 2026-10-17 by release-ready audit workflow (Claude, legal-metadata auditor)
- **Area:** `README.md` (L2)
- **Severity:** low

## Symptom

`README.md:2` is `<img src="images/icon.png" …>`. When packaging, `vsce` rewrites it to
`https://github.com/FuzzyNova/ctrlyoke/raw/HEAD/images/icon.png`, which returns 404 while the repo
is private. The README is frozen into each VSIX, so the logo at the top of the Marketplace page
depends on the GitHub repo name and default branch. The other README images already use absolute
`https://ctrlyoke.dev/docs/screenshots/...` URLs, as `.github/copilot-instructions.md` requires.

## Steps to Reproduce

1. `npx vsce ls`, or unzip `ctrlyoke-0.2.0.vsix`, and open `extension/readme.md`.
2. The logo `src` is the GitHub raw URL.

## Root Cause

The logo predates the absolute-URL rule and was never updated.

## Suggested Fix

Serve the icon from ctrlyoke.dev. For example, reference it from the docs or landing public assets
(extend `scripts/sync-docs-screenshots.mjs` if it should come from `images/`), and use the absolute
URL in `README.md`. This is harmless once the repo is public, as long as the flip comes before the
v0.2.0 publish.
