# Dashboard File References Skip Shared Quoting

- **Found:** 2026-11-10 by smell-hunt pass 11
- **Area:** `src/ui/webview-react`
- **Resolution:** fixed in this commit

## Symptom

Dashboard file references containing a colon were inserted without quotes. The
reference parser treats the colon as a delimiter, so paths such as
`docs/a:b.md` were truncated. Top-level filenames also skipped the canonical
quoted form.

## Root Cause

The workspace explorer and editor context menus had private builders that
quoted only paths containing spaces. Snapshot and pasted-image insertions
prefixed paths with `@` directly. These copies bypassed
`src/utils/ContextReferenceBuilder.ts`, the shared insertion formatter.

## Resolution

The dashboard and native output/paste insertion paths now use the shared file
and directory reference builders. Capture handlers return raw workspace-relative
paths so callers format each reference once.
