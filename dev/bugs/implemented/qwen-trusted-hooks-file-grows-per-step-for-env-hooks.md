# Qwen trusted-hooks file grows by one permanent entry per step for user hooks that have env vars

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/core/harness/shared/QwenTrustedHooksTracker.ts`
- **Severity:** low

## Symptom

Every Qwen step adds a new trust key to the workspace's array in `~/.qwen/trusted_hooks.json` for each user hook in the workflow that defines `env`. A later run can never reuse these keys. Each key looks like:

```
:node "<ext>/out/scripts/ctrlyoke-hook-run.js" "<state>/temp/hook-environments/user-hook-env-<N>-<uuid>.json" hook-<i> ...
```

Nothing removes these keys. The file grows without bound, and it keeps trust for commands that point at temp env files that have already been deleted.

## Steps to Reproduce

1. Create a workflow that uses harness `qwen-cli` and defines a user hook with a non-empty `env` map, for example `hooks: [{ event: ..., command: "echo hi", env: { FOO: "bar" } }]`.
2. Run the workflow, or a multi-step workflow, several times.
3. Open `~/.qwen/trusted_hooks.json` and look at the array under the workspace root key.
4. Each step adds one new `:node ...ctrlyoke-hook-run.js "...user-hook-env-<promptIndex>-<uuid>.json" hook-0 ...` entry for each env-bearing hook. Earlier entries stay in the array, and their env files no longer exist.

## Root Cause

- `src/core/harness/shared/UserHookEnvironment.ts:46` builds the env file name for each step with `crypto.randomUUID()`. Lines 69-109 put that path into the launcher `command` that replaces each env-bearing hook's command.
- `src/core/harness/shared/ExecutionPlanBuilder.ts:175-182` swaps these wrapped hooks into `userHooks` before passing them to the Qwen provider.
- `src/core/harness/qwen/QwenCliProvider.ts:679-684` builds trust keys from the wrapped command (`` `:${uh.command}` ``) and passes them as `additionalKeys`.
- `src/core/harness/shared/QwenTrustedHooksTracker.ts:90-95` appends any key that is not already in the array and never removes one (see the class doc at lines 15-29). `unregisterWorkflow` (lines 116-127) only updates in-memory state.

The never-remove policy assumes command strings stay the same, so later runs reuse the keys already approved. The per-step UUID in the path breaks that assumption.

## Suggested Fix

Make the trust key for env-wrapped hooks the same on every step.

- **Option 1:** Give the hook-environment file a fixed name for each workspace and workflow. Put the hook ID in the name and leave out the random UUID, so the launcher command is the same on every run.
- **Option 2:** Have the launcher locate its env file some other way, such as an env var or a fixed per-workflow path. The command string then contains nothing that changes per step.

If the path has to stay per-step, the tracker should own the user-hook keys that contain a `user-hook-env-` launcher path and remove them in `unregisterWorkflow`. Another option is to prune keys whose env file no longer exists.

Add a unit test that registers two steps with an env-bearing hook and checks that the workspace entry does not grow.

## Decision

Qwen env-hook launchers use the stable run artifact stem in their environment-file
path. This keeps the command trust key identical across steps while isolating
concurrent workflow runs. Other harnesses keep their per-step UUID filenames.

**Resolution:** fixed in this commit

## Follow-up (review)

Review found that a run-wide env filename lets concurrent steps overwrite the
same `hook-<index>` values and lets one step's cleanup unlink another step's
file. Qwen now includes the prompt index in the stable run stem: each step has
an isolated env file, and reruns of that step keep the same trusted command.
Other harnesses continue using their per-invocation UUID filenames.
