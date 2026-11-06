# A workflow's own trustedExternalRoots never reach the harness in a real run

- **Found:** 2026-11-05 by Claude Code, while granting OpenCode trusted roots through `external_directory`
- **Area:** `src/core/harness/shared/CliProviderUtils.ts`, `src/core/HarnessIntegration.ts`
- **Resolution:** fixed in this commit

## Symptom

A workflow that lists `trustedExternalRoots` and has them approved
(`ctrlyoke trust-workflow-external-roots <file>` or the approval prompt) runs,
but the harness never receives those roots: no `--add-dir` for Claude, Codex,
Copilot or Antigravity, and no `external_directory` grant for OpenCode. A dry
run (`ctrlyoke run <file> --dry-run`) does show them, so the preview and the
real launch disagree. Roots from the user's or the workspace's
`permissions.trustedExternalRoots` are not affected.

## Steps to Reproduce

1. In a workspace, write a workflow with `trustedExternalRoots: [<dir outside the workspace>]`
   and `harness: claude-cli`.
2. `ctrlyoke trust-workflow-external-roots <file> --yes`.
3. `ctrlyoke run <file> --dry-run --json` lists `--add-dir <dir>`.
4. `ctrlyoke run <file> --headless`: the spawned command has no `--add-dir <dir>`
   (for `opencode-cli`, `OPENCODE_CONFIG_CONTENT` has no `external_directory`).

## Root Cause

Approval records are keyed by the workflow's identity,
`ExternalRootsTrustStore.canonicalizeWorkflowIdentity(workspaceRoot, <authored file>)`.
At execution time both `HarnessIntegration.getApprovedExternalRoots()` and
`CliProviderUtils.getWorkspaceDirs()` rebuild that identity through
`CliProviderUtils.getWorkflowExternalRootsContext()` from
`workflowContext.filePath`. `WorkflowExecutor` sets that to
`context.currentPromptFilePath`, which in a real run is the run's working copy
(`<stateHome>/projects/<slug>/.runs/<lineage>/run-<ts>/workflow.ctrlyoke.json`),
not the authored file. The identity therefore has no approvals, and
`getEffectiveApprovedExternalFileRoots()` returns only the user and workspace
roots. The dry run resolves from the authored path, so it matches.

## Suggested Fix

Resolve workflow-root approval from the authored definition path everywhere
execution needs it, for example by carrying the source path (as approved, before
any worktree mapping) on `WorkflowContext` and using it in
`getWorkflowExternalRootsContext()`, or by resolving the run's approved roots
once at run start (where the approval gate already checks the authored path)
into `executionWorkspace.approvedExternalRoots` and having
`getWorkspaceDirs()` use that list instead of recomputing. Add a harness test
that approves a workflow's own root and checks a real run reads under it
(`src/test/harness/inline-config.harness.test.ts` has the OpenCode version using
workspace roots).
