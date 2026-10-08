# Hosted dashboard shows high-contrast dark syntax colours in a high-contrast light theme

- **Found:** 2026-10-08 by Claude (claude-cli), while reviewing Wave 1 of the editor intelligence staging plan (M1)
- **Area:** `src/server/CtrlYokeHostedServer.ts`, `src/types/DashboardConstants.ts`, `src/ui/webview-react/styles/globals.css`
- **Resolution:** fixed in this commit

## Symptom

With VS Code on a high-contrast **light** theme, the hosted browser dashboard paints code tokens
(output code blocks, the workspace editor) with the high-contrast **dark** palette, for example
`#ce9178` strings and `#9cdcfe` variables on a white background. Inside VS Code's own webview
the colours are right.

This is a regression from the M1 single-source palette (commit `888c227e0`). Before it, token
colours came from forwarded `--vscode-*` variables, so they followed the theme. They now come
from the `--cy-syntax-*` values set per body class in `globals.css`.

## Steps to Reproduce

1. In VS Code, pick a high-contrast light theme (e.g. "Light High Contrast").
2. Enable the hosted server and open the dashboard in a browser.
3. Open a file with code in the workspace viewer, or view output with a fenced code block.
4. Tokens use the high-contrast dark colours.

## Root Cause

- `THEME_KINDS` (`DashboardConstants.ts:3248`) has only `LIGHT`, `DARK` and `HIGH_CONTRAST`.
  `useMessageHandler.ts:296` maps any body with `vscode-high-contrast` to `HIGH_CONTRAST`, and
  VS Code adds that class for high-contrast light too.
- `CtrlYokeHostedServer.resolveThemeBodyClass` (`CtrlYokeHostedServer.ts:2322`) therefore emits
  only `vscode-high-contrast` for the hosted page, never `vscode-high-contrast-light`.
- In VS Code the body carries both classes, and the `body.vscode-high-contrast-light` rule wins
  by source order. The hosted page has only the first class, so it gets the dark values.

`stepColor.ts:63` already distinguishes the two classes, so other hosted colours may share this
gap.

## Suggested Fix

Add a `HIGH_CONTRAST_LIGHT` theme kind, detect it from `vscode-high-contrast-light` before the
generic high-contrast check, and have `resolveThemeBodyClass` emit
`vscode-high-contrast vscode-high-contrast-light` for it. Add a `syntaxPalette.test.ts` case
that the high-contrast light values win when both classes are present, and a hosted-server test
for the body class.

## Fix

- `THEME_KINDS.HIGH_CONTRAST_LIGHT`, plus `THEME_KIND_BODY_CLASSES` (the body class set per
  kind; high-contrast light carries both classes) and `isThemeKind`/`isLightThemeKind` in
  `DashboardConstants.ts`.
- The hosted server's first render and the standalone shim's theme updates both apply
  `THEME_KIND_BODY_CLASSES`. The shim needed the change too: it re-applied a single class on
  every theme update, which would have undone the server fix.
- The webview detects the kind with one helper, `utils/themeKind.ts`, that checks
  high-contrast light first. Mermaid's theme and the CodeMirror `dark` flag now treat
  high-contrast light as light.
- Same root cause, also inside VS Code: `globals.css` set `color-scheme: dark` for
  `body.vscode-high-contrast` _after_ the light rule, so high-contrast light got dark native
  form controls. The rules are swapped, and `syntaxPalette.test.ts` now asserts that every
  property set for both classes is set for high-contrast light later in the file.
