# `log.showSignature=true` corrupts commit lists and commit metadata

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli subagent)
- **Area:** `src/utils/GitUtils.ts`
- **Severity:** medium

## Symptom

With `git config log.showSignature true` (a common setting for people who
sign commits), git writes signature-verification text such as
`Good "git" signature for A with ED25519 key SHA256:…` to **stdout** for every
signed commit, even when `--format` is given. ctrlyoke's commit parsers treat
that text as commit records:

- `getRecentCommits(repo, 10)` returned 4 entries for 2 commits; two of them
  were `{ hash: 'Good "git" signature for A with ED25519 key SHA256:…',
parentHashes: [], refNames: [] }` with no subject or author.
- `getCommitInfo(repo, "HEAD")` returned
  `hash: 'Good "git" signature …\nd63c33ff…'`, so the hash itself is wrong.

User-visible effects: bogus `@git:` commit completions
(`src/completions/CompletionCore.ts`, `getRecentCommits`), broken hosted commit
log/commit detail (`src/server/HostedWorkspaceViewerService.ts`), and wrong
attachment headers from `src/core/ContextExpander.ts`. `getCommitDiff`
(`git show --stat -p`) also gains the signature text.

## Steps to Reproduce

1. In a temp repo configure SSH signing (`gpg.format=ssh`, `user.signingkey`,
   `gpg.ssh.allowedSignersFile`, `commit.gpgsign=true`) and make two commits.
2. `git config log.showSignature true`.
3. Call `getRecentCommits(repo, 10)` and `getCommitInfo(repo, "HEAD")` from
   `out/utils/GitUtils.js`.
4. Extra entries and a corrupted hash appear, as above.

## Root Cause

The metadata commands in `src/utils/GitUtils.ts` run `git log`/`git show`
with a custom `--format` and parse stdout line- or NUL-wise, but none pass
`--no-show-signature`: `git log` at lines 555, 633, 671 and 1367, and `git show`
at lines 867 (`getCommitInfo`), 921 (`buildCommitDiffArgs`), 1313 and 1336.
(Line 973, `git show <ref>:<path>`, prints a blob and is unaffected.) File-history
parsing tolerates the extra lines only because of its hash regex.

## Suggested Fix

Add a shared `GIT_NO_SHOW_SIGNATURE_OPTION = "--no-show-signature"` constant
beside `GIT_DIFF_NO_COLOR_OPTION` and pass it to every `git log`/`git show`
whose output ctrlyoke parses or shows (and audit `src/git/**` and
`src/server/**` for other direct `log`/`show` spawns). Add a GitUtils test that
signs commits with a throwaway SSH key (`ssh-keygen -t ed25519 -N ""`), sets
`log.showSignature=true`, and asserts `getRecentCommits`, `getCommitInfo`,
`getCommitByHash` and `getCommitDiff` return clean output. If `ssh-keygen` is
unavailable on the test host, skip that test.
