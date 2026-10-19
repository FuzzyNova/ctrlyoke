# runner.json discovery poll stats every lineage once a second

- **Found:** 2026-10-19 by Claude Code (performance investigation, extension-host CPU profile)
- **Area:** `src/core/orchestration/ExternalRunWatchCoordinator.ts`
- **Severity:** medium

## Symptom

With a large history (1,508 lineages under `~/.ctrlyoke/projects/ctrlyoke-81d730fe53ae/.runs`)
the extension host never goes idle. A 45 s startup CPU profile charged ~1 s of main-thread
time to `pollRunnerJsonDiscovery`, nearly all of it in `WorkflowPaths.runnerLockPath` →
`runsRoot` → `ctrlyokeStateHome` path recomputation. Each pass also queues 1,508
`fs.promises.stat` calls on libuv's 4-thread pool, where they compete with the file reads
that run views, history, and settings need. The cost grows linearly with history size and is
paid every second, even with no run in progress.

## Steps to Reproduce

1. Open a workspace with a large run history (1,000+ lineages) in a dev host with
   `CTRLYOKE_DEV_HOST_INSPECT_PORT=9333` set (see `scripts/dev-host.mjs`).
2. Take a CPU profile of the extension host over CDP for 30–60 s.
3. `pollRunnerJsonDiscovery` appears as a root every second, with `runnerLockPath` the
   largest child.

## Root Cause

`setupRunnerJsonCreateWatcher` (`ExternalRunWatchCoordinator.ts:304`) installs a 1 s
`setInterval` (line 322) on top of the `*/runner.json` file watcher. Each tick
(`pollRunnerJsonDiscovery`, line 327) `readdir`s the runs root, then for every lineage
directory not already watched recomputes the lock path from scratch and `stat`s it under
`Promise.all`. It has no re-entrancy guard, so a slow pass (cold disk, OneDrive-synced home)
overlaps the next.

## Suggested Fix

- Build the lineage → `runner.json` path once from the `runsRootDir` that was already
  resolved (`path.join(runsRootDir, name, "runner.json")`) instead of re-deriving the state
  home per entry.
- Skip a tick while the previous pass is still running.
- Poll only what the watcher can miss: lineages whose directories changed since the last pass
  (cheap with `readdir` plus a directory-mtime check), or back off when nothing has changed for
  a while. The watcher plus a slower fallback (e.g. 10 s) would cover the cases the 1 s poll
  was added for.
- Bound concurrency for the `stat` fan-out so it can't monopolize the thread pool.
