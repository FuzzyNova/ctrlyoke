# Codex workspace-write cannot stage changes in checkouts

- **Found:** 2026-11-03 by Phase 0 Codex sandbox probe
- **Area:** `src/core/harness/codex/CodexCliProvider.ts`
- **Severity:** medium

## Symptom

Codex `exec -s workspace-write` can create files in its workspace but cannot run
`git add` in a plain checkout or a linked worktree. Git reports `Operation not
permitted` while creating its index lock.

## Steps to Reproduce

1. In a throwaway plain checkout, run `codex exec -s workspace-write` and ask it
   to create a file, stage it, and commit it.
2. Repeat in a linked worktree created with `git worktree add`.
3. File creation succeeds, but `git add` fails on `.git/index.lock` in the plain
   checkout and `.git/worktrees/<name>/index.lock` in the linked worktree.

## Root Cause

Codex's workspace-write sandbox protects `.git` even when the checkout is a
writable root. A linked worktree keeps its git common directory in the primary
checkout, outside the worktree execution root. The phase 3 sandbox mapper currently
does not add that common directory as a writable root.

## Suggested Fix

Phase 3 should add `ExecutionRootScope.gitCommonDir` to Codex writable roots when
workspace-write containment is enabled, then verify staging and commit in both
plain and linked worktrees.

## Resolution

The Codex sandbox mapper adds Git's common directory as a writable root for
`workspace-write`, allowing Git to create its index lock in plain checkouts and
managed linked worktrees.
