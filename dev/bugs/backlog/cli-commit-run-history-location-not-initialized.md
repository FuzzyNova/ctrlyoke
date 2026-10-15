# `ctrlyoke commit` never initializes the run-history location, so message generation throws

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/cli.ts`
- **Severity:** high

## Symptom

The standalone `ctrlyoke commit` command always fails after it collects the diff. This includes `--print-only`, `--all` and `--yes`. It prints:

```
Error: Run history location has not been initialized; initialize it after config bootstrap.
```

It then exits with code 1 without producing a commit message. Commit-message generation works in the VS Code SCM integration but not from the CLI.

## Steps to Reproduce

1. In any git repository, stage a change (for example, edit a file and run `git add .`).
2. Run `ctrlyoke commit --print-only` (or plain `ctrlyoke commit`) from the standalone CLI binary.
3. `Checking for changes...` and `Generating commit message...` are printed, followed by the error above, and the process exits with code 1.
4. No harness is ever invoked and no commit message is printed or committed.

## Root Cause

`commitCommand` (`src/cli.ts:2731-2759`) sets up the user and workspace config backends but never calls `initializeRunHistoryLocation(...)`. `runCommand` does this at `src/cli.ts:871`, and `bootstrapCliWorkspace` (`src/cli/CliWorkspaceBootstrap.ts`) does it too, but `commit` uses neither. No module that `commit` loads freezes the location either.

`CommitMessageGenerator.generateMessage` always records the generation as a run. The failing call chain is:

1. `instance.loadPromptStringAsRun` (`src/git/CommitMessageGenerator.ts:631`)
2. `WorkflowInstance.loadPromptStringAsRun`, then `promptQueue.createWorkingFile` (`src/core/WorkflowInstance.ts:1549`)
3. `WorkflowLineageRepository.createLineage`, then `WorkflowPaths.allocateWorkflowKey` (`src/core/orchestration/WorkflowLineageRepository.ts:121`)
4. `runsRoot()` (`src/utils/WorkflowPaths.ts:563`)
5. `getFrozenRunHistoryLocation()` (`src/utils/WorkflowPaths.ts:164`), which throws because nothing froze the location (`src/utils/RunHistoryStoragePolicy.ts:44-48`)

`readCommitMessageLineageKey` (`src/git/CommitMessageGenerator.ts:72-99`) runs earlier and hits the same throw, but its blanket `catch` hides it. `CommitMessageGenerator.ts:789-799` wraps the error in a `CommitMessageGenerationError`. That error is caught at `src/cli.ts:2778-2792`, which calls `process.exit(1)`.

The VS Code path works because `activate()` freezes the location. Tests miss the bug because `src/test/suite/index.ts:40-41` freezes the location globally for the whole suite.

## Suggested Fix

- **Minimal fix:** in `commitCommand`, right after `configService.setWorkspaceBackend(workspaceBackend)` and any CLI overlay, freeze the location the same way `runCommand` does:
  `initializeRunHistoryLocation(configService.get("storage").runHistoryLocation)`.
  Guard the call with `isRunHistoryLocationInitialized()` if needed.
- **Better fix:** move config bootstrap and the run-history freeze into one shared helper, or route `commit` through `bootstrapCliWorkspace`. Then every CLI subcommand that touches run storage freezes the location in one place.
- **Regression test:** call `resetRunHistoryLocationForTests()`, then run the commit command's bootstrap path. This keeps the global freeze in `src/test/suite/index.ts` from hiding the bug again.
