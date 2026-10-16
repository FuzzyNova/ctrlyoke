# Hosted dashboard commit-message generation stores its run under the repo root, not the ctrlyoke workspace

- **Found:** 2026-10-15 by bug-hunt final step (claude-cli)
- **Area:** `src/server/HostedWorkspaceViewerService.ts`, `src/git/CommitMessageGenerator.ts`
- **Severity:** medium

## Symptom

When the hosted dashboard generates a commit message for a repo whose root is
not the ctrlyoke workspace root, the run uses the repo as the ctrlyoke state
root. Two cases trigger this: a workspace opened at a subfolder such as
`/repo/packages/foo`, and a secondary repo chosen via `repoId`. These then all
point at the repo instead of the workspace:

- the commit-message lineage and its `.commit-message-lineage.json` pointer
- the `.ctrlyoke/temp` capture file
- the `WorkflowInstance` root and `CTRLYOKE_WORKSPACE`

In user mode the run lands in a different project bucket; in workspace mode it
lands in `<repo>/.ctrlyoke/.runs`. The `workflowKey`/`runRef` recorded by
`commitMessageGenerationTracker` then point at a run this workspace's history
can't find.

## Steps to Reproduce

1. Open a subfolder of a git repo as the workspace (or a multi-root workspace
   with a second repo) and start the hosted dashboard.
2. Generate a commit message from the hosted Git panel.
3. The run appears under the repo root's state, not the workspace's.

## Root Cause

`HostedWorkspaceViewerService` (~2032–2038) calls
`commitGenerator.generateMessage(diffResult.diff, repoRoot, undefined, instructions)`
without the fifth `stateRoot` argument, which defaults to `cwd` (`repoRoot`).
`ScmCommitCommand` was fixed to pass `stateRoot` (see
`dev/bugs/implemented/scm-generate-commit-message-ignores-clicked-repository.md`);
the hosted caller was not.

## Suggested Fix

Pass `this.workspaceRoot` as `stateRoot`. Add a hosted-service test with a
`repoId` or subfolder workspace that asserts the generator receives the
workspace root as its state root.
