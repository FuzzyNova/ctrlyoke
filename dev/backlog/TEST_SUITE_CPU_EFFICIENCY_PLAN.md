# Test Suite CPU Efficiency Plan

**Status:** Partial. Below-normal priority (d7cb672bf), Vitest `isolate: false`
(783fb03ed) and the per-operation `WorktreeManager` location memo (261431b48)
have landed. Sections 2 and 3 and the remaining items in sections 1 and 4 are
still open.

> **2026-10-10 audit:** Checked against the code. Commit hashes added for the
> landed pieces. `uiWorkers` is still `cpus - extensionShards - 2` (16 on 24
> threads), and `WorkflowPropertiesPanelUndoRedo.test.tsx` is still a single
> file. No cross-run registry exists in `scripts/run-test-suites.mjs`. Vitest is
> now 5 (9b4148010), so the section 1 note about `environment` reporting needs
> re-checking. The `HostedWorkspaceViewerService` flakes listed in section 3 were
> traced to a Windows git fixture problem and fixed in 540ffa9a2/f17ce6373 (see
> `dev/bugs/implemented/hosted-viewer-git-tests-fail-on-windows.md`).

`npm test` is used from several worktrees at once, often by concurrent
ctrlyoke workflows. One run already oversubscribes the machine on purpose (see
`planParallelism` in `scripts/run-test-suites.mjs`), and two runs double that.
Nothing crashes, but everything slows down, and tests with wall-clock budgets
flake. This plan tracks what remains after the first two fixes landed:

- **Done:** the orchestrator drops itself to below-normal CPU priority
  (`lowerOwnPriority`), and every child inherits it. Interactive work now wins
  over tests, but two concurrent test runs are still equal peers.
- **Tried and dropped:** having `WorktreeManager.test.ts` copy one template
  repository with `fs.cp` instead of running `git init`/config/add/commit for
  every case. On an idle machine, back-to-back runs measured 110s (old) against
  111s (template). Copying a `.git` tree on Windows costs about as much as the
  five spawns it replaces. The real cost is in production code; see section 4.

## Baseline (24-thread Ryzen 9 5900X, 2026-09-26)

- `planParallelism(24)` gives 6 extension shards plus 16 Vitest workers plus
  the packaging suite. Each shard is a whole VS Code process tree.
- Recent solo runs: extension 3m27s–4m09s, ui 3m34s–3m46s. One run on
  2026-09-25 took 24m05s for the extension suite with 6 failures. Its cause was
  never investigated.
- The extension suite's wall time is one file. Five shards finish in about 2m.
  The sixth runs only `WorktreeManager.test.ts` (60 tests) for about 4m. It
  takes about 2m in isolation, so load roughly doubles it.

## 1. Cut Vitest's jsdom environment cost

**Done: `isolate: false`.** Each worker now reuses one jsdom window across
the files it runs. `test/fileIsolation.ts`, called first from `test/setup.ts`,
restores per-file isolation for what actually leaked. The rules for test
authors are in `webview-react.instructions.md`.

Measured with the UI suite alone at 16 workers, three alternating pairs on an
idle machine. CPU is machine-wide busy time from `os.cpus()` deltas across the
run.

| Mode          | Workers | Wall     | CPU          |
| ------------- | ------- | -------- | ------------ |
| isolate (old) | 16      | 119–121s | 1,448–1,496s |
| shared (new)  | 16      | 90–91s   | 497–512s     |
| shared        | 8       | 93s      | 522s         |
| shared        | 4       | 113s     | 528s         |
| isolate (old) | 8       | 109s     | 1,119s       |

The suite uses about **66% less CPU** and about **25% less wall time**. The
CPU saving is what matters when several `npm test` runs share the machine.
Inside a full `npm test` on 2026-09-26, the ui suite took 2m52s, compared with
the 3m34s–3m46s baseline. Its setup fell from 203s to 33s. This is one run, so
treat the figures as indicative.

Findings worth keeping:

- **Ignore the `environment` figure in shared mode.** (Measured on Vitest 4.
  The repo has since moved to Vitest 5, so re-check this before relying on it.)
  Vitest 4's
  `runBaseTests` re-reports the worker's one-time environment setup time for
  every file, so it stays around 420s even though jsdom is now built once per
  worker. The real change shows in `setup` (73s → 7s), `import` (120s → 65s)
  and total CPU.
- **Wall time is now set by one file, not by parallelism.**
  `WorkflowPropertiesPanelUndoRedo.test.tsx` runs 86 synchronous full-panel
  tests at about 1s each, which takes 83–86s even on an idle machine and in
  either mode. That is why 8 and 16 workers finish together. Splitting it into
  3–4 files is the next cheap wall-time win. Its three top-level `describe`
  blocks (panel round-trips, through-the-extension, sequences) are the obvious
  places to split. Not done as of 2026-10-10.
- **Re-tune `uiWorkers`.** 8 workers match 16 on both wall time and CPU, and
  would leave more cores to the extension shards that run beside it.
  `planParallelism` in `scripts/run-test-suites.mjs` still gives the suite 16.
  This has not been changed yet; measure it under a full `npm test` before
  changing it.
