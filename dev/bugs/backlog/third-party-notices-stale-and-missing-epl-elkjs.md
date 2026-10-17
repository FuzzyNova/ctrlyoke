# THIRD_PARTY_NOTICES.md is stale and omits EPL-2.0 elkjs shipped in the VSIX

- **Found:** 2026-10-17 by release-ready audit workflow (Claude, legal-metadata auditor, confirmed by verifier)
- **Area:** `THIRD_PARTY_NOTICES.md`, `package.json` `dependencies`, webview bundle (`out/ui/webview-react/assets/`)
- **Severity:** high

## Symptom

- `ctrlyoke-0.2.0.vsix` contains `extension/out/ui/webview-react/assets/elk-*.js` (~1.4 MB),
  which is elkjs@0.9.3, licensed EPL-2.0 (weak copyleft) and pulled in by `mermaid@12`. The
  bundled chunk has no licence header, and `THIRD_PARTY_NOTICES.md` never mentions elkjs or
  EPL-2.0 (not in the licence summary, not in the "Special Attention" table).
- The file says "audited on July 5, 2026". These shipped direct dependencies are missing from it:
  `@codemirror/lsp-client`, `@vscode/extension-telemetry`, `ajv-formats`, `lucide-react`,
  `mermaid`, `minimatch`, `vscode-jsonrpc`, `yaml`. It still lists `@types/js-yaml`, which is no
  longer a dependency. Several versions are stale (chalk 5.6.2 vs 6.0.1 installed, commander 14 vs
  15, gpt-tokenizer 3 vs 4, streamdown 2.5 vs 2.7).
- It lists package names only. MIT, ISC and BSD require the copyright and licence text to go with
  copies, and the minified webview bundle strips them. `LICENSE.md` §7(b) points users to this file
  as the attribution record.
- The file's own footer says it "should be regenerated before release".

## Steps to Reproduce

1. `npx license-checker --production --summary` reports `EPL-2.0: 1`, which is elkjs.
2. `npm ls elkjs` shows `mermaid@12.2.0 -> elkjs@0.9.3`.
3. `grep -iE "elkjs|EPL" THIRD_PARTY_NOTICES.md` finds nothing.

## Root Cause

The notices file is maintained by hand. The mermaid 12 upgrade and several later dependency
additions happened after the July audit, and nothing checks the file against `package.json`.

## Suggested Fix

- Regenerate from the current production tree, including each package's licence text and copyright
  line (e.g. `license-checker --production --files`, or a Vite licence plugin for the webview
  bundle).
- Add elkjs to the EPL/"Special Attention" section with the EPL-2.0 link and its source location
  (https://github.com/kieler/elkjs). Alternatively, decide to exclude the ELK layout engine from the
  mermaid build.
- Add the MPL-2.0 source URL for `@resvg/resvg-wasm`, since its VSIX copy ships no LICENSE file.
- Consider a `check:*` script that fails when production deps drift from the notices table.
- Rebuild the VSIX after regenerating. The current `0.2.0` package carries the stale copy.
