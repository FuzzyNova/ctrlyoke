# `@"` completions are filtered to an empty list by VS Code

- **Found:** 2026-10-15 by claude-cli bug-hunt final step (reasoned from VS Code's filtering rules; not run in a live host — low confidence)
- **Area:** `src/completions/PromptCompletionProvider.ts`, `src/completions/CompletionCore.ts`
- **Severity:** low

## Symptom

Typing `@"my dir/` in a prompt is meant to offer completions inside a quoted
path (`isInsideQuotedPath` in `PromptCompletionProvider.ts` around lines
125-131 deliberately allows it), but the list is expected to come up empty in
VS Code. In a JSON prompt the typed text is `@\"my dir/`, which is not
recognised as a quote opener at all, so no list appears.

## Steps to Reproduce

1. In a `.ctrlyoke.yaml` prompt, type `@"my dir/` where `my dir/` exists.
2. Expected: matching files. Expected-actual (unverified): no suggestions.

## Root Cause

The replace range starts right after `@` (`PromptCompletionProvider.ts` around
line 170), so VS Code filters on `"my dir/`. `CompletionCore.getFileCompletions`
strips the leading `"` and returns correct matches, but each item's
`filterText` is `${name} ${relativePath}` (`CompletionCore.ts` around line 274),
which contains no `"`, so VS Code's fuzzy matcher drops every item.
`completions.instructions.md` describes the same trap, already fixed for
`/skill:`.

## Suggested Fix

Confirm in a live VS Code host first. If confirmed, set `filterText` to the
typed form (prefix `"` when the query starts with one) and recognise `\"` as
the quote opener in JSON-escaped prompts.
