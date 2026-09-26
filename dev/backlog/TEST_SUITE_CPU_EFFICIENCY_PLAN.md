# Test Suite CPU Efficiency Plan

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

## 1. Cut Vitest's jsdom environment cost (try first)

Vitest's own breakdown from a full `npm test`:

```
Duration 223s (transform 67s, setup 203s, import 187s, tests 476s, environment 1263s)
```

Building environments costs about 2.6× the CPU time of running the tests. With
the default `isolate: true`, each of the 250 files gets a fresh jsdom. This is
the largest CPU consumer in the whole run, and it is almost as slow as the
extension suite.

Options, in order:

1. **`isolate: false`** in `src/ui/webview-react/vitest.config.ts`. Each
   worker then reuses one environment and module graph across files. The risk
   is state leaking between files: Zustand stores, module-level singletons,
   `vi.mock` hoisting, globals set in `test/setup.ts`, and DOM left behind.
   Measure the change and fix the files that start failing, most likely by
   giving `setup.ts` a real `afterEach` reset for the stores. If only a few
   files resist, isolate just those with Vitest `projects`, rather than giving
   up on the whole suite.
2. **happy-dom** instead of jsdom. Its environment is much cheaper, but it
   implements the DOM less faithfully. Try this only if `isolate: false` is not
   enough.
3. **Re-tune `uiWorkers`** after either change. Fewer, cheaper workers may beat 16.

Success means `environment` falls well below `tests` in the Duration line, and
the ui suite's wall time falls without new flakes across several runs.

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
`HostedWorkspaceViewerService` (twice), `CliInteractiveStartupCoordinator >
should recover via delayed log discovery…`, `ExecutionRootCoordinationStore >
assigns gapless sequences across separate node processes`,
`HarnessCapabilityRegistry` (3 cases in one run), and `WorkflowVariantService`.
For each one, follow the flaky-test procedure in `test.instructions.md`. Where
the cause is a fixed sleep or a real timer racing work, use a poll-until-
condition helper or fake timers instead of raising a bound.

## 4. `WorktreeManager` asks git where the repository is ~20 times per operation

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

The first two rows plus `--absolute-git-dir` are about 1,165 spawns that
answer questions whose answers do not change during one operation. Resolving
them once per public `WorktreeManager` operation, as a per-call context object
rather than a long-lived cache that could go stale, would shorten the
extension suite's critical path. It would also speed up the product itself,
because each spawn costs 20–50ms on Windows. To measure, run the suite with
`GIT_TRACE2_EVENT=<dir>` and count `start` events by argv.
