# Hosted checkout-branch passes client branch name to git as an option

- **Found:** 2026-09-29 by bug-hunt final step (claude-cli)
- **Area:** `src/server/HostedWorkspaceViewerService.ts` (`checkoutBranch`), `src/server/CtrlYokeHostedServer.ts` (`POST /api/workspace-viewer/checkout-branch`)
- **Resolution:** fixed in this commit

## Symptom

`POST /api/workspace-viewer/checkout-branch` with body `{"branch":"--pathspec-from-file=C:/Users/<u>/.ssh/id_rsa"}` runs `git -C <repo> checkout --pathspec-from-file=…`. Git reads the out-of-workspace file and emits `error: pathspec '<line>' did not match …` for every line; the route returns git's stderr in the 500 JSON, disclosing the file contents. The same input can pass `-f` (discarding all local changes), `--orphan=…`, etc.

## Steps to Reproduce

1. Start the hosted server; obtain the token.
2. POST the body above to `/api/workspace-viewer/checkout-branch?token=<t>`.
3. Response error message contains every line of the target file.

## Root Cause

`checkoutBranch` only checks the branch is non-empty and passes it straight to `git checkout`. No leading-`-` rejection and no verification that it names a local branch. Other ref-taking helpers in the same service are protected (`--end-of-options`, `resolveBranchHint`'s `show-ref --verify refs/heads/<name>`, `checkoutCommit`'s `cat-file -e` pre-check).

## Suggested Fix

Verify the name is an existing local branch (`git show-ref --verify --quiet refs/heads/<name>`, reusing the existing helper) before checkout, and reject names starting with `-`. Consider returning a generic error rather than raw git stderr from the route.
