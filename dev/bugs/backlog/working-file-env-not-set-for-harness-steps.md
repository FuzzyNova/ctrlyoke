# `CTRLYOKE_WORKING_FILE` is never set for harness or script processes, so `history search --this-workflow` can't work inside a step

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/core/harness/shared/CliExecutionRunner.ts`, `docs/cli/ctrlyoke.md`
- **Severity:** medium

## Symptom

`docs/cli/ctrlyoke.md` says `CTRLYOKE_WORKING_FILE` is "Set by ctrlyoke for harness processes;
names the run a step belongs to. Used by `history search --this-workflow`" (around line 519), and
describes `--this-workflow` as using the variable "set inside a running step" (around line 434).
In fact the variable is only put into the env of the ctrlyoke **MCP server** entry
(`CliMcpConfigGenerator.ts` around line 357, `OpenCodeInlineConfig.ts` around line 243). An agent
running `ctrlyoke history search --this-workflow …` from its shell (or a script step running it)
gets `Error: --this-workflow requires CTRLYOKE_WORKING_FILE to be set.` and exit 2. No code path
sets it for the harness process, so the flag can never work as documented.

## Steps to Reproduce

1. `grep -rn CTRLYOKE_WORKING_FILE src` (excluding tests): only the MCP config generators, the MCP
   server itself, and the reader in `src/cli/HistoryInspectionCommands.ts` (around line 302).
2. `CliExecutionRunner.buildHarnessProcessEnv` / `buildHookEnvVars` (around lines 515-587) set
   `CTRLYOKE_RUN_ID`, `CTRLYOKE_WORKFLOW_ID`, `CTRLYOKE_PROMPT_INDEX`, `CTRLYOKE_WORKSPACE_ROOT` and
   similar, but not `CTRLYOKE_WORKING_FILE`.
3. Run `ctrlyoke history search foo --this-workflow` without the variable: exit 2 with the error
   above.

## Suggested Fix

Set `CTRLYOKE_WORKING_FILE` (the run's `workflow.ctrlyoke.json` path, in the same form the MCP
config generator uses) in the harness process env built by `CliExecutionRunner`, and in the env
of script steps / end-condition / pre-condition scripts if they don't inherit it. Single-source
the variable name as a constant shared with the MCP config generator, the MCP server and
`HistoryInspectionCommands`. If setting it for a process type is deliberately avoided, say so in
the docs instead.

Regression tests: the harness env builder includes `CTRLYOKE_WORKING_FILE` when a working file is
known; a script step's env includes it.

## Related doc inaccuracies on the same page (fix together)

- `commit` (around lines 260-264): when nothing is staged the CLI prints the generated message and
  then exits 2 without committing unless `--all` is given (`src/cli.ts` around lines 2615-2621);
  the synopsis (around line 12) omits `--all`.
- `continue` (around lines 189-190) refuses while **any** run in the same lineage is executing, or
  while the target run is pausing/cancelling (`RunContinuationService.ts` around lines 207-244),
  not only when another process is executing that run.
- `docs/cli/index.md` (around line 58): the history-search index is kept per index **schema**
  version (`HistorySearchIndexLayout.ts`), not per ctrlyoke version.
