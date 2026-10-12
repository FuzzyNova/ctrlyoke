# Per-hook env file is deleted before inject-mode and late hooks run

- **Found:** 2026-10-12 by Claude (bug-drain review of ~33d934f87)
- **Area:** `src/core/harness/shared/CliExecutionRunner.ts`, `src/core/harness/shared/CliExecutionSession.ts`
- **Severity:** high

## Symptom

Hooks that set `env` lose their environment, or fail outright, in two situations:

1. **Inject mode.** A step whose hooks are identical to the previous step's skips `plan()` and
   reuses the running TUI (`CliIntegration.ts`, `getInjectIncompatibilityReason` "hooks changed").
   That TUI's hook config still points at the first step's env file, which was deleted when that
   step finished. From the second step on, every env-bearing hook exits 1 with
   `ctrlyoke-hook-run: ENOENT` and the user's command never runs. In OpenCode the plugin's
   `_getUserHookEnv` silently runs the hook without its env instead.
2. **Stop hooks.** A user `stop` hook runs alongside ctrlyoke's own Stop hook. ctrlyoke's
   notification ends the step, which deletes the env file. The user hook can lose that race and
   find the file gone.

## Steps to Reproduce

1. Workflow with two `claude-cli` steps in interactive (inject) mode, both with the same
   `stop` hook that sets `env: { FOO: bar }`.
2. Run it. The first step's hook sees `FOO`; the second step's hook fails with ENOENT.

## Root Cause

~33d934f87 registers the env file path on the execution session and deletes it in the runner's
`finally` block as soon as the turn completes (`src/core/harness/shared/CliExecutionRunner.ts`,
search for the cleanup of the session's user-hook env path). The file's lifetime is the turn, but
the hook config that references it lives as long as the PTY / inject context. The original bug doc
(`dev/bugs/implemented/hook-env-leaks-into-harness-process.md`) asked for the file to be deleted
"with the step's other hook files", which go through the deferred `cleanupPreviousPromptHooks`
cleanup. No test covers inject mode or the plan → session wiring; the existing cleanup test adds
the path by hand.

## Suggested Fix

Tie the env file's lifetime to the hook config that references it: delete it through the same
deferred cleanup that removes the step's other hook files (when the next step installs new hooks,
or when the PTY/inject context is disposed), not at the end of the turn. Add tests for: a reused
inject context keeping the file, a Stop notification not deleting it before the hook can run,
and disposal deleting it.
