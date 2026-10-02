# Clicking a prior-context reference in the Output pane always previews "no prior context available"

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli), code-path review
- **Area:** `src/ui/webview-react/components/output/ContextReference.tsx`, `src/ui/webview-react/utils/contextReferenceActions.ts`
- **Resolution:** fixed in this commit

## Symptom

In the Output pane, clicking a `$previous`, `$previous:N`, `$all` or `$step:N`
chip/link opens a preview that reads
`<!-- $previous:2: no prior context available at this step position ... -->`.
This happens even though the run injected exactly those outputs. The chip can
be in an echoed prompt or in an agent reply, since 0ad28a538 links references
cited in replies. `$finalStep`/`$allFinalStep` still work. Ctrl+click on the
same token in the prompt editor shows the correct preview.

## Steps to Reproduce

1. Run a 3-step workflow whose step 3 prompt contains `$previous:2` (or `$step:1`).
2. When it finishes, click that reference in the Output pane under step 3.
3. The preview modal shows the "no prior context available" comment.

## Root Cause

`ContextReference.tsx` (~42-46) calls
`openContextReference(contextReferenceTargetFromDescriptor(descriptor), getVsCodeApi())`
without a `stepCount`. `contextReferenceActions.ts` (~109-115) then posts
`REQUEST_PRIOR_CONTEXT_PREVIEW` with `stepCount: undefined`.
`WebviewMessageRouter.ts` (~1148-1155) converts that to `0`, and
`PriorContextPreviewBuilder.buildPreview` passes `0` as the group-start boundary
to `RunOutputResolver.resolvePriorContextItems`. Every queue loop there is
bounded by `index < groupStartBoundary`, so nothing is selected. Final-step
items are not bounded, which is why those two keywords still work.

## Suggested Fix

Thread the row's step position into `ContextReference`, from `OutputRow` and
through `MarkdownText` for replies. Pass it to `openContextReference` as
`stepCount`, using the same parallel-group-adjusted boundary the prompt editor
uses for Ctrl+click (look for the editor's prior-context preview caller and
reuse its boundary helper rather than recomputing it). For a final-step row,
use the boundary the final step resolves prior context with. Add a webview test
showing that clicking a `$previous:2` chip on step 3 posts the step's boundary,
and a router/preview test showing that a non-zero boundary returns content.
