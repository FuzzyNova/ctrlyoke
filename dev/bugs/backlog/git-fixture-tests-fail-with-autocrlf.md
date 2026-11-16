# Git fixture tests fail when the developer has `core.autocrlf=true`

- **Found:** 2026-11-15 by the orchestrator review of session-control Stage 1 (`npm test` on a
  machine with `core.autocrlf=true` in `~/.gitconfig`)
- **Area:** `src/test/unit/HostedWorkspaceViewerService.test.ts` (`discardFile` suite),
  `src/test/unit/WorktreeManager.test.ts`
- **Severity:** low

## Symptom

- `HostedWorkspaceViewerService > discardFile > discards only a bracketed literal path`:
  expected `'original\n'`, got `'original\r\n'`.
- `WorktreeManager > updates a named worktree from source without changing the source branch`:
  expected `'source\n'`, got `'source\r\n'`.

## Steps to Reproduce

1. `git config --global core.autocrlf true` (Git for Windows' installer default).
2. `npm run test:extension -- HostedWorkspaceViewerService WorktreeManager`
3. Both tests fail on the line endings.

## Root Cause

The tests commit `\n` content into a fresh repository and read it back after git writes the
file (a discard, a checkout). The fixture repositories inherit the developer's global
`core.autocrlf`, so git converts the file to CRLF on checkout. `RunBundleExporter.test.ts`
already avoids this with `git config core.autocrlf false` in its fixture repo.

## Suggested Fix

Set `core.autocrlf=false` (and `core.eol=lf`) in every test fixture repository, ideally in the
shared repository helpers (`runGit`/`configureGitIdentity`, `makeRepository`) so new fixtures
get it too, rather than per test.
