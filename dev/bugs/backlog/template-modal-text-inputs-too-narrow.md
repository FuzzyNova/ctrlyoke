# Template modal single-line text variables render too narrow to read

- **Found:** 2026-10-11 by Claude while capturing the D25 template-modal screenshot
- **Area:** `src/ui/webview-react/components/workflow/TemplateModal.tsx`
- **Severity:** low

## Symptom

In **Create Workflow from Template**, every single-line text variable is about 165 CSS px wide
regardless of the modal's width. The modal is 672 px wide, and the harness and select variables
and the multi-line textarea fill it. Full Feature Pipeline's own default
`planDocument` value, `.ctrlyoke/plans/plan.md`, is cut off (`.ctrlyoke/plans/plan.m`), and so is
any realistic path a user types.

## Steps to Reproduce

1. Open the dashboard and choose **New → New From Template...**.
2. Pick **Full Feature Pipeline**.
3. Look at `planDocument`, `testCommand` and `formatCommand`. They are short boxes, and the
   default plan path does not fit.

## Root Cause

`inputClass` (`TemplateModal.tsx:720-721`) sizes the input with `flex-1`. Only file and directory
pickers wrap the input in a flex row (`className={isPicker ? "flex gap-1.5" : undefined}`,
line 738). For a plain text variable the wrapper is a block `div`, so `flex-1` does nothing and
the `<input>` falls back to the browser's default `size` width. The textarea branch adds `w-full`
itself (line 787), which is why multi-line variables look right.

## Suggested Fix

Give the non-picker `<input>` `w-full` (as the textarea already has), or always render the
wrapper as a flex row so `flex-1` applies. Then re-capture
`images/screenshots/template-modal-full-feature-840x1123.png` with the template's default
`planDocument` value instead of the shortened `plans/notes-tags.md`.
