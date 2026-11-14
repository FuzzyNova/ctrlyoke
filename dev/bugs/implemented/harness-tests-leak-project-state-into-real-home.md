# Harness tests leave project state in the developer's real `~/.ctrlyoke/projects`

- **Found:** 2026-11-13 by the bug-hunt workflow final step (claude-cli)
- **Area:** `src/test/harness/` (`commit-permissions.harness.test.ts`, `inline-config.harness.test.ts`, `conditions.harness.test.ts`, workflow and MCP harness suites), `src/test/harness/helpers/harnessRunner.ts` (`isolateRunState`)
- **Resolution:** fixed in this commit

## Symptom

After `npm run test:harness`, the developer's real state home holds a project
directory for every temp workspace a harness case used. On the machine this was
found on, `~/.ctrlyoke/projects` had 135 `ctrlyoke-inline-harness-*`, 53
`ctrlyoke-commit-permissions-*`, 15 `cy-conditions-test-*`, 6
`cy-workflow-test-*`, 5 `cy-mcp-test-*` and several `repo-*` entries whose
`statePath` is a deleted `$TMPDIR/ctrlyoke-…` directory, each with its run
history. They show up in `ctrlyoke history prune` and slow the first-lookup
scan in `ProjectStateRegistry.findProjectHistory`, which reads every project
key when a project has not been scanned yet.

`npm test` itself is clean: each extension-test shard gets its own
`CTRLYOKE_HOME`.

## Root Cause

Isolation is opt-in per case: `isolateRunState(tmpDir)` is called by some
suites and only by some cases in others (`inline-config.harness.test.ts` uses
it in one helper, while its `ctrlyoke-inline-harness-*` cases leak;
`commit-permissions.harness.test.ts` and `conditions.harness.test.ts` never
call it; `commit-generation.harness.test.ts` calls it but its `repo-*`
workspaces still leaked). Cases without it run
ctrlyoke (in-process or as a CLI subprocess) with the developer's environment,
so user-mode run storage resolves under the real `~/.ctrlyoke/projects`. The
`test:harness` script (`package.json`) sets no `CTRLYOKE_HOME`.

## Suggested Fix

Isolate state for the whole harness run in one place: in the module the
`test:harness` script already `--require`s
(`src/test/harness/helpers/harnessVersionReport.ts`) or a new mocha root
hook, set `process.env.CTRLYOKE_HOME` to a fresh temp directory when it is not
already set, and remove it after the run. Subprocesses inherit it.
`isolateRunState` keeps working per case on top of it. Do not run the harness
suite to verify (it is paid and slow); a unit-level check that the required
module sets `CTRLYOKE_HOME` is enough.
