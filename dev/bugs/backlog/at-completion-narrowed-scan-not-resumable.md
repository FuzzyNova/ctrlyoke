# Editor @ completion: a budgeted scan over narrowed survivors restarts from zero every keystroke

- **Found:** 2026-10-24 by bug-drain review of ce0c69dd4
- **Area:** `src/completions/WorkspacePathQuery.ts`
- **Severity:** medium

## Symptom

The original symptom of
`dev/bugs/implemented/at-completion-150ms-budget-never-scans-whole-index.md` still
happens when the query was narrowed first. Files late in the index never appear in
editor `@` completions, however much of the name is typed.

## Steps to Reproduce

1. The dashboard and the editor share one `CompletionCore` (`extension.ts`, around
   lines 510 and 547), so they share one `WorkspacePathQuery`.
2. A dashboard `@t` query runs with no budget and completes, so it remembers its
   narrowing ("t" → ~200k survivors).
3. In the editor, each of `@ta`, `@tar` and so on scans those survivors from
   index 0 and is cut off at 150 ms, so late files are never reached.

## Root Cause

`WorkspacePathQuery.ts` (around lines 202 and 226): `canResumeFromStoreStart` is
false whenever `narrowedPositions` returns survivors. An aborted scan over a narrowed
set saves no partial checkpoint, so the next keystroke starts again. Also, the test
"store mutation invalidates a partial narrowing" (`WorkspacePathQuery.test.ts`,
around lines 226-243) passes without the version check: after `replaceAll`,
position 0 is `target.ts`, which matches anyway.

## Suggested Fix

Checkpoint narrowed scans too. Store the base survivor list, the index reached in
it, and the partial survivors found so far. A query that extends the checkpointed
query resumes from that index, filtering the partial survivors and continuing
through the rest of the base list. Keep the existing generation and version guards.
Add a test where an unbudgeted query narrows first and budgeted extensions then
eventually reach a late file. Rewrite the mutation test so it fails without the
version check: make the stale partial survivor non-matching after the mutation, and
assert on a result the stale path would get wrong.
