# OpenCode 2.4 headless stop and error hooks finish after the step ends

- **Found:** 2026-11-24 by the 0.10.0 pre-release `npm run test:harness` run (OpenCode 2.4.1)
- **Area:** `src/scripts/ctrlyoke-opencode-plugin.ts` (`_runUserHooks`)
- **Resolution:** fixed in this commit

## Symptom

Two headless OpenCode live cases failed on 2.4.1 and passed on 2.3.2:
"unknown model fails the step with the CLI's error" (`claimed hook "error"
did not fire`) and "completion plugin loads from an external file URL in
headless mode" (`did not dispatch the stop hook`). The hooks did run: the
recorder file gained the entry about 100 ms after the ctrlyoke CLI had
already exited.

## Steps to Reproduce

1. Headless OpenCode 2.4.1 workflow with a `stop` hook that sleeps 3 s and
   then writes a file.
2. `ctrlyoke run` exits about 70 ms after the hook starts. The write lands
   3 s later.
3. `opencode run --standalone` alone, with only the plugin loaded, shows the
   same: it exits about 30 ms after the hook starts.

## Root Cause

OpenCode 2.4's `opencode run` exits as soon as the session goes idle or
errors, and it doesn't await plugin event handlers. The plugin awaited the
user hook from the `session.status idle` and `session.error` handlers, so
OpenCode exited mid-await. The detached hook process outlived it, and the
step and the next step or the end of the run started before the hook
finished.

## Fix

Run `stop` and `error` user hooks with `spawnSync` (`BLOCKING_USER_HOOK_EVENTS`).
Blocking the plugin host keeps OpenCode alive until the hook returns, the way
other harnesses wait for native Stop hooks. Tool hooks are OpenCode trigger
hooks that it awaits itself, so they stay async.
