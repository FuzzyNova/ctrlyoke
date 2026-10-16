# @ completion misses ignored files past the discovery walk cap

- **Found:** 2026-10-16 by the user, while testing `ui.respectGitignoreForCompletions: false`
- **Area:** `src/utils/CompletionFileDiscovery.ts`, `src/utils/WorkspaceSearchFileWalker.ts`
- **Severity:** high

## Symptom

With `ui.respectGitignoreForCompletions` off, typing a file's exact name after
`@` does not list it if discovery never reached it. In this repo, typing
`@copilot-instruction` showed only `create-instructions/` folders from
`.vscode-test/` and never `.github/copilot-instructions.md`.

## Steps to Reproduce

1. Set `ui.respectGitignoreForCompletions` to `false` in a workspace with more
   than 100,000 files, most of them in ignored trees (this repo has 152,893,
   most under `.vscode-test/`).
2. Type `@` followed by the exact name of an ignored file that the walk
   reaches only after 100,000 others.
3. The file is not offered.

## Root Cause

`listCompletionFiles()` walks with `MAX_COMPLETION_FILES = 100_000` and
`MAX_COMPLETION_WALK_MS = 10_000`. A file the walk never reaches never enters
`CompletionCore`'s candidate list, so no ranking can surface it.

A partial fix has shipped: the Git-visible list is now uncapped and comes
first, and the walk is breadth-first. A tracked or untracked non-ignored file
can no longer be cut off, but an ignored file still can.

## Suggested Fix

Replace the capped re-list with a persistent, uncapped index kept in a worker
thread, updated by the file watcher, and queried by a streaming scan. See
`dev/backlog/WORKSPACE_FILE_INDEX_PLAN.md`.
