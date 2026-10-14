# Removing every target of an inline step reference leaves an empty `$step:` token

- **Found:** 2026-10-13 by Claude (review of the prior-context detail work)
- **Area:** `src/core/StepReferenceRenumbering.ts`
- **Resolution:** fixed in be9e9c0b2, and superseded by the never-rewrite rule below

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

## Resolution

Fixed by removing rewriting altogether. `be9e9c0b2` stopped removals from editing inline text;
the follow-up commit replaced `StepReferenceRenumbering.ts` with `StepReferenceShifts.ts`, which
changes nothing. The rule:

- A step insert, move, or removal never rewrites any authored setting, on any step or at workflow
  level. Inline `$step:N` / `$summary:step:N` text, `priorContext: [N]`, and `sessionId: N`
  stay exactly as written; position N means whatever step is at N.
- Step references never block an insert, move, or removal. (The parallel-sibling check still
  refuses a topology the parser could not load; it refuses, it never edits.)
- `findShiftedStepReferences` reports the unstarted steps, the final step, and workflow-level
  defaults whose references now resolve to a different or missing step. The dashboard shows it as a
  warning toast, MCP `append_step` / `reorder_steps` / `remove_step` return it as `warning`, and
  `ctrlyoke step reorder` / `step remove` print it to stderr. New steps and the step that was
  moved are not reported; the editor's reference lint still flags any reference that no longer
  resolves.
