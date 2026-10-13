# Removing every target of an inline step reference leaves an empty `$step:` token

- **Found:** 2026-10-13 by Claude (review of the prior-context detail work)
- **Area:** `src/core/StepReferenceRenumbering.ts`
- **Severity:** low

## Symptom

When every step that an inline `$step:N` or `$summary:step:N` reference names is removed, and
the referencing step has already started, renumbering rewrites the reference to `$step:` (or
`$summary:step:`) with no indices. That text is not a valid reference, so it stays in the prompt as
literal text and the editor flags it. The YAML form of the same selection becomes
`priorContext: []`, which is valid.

## Steps to Reproduce

1. Create a workflow whose step 2 prompt contains `$step:1`.
2. Run step 2 so it has started.
3. Remove step 1 from the queue.
4. Step 2's prompt now reads `$step:`.

## Root Cause

`renumberInlineReferences` in `StepReferenceRenumbering.ts` drops each missing target from a
started step's indices (`return []`). When that empties the list, it still formats and splices
the body back in with `formatInlinePriorContextBody({ ...match.ref, indices: [] })`. Unstarted
steps are not affected: removing a referenced target is refused for them.

## Suggested Fix

When the list ends up empty, remove the whole token from the text instead of writing an empty
one. Removing it matches the YAML arm's `[]`, which selects nothing. Keeping the original token
is the other option, but it would then point at whichever step later takes that position, which
is worse. Add a test next to the existing inline renumbering tests in
`src/test/unit/StepReferenceRenumbering.test.ts`.
