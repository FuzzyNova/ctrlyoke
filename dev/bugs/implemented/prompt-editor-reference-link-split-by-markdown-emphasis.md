# Prompt editor splits a reference link where markdown emphasis overlaps it

- **Found:** 2026-10-08 by Claude (claude-cli), Wave 3 review of M2 (`a1e420025`)
- **Area:** `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx` (link decorations at `Prec.highest`), `src/ui/webview-react/utils/codemirrorLanguage.ts`
- **Severity:** low

## Symptom

With atomic references off, `see @src/a*b*c.ts` renders the reference as three `.cm-link`
spans, and the `*b*` part is italic. `x *a @src/b*c.ts* y` splits the same way. Hover
underline and styling are fragmented. Clicking still works because every fragment carries
`data-path`, and chips are unaffected.

## Steps to Reproduce

1. Turn off `ui.atomicContextReferences`.
2. Type `see @src/a*b*c.ts` in the prompt editor.
3. Inspect the DOM: there are three `.cm-link` spans, and the middle one sits inside an
   emphasis span.

## Root Cause

Lezer parses `*b*` as emphasis without knowing it sits inside a ctrlyoke reference. The link
mark is drawn innermost (`Prec.highest`), so CodeMirror splits it at every boundary of the
emphasis span around it.

## Suggested Fix

**Resolution:** fixed in this commit. `.cm-link` resets `font-style` and `font-weight` on every
fragment, keeping the text and hover underline visually uniform when Lezer splits a reference
around emphasis. The DOM may still contain multiple adjacent link spans; all retain their
`data-path`, so clicking continues to work. Atomic chips are unchanged.
