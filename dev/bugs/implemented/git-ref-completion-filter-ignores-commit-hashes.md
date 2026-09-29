# Typing a commit hash after `~` returns no commit completions

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/completions/CompletionHelpers.ts`, `src/utils/GitUtils.ts`
- **Resolution:** fixed in this commit

## Symptom

`~` completions list recent commits, and each item's `filterText` includes the full and short
hash and the author. But as soon as the user types anything after `~`, only commits whose
**message** matches are offered. Typing a hash prefix (or an author name) returns no commits,
even for the most recent commit shown a keystroke earlier.

In this repo: `getGitChangeCompletions(root, "")` includes `5b55886 — fix: normalize Copilot and
OpenCode token usage`, but `getGitChangeCompletions(root, "5b55886")` returns no commits.

Separately, the query is passed to `git log --grep` as a regex: `.` matches any character, and a
query with `[` makes git fail, which silently falls back to the recent list.

## Root Cause

With a non-empty filter, `getGitChangeCompletions` (around lines 1268-1291) replaces the commit
list with `searchCommitsBySubject` (`GitUtils.ts`, around lines 692-731), i.e.
`git log --grep=<filter> --regexp-ignore-case`, which only searches messages. The recent-commits
cache is dropped before the client-side filter (which does check hash/shortHash/author) runs.

## Suggested Fix

Merge the `--grep` results with the recent-commits cache (dedupe by hash, recent first) instead of
replacing it, so the client-side filter can match hashes and authors. When the filter looks like
a hash (`^[0-9a-f]{4,40}$`), also resolve it with
`git rev-parse --verify --end-of-options <x>^{commit}` so older commits can be found by hash. Add
`--fixed-strings` to the `--grep` search so the query is literal.

Regression tests: stub `getRecentCommits`/`searchCommitsBySubject` (search returns `[]`) and assert
a recent commit whose hash starts with the filter is still returned; an author-name filter case;
and a real temp-repo test of `searchCommitsBySubject` with a `.` / `[` query.
