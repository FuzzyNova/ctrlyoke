# Cancelling commit-message generation before the harness starts is ignored

- **Found:** 2026-10-15 by bug-hunt final step (claude-cli)
- **Area:** `src/git/CommitMessageGenerator.ts`, `src/scm/ScmCommitCommand.ts`
- **Resolution:** fixed in this commit

## Symptom

You click "Generate commit message", then cancel while ctrlyoke is still reading
the diff or setting up the run. The harness run still goes to completion,
costing money and possibly taking minutes. The spinner and
`GENERATING_COMMIT_MESSAGE` stay on the whole time, more cancel clicks do
nothing, and the result is thrown away at the end.

## Steps to Reproduce

1. In the SCM view, click "Generate commit message" on a repo with a large
   staged diff.
2. Cancel immediately, while `getDiff()` or the generator's setup is running.
   Setup here is `readCommitMessageLineageKey`, `loadPromptStringAsRun`,
   `updateWorkingFileProperties` and `writeCommitMessageLineageKey`.
3. The harness still runs to completion; its output is discarded with
   "Commit message generation cancelled".

## Root Cause

`CommitMessageGenerator.generateMessage` (~695–702) registers
`token.addEventListener("abort", …)` and immediately calls
`instance.executeLoadedPromptFile(harness)`. An `abort` listener added to a
signal that has already aborted never fires, and nothing checks
`token.aborted` before the run starts. `ScmCommitCommand` (~93–114) likewise
calls `generateMessage` after `getDiff()` without checking
`abortController.signal.aborted`.

## Suggested Fix

In `generateMessage`, check `token?.aborted` before the expensive setup and
again right before `executeLoadedPromptFile`, and throw the existing cancel
error. After registering the listener, call it at once if the signal has already
aborted. In `ScmCommitCommand`, stop after `getDiff()` when the signal is
aborted. Add a unit test that passes an already-aborted signal and asserts the
harness run is never started.