- happy-dom (the old option 2) is no longer needed. What remains of the suite's
  CPU is mostly the tests themselves.

The leaks that `fileIsolation.ts` guards against, each of which failed real
tests during the migration (439 failures on the first run, then 0 across 9
parallel runs and a deterministic single-worker pass over all 250 files):

- Testing Library's auto-cleanup reaches only the first file in a worker.
- A `vi.mock` has no effect on a module that an earlier file already imported
  (fixed by calling `vi.resetModules()` per file).
- `window.__ctrlyokeStandalone` is set at file level and never unset.
- Profiler state is kept in `localStorage`, and its rAF loop keeps running.
- `HTMLElement.prototype.offsetWidth/offsetHeight` stubs are never restored.
- `vi.stubGlobal` makes `requestAnimationFrame` synchronous for every later
  file.
- Mermaid appends its render container directly to `body`.

Removing listeners and timers registered by `node_modules` code broke later
files: React DOM registers its document listeners only once per document, so
the guard records only registrations whose caller is repo source.

## 2. Coordinate concurrent `npm test` runs across worktrees

`planParallelism(availableParallelism())` is static and does not know about
other runs. Do not sample CPU load for this: `os.loadavg()` is always
`[0,0,0]` on Windows, and a reading taken at startup misses a sibling run that
ramps up a few seconds later.

Instead, register each run in a machine-wide directory, for example
`<os.tmpdir()>/ctrlyoke-test-runs/<pid>.json` holding
`{ pid, startedAt, worktree }`. On startup, prune entries whose PID is dead and
count the live ones, then either:

- **Share:** `planParallelism(cpus / activeRuns)`, so two concurrent runs each
  get half the machine; or
- **Queue:** wait until the other run finishes, then take the whole machine.
  Total CPU work is about the same, and neither run is slowed into timeout
  flakes. Print a "waiting for npm test in <worktree>" ticker.

Queue is probably the better default, with a flag to opt out. Two runs at half
speed finish no sooner than two runs back to back, and running them together is
exactly what causes the flakes. This must fail open: an unreadable registry
means run at full budget, never block.

## 3. Reduce timing dependence in the remaining flakes

Failures seen in recent `.ctrlyoke/logs/test-runs/` logs:
`HostedWorkspaceViewerService` (twice; probably the Windows git fixture bug
fixed 2026-09-28 in 540ffa9a2/f17ce6373, so watch for a recurrence before
chasing it), `CliInteractiveStartupCoordinator >
should recover via delayed log discovery…`, `ExecutionRootCoordinationStore >
assigns gapless sequences across separate node processes`,
`HarnessCapabilityRegistry` (3 cases in one run), `WorkflowVariantService`, and
`Parallel mutation integration > lets a group orchestrator mutate flat future
work and join without stale indices` ("Definition revision conflict: expected
4, found 3" under a full run on 2026-09-26; it passed in isolation).
For each one, follow the flaky-test procedure in `test.instructions.md`. Where
the cause is a fixed sleep or a real timer racing work, use a poll-until-
condition helper or fake timers instead of raising a bound.

## 4. `WorktreeManager` asked git where the repository is several times per operation

A `GIT_TRACE2_EVENT` capture of the `WorktreeManager` suite counted 3,236 git
processes for 60 tests. The per-case repository fixture accounted for only
about 12% of git time, and replacing it did not help (see above). Production
code is most of it:

| Calls | Command                        |
| ----- | ------------------------------ |
| 600   | `rev-parse --git-common-dir`   |
| 396   | `rev-parse --show-toplevel`    |
| 354   | `worktree list`                |
| 201   | `status`                       |
| 190   | `rev-parse --verify …`         |
| 169   | `rev-parse --absolute-git-dir` |

**Done (toplevel and common dir):** each public `WorktreeManager` operation
now resolves a `RepositoryContext` once and passes its per-operation
`GitLocationMemo` to the lease and runtime-trust calls it makes.
`ensureManagedWorktree` went from 10 location lookups to 5. Across the suite,
`--show-toplevel` fell from 394 to 231 calls and `--git-common-dir` from 593
to 254, about 500 fewer spawns out of 2,589 routed through `execGit`. In three
alternating idle A/B pairs the suite took 133/123/115s before and
111/112/103s after, averaging 124s → 109s.

What remains, if this file is still the critical path:

- `--absolute-git-dir` (169) is deliberately not memoized. A worktree removed
  and re-added at the same path can get a different administrative directory
  within one operation, and lease identity depends on it.
- `worktree list` (435) and `rev-parse --verify` (401) are now the largest
  rows. Many `worktree list` calls re-read state straight after a mutation, so
  they need a case-by-case look rather than a memo.

To measure, wrap `execGit` in `src/utils/GitUtils.ts` to append
`{ args, stack }` per call to a file, and aggregate by the first frame outside
`GitUtils`. That attributes each spawn to a call site, which
`GIT_TRACE2_EVENT` cannot do.
