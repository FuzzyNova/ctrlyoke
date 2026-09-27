# Commit message generation describes the wrong changes when the staged diff exceeds 1 MiB

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli)
- **Area:** `src/git/CommitMessageGenerator.ts` (`CommitMessageGenerator.getDiff`)
- **Resolution:** fixed in this commit

## Symptom

When the staged diff is larger than 1 MiB, commit-message generation (SCM button,
hosted dashboard, and `ctrlyoke commit`) silently ignores the staged changes and
generates a message from the **unstaged** working-tree diff instead — or reports
that there is nothing to commit when there are no unstaged changes. The user sees
"Generated from unstaged changes", but the commit still records the staged changes.
With `ctrlyoke commit --yes` the staged changes are committed under a message that
describes completely different edits.

The `MAX_DIFF_BYTES` (750 KiB) truncation meant for large diffs never runs for
diffs over 1 MiB, because the diff never gets read.

## Steps to Reproduce

1. In a scratch repo, stage a change whose `git diff --cached` output is > 1 MiB
   (e.g. rewrite a 40k-line file), and leave an unrelated small unstaged edit in
   another tracked file.
2. Run `execFile("git", ["diff", "--cached"], { cwd, encoding: "utf8" })` the way
   `getDiff` does. It rejects with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`
   ("stdout maxBuffer length exceeded"). Verified against a 3.4 MB staged diff.
3. `getDiff`'s bare `catch {}` swallows that and falls through to `git diff`,
   returning `{ staged: false, diff: <the small unrelated edit> }`.
4. `ctrlyoke commit --yes` then commits the staged rewrite with a message about the
   unrelated edit (`src/cli.ts` ~2519–2595).

## Root Cause

`getDiff` (`CommitMessageGenerator.ts:162`) calls `execFileAsync` with no
`maxBuffer`, so Node's default of 1 MiB applies. Output past that limit rejects the
promise. The `catch` is meant for "git not available or not a repo" but also swallows
the buffer overflow and treats it as "nothing staged". The same limit also hits the
`git diff` and `git ls-files` fallbacks.

Related stale text: `ScmCommitCommand.ts:127` warns "Diff exceeded 8 KB and was
truncated", but the actual limit is `MAX_DIFF_BYTES` = 750 KiB.

## Suggested Fix

Give every `execFileAsync` in `getDiff` a `maxBuffer` well above `MAX_DIFF_BYTES`
(OpenCode already does this: `OPENCODE_EXPORT_MAX_BUFFER` in
`src/core/harness/opencode/OpenCodeLogParser.ts`). Better, stream or cap the output
so a huge diff is truncated rather than rejected. Also narrow the `catch`: only
"not a git repo / git missing" should fall through to the unstaged path, and a
`ERR_CHILD_PROCESS_STDIO_MAXBUFFER` must never be read as "no staged changes". Fix
the "8 KB" warning text so it is derived from `MAX_DIFF_BYTES` (export it, don't
hardcode). Add a unit test that creates a temp git repo with a > 1 MiB staged diff
plus a small unstaged edit, and asserts that `getDiff` returns `staged: true,
truncated: true`.
