# Retry after Claude rejects the resume session ID can never run

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/core/harness/shared/CliExecutionRunner.ts`
- **Resolution:** fixed in this commit

## Symptom

A headless claude-cli step can try to resume a session that Claude no longer has. This happens when `~/.claude/projects/.../<id>.jsonl` was deleted or pruned, when the run moved to a different machine, or when the stored ID is not a UUID. The step then fails as a `PROCESS_EXIT` with `No conversation found with session ID ...`. The intended "Retrying without resume flag" fallback never runs, and no fresh session is started.

## Steps to Reproduce

1. Run a workflow with a claude-cli step in headless mode, so that a session ID is stored in the run's `_runtime`.
2. Delete the matching `~/.claude/projects/<project-slug>/<sessionId>.jsonl`, or change the stored `sessionId` to a UUID that does not exist.
3. Run a following step (or resume the workflow) with `resumeSession: true`, so `ClaudeCliProvider` adds `-r <sessionId>`.
4. Claude exits with code 1 and prints `No conversation found with session ID <id>` on stderr.
5. The step fails with that message as `PROCESS_EXIT`. The session log never shows the line `[CliExecutionRunner] Claude CLI rejected session ID ... Retrying without resume flag.`

## Root Cause

`executeWithRecovery` in `src/core/harness/shared/CliExecutionRunner.ts:385-453` recovers from a rejected resume session only in its `catch` block (lines 408-452). That block runs when `transportCoordinator.executeHeadless` throws an error that matches `ClaudeCliProvider.isRecoverableSessionError` (`src/core/harness/claude/ClaudeCliProvider.ts:1047-1054`). No such error is ever thrown:

1. `CliProcessManager.spawn` (`src/utils/CliProcessManager.ts:216-238`) resolves with `{ stdout, stderr, exitCode }` for every exit code. Claude's rejection is therefore only stderr text in that result.
2. `CliTransportCoordinator.spawnProcess` (`src/core/harness/shared/CliTransportCoordinator.ts:731-746`) converts only timeout and `ENOENT` failures into a `CliTransportError` (`TIMEOUT`, `HARNESS_NOT_INSTALLED`).
3. The `catch` in `CliTransportCoordinator.executeHeadless` (`CliTransportCoordinator.ts:560-568`) rethrows only `CliTransportError` and returns `false` for any other error.

The non-zero exit goes to `buildHeadlessResponseCallback` instead (`CliExecutionRunner.ts:888-897`), which records it as `PROCESS_EXIT`.

The branch would fail even if it were reached. By then the coordinator's `finally` (`CliTransportCoordinator.ts:569-572`) has already called `cleanupTempFiles(tempFilePaths)`, so the retry at `CliExecutionRunner.ts:438-447` would pass `session.promptArgument` and `session.tempFilePaths`, which point at prompt files that no longer exist.

`QwenCliProvider.isRecoverableSessionError` (`src/core/harness/qwen/QwenCliProvider.ts:951`) also exists. The runner gates the retry on `HARNESS_IDS.CLAUDE_CLI`, so that method never takes effect through this path either.

## Suggested Fix

Detect the rejection from the process result rather than from an exception:

- In the headless response callback, or in a result check that runs before it, treat a non-zero `exitCode` whose stderr matches `provider.isRecoverableSessionError` as a recoverable session rejection rather than a `PROCESS_EXIT`. Change that method to accept a string or the result object. To signal the rejection, either have the callback return a sentinel, or throw a typed `CliTransportError(FAILURE_KINDS.SESSION_REJECTED)` that the coordinator already rethrows. `executeWithRecovery` then rebuilds the arguments without resume and retries.
- Keep the prompt files alive for the retry. The coordinator's `finally` deletes them, so either defer `cleanupTempFiles` until any retry has finished (make the runner own cleanup, or add a `keepTempFiles` option for the first attempt), or rebuild the prompt files for the retry.
- Clear `session.resolvedSessionId`, or persist the new ID, so later steps stop resuming the dead session.
- Add a `CliExecutionRunner` unit test in which a fake transport returns `exitCode: 1` with `No conversation found with session ID x` on stderr. Assert that a second `executeHeadless` call is made without `-r` and that its prompt files still exist.

## Decision

Any provider implementing `isRecoverableSessionError` uses this recovery path, including Qwen. The runner owns temp-file cleanup across both attempts; the retry starts without the rejected session log source, and a newly extracted session ID is persisted for later steps.
