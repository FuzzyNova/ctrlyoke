# A missing or blocked `@dir/` reference is never reported as skipped

- **Found:** 2026-10-15 by Claude Code (bug-hunt final step; reproduced against compiled `out/`)
- **Area:** `src/utils/AttachmentBuilders.ts` (`buildDirectoryAttachmentXml`), `src/utils/ContextExpander.ts`
- **Severity:** medium

## Symptom

`@nope/` (a directory that doesn't exist) and `@../outside/` (outside every trusted root) both
expand to an ordinary attachment whose body says "Directory not found: …" or "Directory reference
is outside the workspace and was blocked: …", with `skipped: []`. So:

- no unresolved-reference warning diagnostic is emitted;
- `execution.contextResolutionFailure: fail` never stops the step;
- the error text reaches the model as if it were real context.

By contrast, `@nope/file.ts` is reported as skipped.

## Steps to Reproduce

1. Run a step whose prompt contains `@nope/` with `contextResolutionFailure: fail`.
2. The step runs, and the prompt carries a "Directory not found" attachment.

## Root Cause

`AttachmentBuilders.ts:128-148` returns attachment strings from both failure branches instead of
throwing. `ContextExpander.expandContextSplit` adds to `skippedReferences` only from its `.catch`,
so these failures never reach it. `docs/workflows/context-files.md` ("Where paths resolve") says
references that escape the roots "are blocked and reported as skipped".

## Suggested Fix

Throw from both branches, the same way file references do, so the existing `.catch` records them
in `skippedReferences`. Add `@dir/` to the `execution.contextResolutionFailure` description in
`schemas/settings-schema.json` and run `npm run schema:update`. Add tests for a missing directory
and an out-of-root directory.
