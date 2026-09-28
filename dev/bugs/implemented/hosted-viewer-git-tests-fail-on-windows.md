# HostedWorkspaceViewerService git tests fail on a Windows dev machine

- **Found:** 2026-09-28 by the maxSteps orchestrator review pass (`npm test`)
- **Area:** `src/server/HostedWorkspaceViewerService.ts`, `src/test/unit/HostedWorkspaceViewerService.test.ts`
- **Resolution:** fixed in 540ffa9a (explicit `set-head` fixture, status paths) and f17ce637 (config-independent staged-path check)

## Symptom

Two cases fail deterministically, and they fail the same way at `8874eec8`, before the maxSteps work:

- `getStatus` › `preserves unusual and renamed paths for reading and staging`: the result
  contains the C-quoted `"caf\303\251.txt"` instead of `café.txt`, and `old name.txt` is
  missing, although the status call uses `--porcelain=v1 -z`.
- `getCommitLog` › `does not duplicate a remote-branch pill for the origin/HEAD alias`: the
  fixture's `git remote set-head origin -a` fails with `Cannot determine remote HEAD`.

## Steps to Reproduce

1. `MOCHA_GREP="preserves unusual and renamed paths|origin/HEAD alias" npm run test:extension`

## Root Cause

Not yet investigated. These look sensitive to the machine's git version or configuration:
`core.quotepath` affecting a non-`-z` code path that feeds the result, and `set-head -a`
needing a reachable remote HEAD in the fixture.

## Suggested Fix

Pass `-c core.quotepath=false` (or use `-z`) on every path-listing git call. In the fixture,
set the remote HEAD explicitly (`git remote set-head origin <branch>`) instead of `-a`.
