# `@` completion lists nothing for a folder that isn't at the workspace root

- **Found:** 2026-10-20 by the user, typing `@backlog/secre` in the prompt editor
- **Area:** `src/completions/WorkspacePathQuery.ts` (`queryFileEntries`)
- **Resolution:** fixed in this commit

## Symptom

Typing `@backlog/secre` in the prompt editor showed no completions, although
`dev/bugs/backlog/secret-completion-first-list-takes-seconds.md` exists. The text turned into an
orange (unresolved) chip, so the editor looked finished with nothing to offer.

## Steps to Reproduce

1. In the prompt editor, type `@backlog/`.
2. No list appears; typing more (`secre`) still shows nothing.

## Root Cause

A query containing `/` was treated as an exact parent folder: `queryFileEntries` kept only entries
whose parent is `backlog` (`store.hasLowerParent(position, parent)`). There is no root-level
`backlog/`, so no entry matched. Slash-free queries are fuzzy over the whole path; scoped ones
were not.

## Fix

When the exact-parent scope matches nothing, `queryFileEntries` falls back to the same
whole-path fuzzy scan a slash-free query uses, so `backlog/secre` finds
`dev/bugs/backlog/secret-...`. A query naming a real folder (`src/ui/editor/Co`) still lists only
that folder's direct children.
