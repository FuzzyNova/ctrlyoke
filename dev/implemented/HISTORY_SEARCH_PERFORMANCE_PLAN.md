# History Search Performance & Isolation Plan

**Status:** Phase 2 complete (2026-08-27)
**Priority:** P1 (raised from P2 2026-08-27 — a second confirmed OOM crash,
not just heap pressure, occurred mid-`HistorySearchIndexService` rebuild;
see "2026-08-27 Incident #2" below)

## Background

`HistorySearchIndexService` has OOM'd the extension host before (see
`.github/instructions/orchestration.instructions.md`). A 2026-08-27 incident
investigation confirmed a concrete instance of this: a workspace with 1250+
runs / 642k documents saw the extension-host process crash on a V8
`CALL_AND_RETRY_LAST` heap OOM (`extensionHost` process type, confirmed via
Crashpad dump) while a search-triggered index rebuild was contending with a
live workflow's background refresh for the on-disk index lock.

That investigation already shipped three fixes (see git history around
2026-08-27):

- `FileLockUtils.withFileLock` gained an optional `{ timeoutMs }`, and
  `HistorySearchIndexService.rebuild()` now passes a 60s
  `REBUILD_LOCK_TIMEOUT_MS` instead of the library default 5s — a full
  rebuild routinely takes ~20s on a large history, so the 5s default made any
  overlap between two rebuilds time out the loser and, on the search path,
  fall through to `HistorySearchService`'s unindexed, unbounded disk scan.
- `HistorySearchService`'s disk-scan fallback now caps candidate text at
  `MAX_INDEXED_TEXT_LENGTH` (exported from `HistorySearchIndexService`),
  matching the indexed path. It previously built full, uncapped documents —
  reproducing the exact heap-growth pattern that cap exists to avoid — and it
  runs precisely when the system is already under memory pressure.
- `src/utils/MemoryDiagnostics.ts#logMemoryUsage()` now logs
  `process.memoryUsage()` around `rebuild()` start/end and the disk-scan
  fallback, so a recurrence is diagnosable from the log instead of requiring
  another crash-dump investigation.

Those fixes remove the immediate crash trigger. Two structural inefficiencies
remain, both called out during that investigation and explicitly requested
here as backlog work, plus a heavier isolation option to evaluate afterward.

## 2026-08-27 follow-up: log review + a new confirmed case

A later session on the same workspace (1255 runs / ~642k documents) hit a
search while a workflow was completing. Reviewing
`.ctrlyoke/logs/ctrlyoke-1787850072039.log` for that session answers two
questions: are the shipped fixes holding, and does this plan already cover
what was observed.

**Are the fixes working?** Yes, for the specific crash trigger. No rebuild in
this log fell through to `HistorySearchService`'s disk-scan fallback — every
pass went through the indexed, capped path, so the 60s lock timeout is doing
its job (nothing timed out waiting for the lock). But heap pressure is still
real, just not crash-triggering this time: `[MemoryDiagnostics]` shows
`heapUsed` climbing 1817MB → 2421.7MB and `rss` 2682.7MB → 3155.2MB across
three back-to-back rebuild passes in under a minute, without full reclaim
between passes. That's the same qualitative shape ("a single large
allocation on an already-large heap") flagged as the OOM precursor in the
original crash forensics — it just didn't cross the line this time. This is
concrete evidence, not just a theoretical concern, that Problem 2
(worker-thread isolation) still matters even after Problems 1A/1B are fixed.

**The "rebuilt twice in a row" observation, explained:** the log actually
shows **three** rebuild passes in that window, from two different causes:

1. **Pass 1** and **Pass 2** are the _same_ `HistorySearchIndexService`
   instance — the one owned by the completing workflow's
   `OutputHistoryManager`. While pass 1's scan was running, the workflow's
   own step-completion writes fired `enqueueWorkspaceRefresh` twice more;
   both were logged as "refresh already in progress; coalescing into
   current pass" and correctly collapsed into a single requeued pass rather
   than one each (`rebuildQueued` coalescing already works as designed).
   Pass 2 then ran to capture that new data — and it was genuinely needed:
   the document count moved 642685 → 642693 between passes, confirming real
   new content, not staleness. `enqueueWorkspaceRefresh`'s do-while loop
   (`HistorySearchIndexService.ts:239-260`) always runs a full pass on
   requeue with no freshness check first, so this is also a case Phase 1A's
   recheck would touch — it just wouldn't have skipped anything _here_,
   because the recheck would correctly find real changes and rebuild
   anyway.
2. **Pass 3** (`retainDocuments=true`) is a _different_ instance — the
   search UI's own `HistorySearchIndexService` — triggered by the user's
   search 2 seconds after pass 2 finished writing a fresh index to disk.
   This one **is** exactly the case Phase 1A targets: "the instance that
   waits out someone else's rebuild reruns its own." Pass 2 had just
   written a complete, fresh index; nothing changed in the 2 seconds before
   pass 3 started. Phase 1A's freshness recheck inside the lock would have
   let pass 3 skip straight to `loadIfPossible()` instead of repeating an
   ~18s, multi-hundred-MB-heap-growth full rescan of all 1255 runs for data
   it already had.

**Answer to "would the plan's fixes fix this":** yes for the part that
actually wasted work — pass 3, the search-triggered rescan of data a sibling
instance had just finished writing — is precisely Phase 1A's target case,
now with a concrete logged reproduction. Passes 1 and 2 were not wasted work
(real data changed between them) and aren't something to "fix" so much as
further evidence for Phase 2: even fully justified, correctly-deduped
rebuilds still drive the heap in the direction that caused the original
crash, back-to-back, in under a minute.

## 2026-08-27 Incident #2: a real crash, mid-rebuild, minutes later

The same session crashed again shortly after the follow-up above, this time
for real — not just elevated heap numbers. The log
(`.ctrlyoke/logs/ctrlyoke-1787850072039.log`) goes dead at line 1626, right
after `[HistorySearchIndexService] rebuild progress: 400/1257 runs, 136052
documents so far` — no shutdown log, no error, nothing after it.

**Confirmed cause, not just circumstantial:** `%APPDATA%\Code\Crashpad\
reports\d766eea3-25d8-4c64-a51a-fa8f77ea3736.dmp` was written at
`2026-08-27 17:44:52 UTC` — 5 seconds after that last log line, with nothing
else in the log between them. Scanning the dump's strings confirms the same
signature as the original incident: `process_type: utility` (the extension
host), `electron.v8-oom.is_heap_oom: 1`, `electron.v8-oom.location:
CALL_AND_RETRY_LAST`. This **is** a `HistorySearchIndexService` rebuild
crashing the extension host — directly, not inferred.

**Was this the redundant-rebuild case Problem 1 targets? No.** The crashing
pass (`rebuild starting: runs=1257 retainDocuments=false`, L1597) was a
sibling `OutputHistoryManager`'s own first pass, triggered by that
workflow's own completion writes — the same legitimate, data-changed pattern
as "Pass 1 → Pass 2" in the incident above, just one that didn't survive to
finish. Neither Phase 1A's freshness recheck nor Phase 1B's shared instance
would have skipped or prevented _this_ pass — there was real new data to
index and only one instance involved at the moment it started.

**What's different this time: the pass started from an already-elevated
baseline.** `[MemoryDiagnostics]` at this pass's start: `rss=3088.5MB
heapUsed=1869.1MB heapTotal=2836.8MB` — compare to a fresh rebuild earlier in
the _same_ session starting from `heapTotal=2079.5MB`/`2081.4MB`. Nothing
this pass did was unusual (documents 72479 at 200 runs, 136052 at 400 runs —
matching prior successful passes almost exactly); it crashed because the
heap it was growing from was already ~750MB higher than a rebuild earlier in
this same session tolerated fine. That's the connective tissue back to
Problem 1: fewer total rebuild passes per session means less cumulative
baseline creep, which buys more headroom before an otherwise-ordinary,
necessary pass like this one tips over. Phase 1 reduces _how often_ this
setup occurs; it doesn't prevent this specific pass.

**Where the memory actually goes (checked against the current code):**
`rebuild()` (`HistorySearchIndexService.ts:355-501`) already streams
documents to disk per-run and, with `retainDocuments=false` as here, never
accumulates a retained document array — this crash is not the "unbounded
array" shape the prior fixes already addressed. It's allocation _churn_:
each of 1257 runs' manifest + full `events.jsonl` is read and parsed into
memory, processed, and discarded, run after run, in a tight loop
(`readManifestSafe`/`readEventsSafe` inside the `for (const source of
runSources)` loop) with little idle time for a full GC/compaction pass —
especially back-to-back with the other rebuild passes already logged
earlier in the same session.

**Does Phase 1 fix this crash? Not directly — Phase 2 is now the load-bearing
fix.** Phase 1 lowers the odds (less baseline creep over a session) but
doesn't bound this pass's memory use, because this pass wasn't wasted work
to begin with. Phase 2 (worker-thread isolation) is the only proposed change
that actually caps this: a `worker_threads` worker gets its own V8 isolate,
and **terminating that worker after each rebuild releases its entire heap
back to the OS** — not just the garbage in it. That's a fundamentally
stronger guarantee than anything achievable on the shared main-thread heap,
including explicit GC (see below), because it doesn't depend on what's still
reachable when the pass ends. Recommend the Phase 2 design sketch spawn a
fresh worker per rebuild (or periodically recycle a pooled one) rather than
keep one long-lived worker across a session's many rebuilds — a long-lived
worker would just relocate this same baseline-creep problem onto a second
thread instead of eliminating it.

**On explicit GC triggers (asked about, not recommended):** `global.gc()`
requires Node's `--expose-gc` flag, which would have to be set on the
extension host process — a launch flag ctrlyoke's own code doesn't control
(VS Code owns that process's startup). Even if it were available, it
wouldn't have prevented this crash: GC only reclaims objects nothing still
references, it doesn't shrink `heapTotal` back down once V8 has grown it,
and it can't run usefully mid-loop while the pass's own per-run working set
is still live. Forcing a GC _between_ rebuild passes might trim some of the
baseline creep at the margin, but Phase 2's worker-teardown already achieves
a strictly stronger version of the same idea (whole-isolate release, not
partial reclaim) as a byproduct of work already scoped. Not worth pursuing
as a separate change.

## Problem 1: An instance that waits out someone else's rebuild reruns its own

Every live workflow's `OutputHistoryManager` owns a private
`HistorySearchIndexService` instance (`OutputHistoryManager.ts:142`), and the
search UI (`CtrlYokeWebviewProvider.ts:114`) owns a separate one again.
`rebuild()`'s in-flight coalescing (`rebuildPromise`/`rebuildQueued`) only
dedupes calls _within one instance_ — it does nothing for two instances
racing the same on-disk index. They now serialize correctly through the
60s-timeout file lock instead of one of them failing outright, but the
instance that waited still performs its own full rebuild after acquiring the
lock, even though the instance that just released it wrote a fresh index
seconds ago. On a large history that's a second ~20s, full-heap-churning
rebuild pass for no reason.

### Phase 1A — freshness recheck inside the lock (do this first)

**Shipped 2026-08-27:** Added the post-lock manifest freshness recheck in
`src/core/orchestration/HistorySearchIndexService.ts`. Contending rebuilds
now skip a redundant scan when the on-disk index is still fresh, reloading
documents for retained readers; contention tests cover both the fresh and
changed-history paths.

Once `rebuild()` acquires the lock, re-run the existing `isManifestFresh()`
check against what's now on disk _before_ calling `listRunSources()` and
starting the scan. If a sibling rebuild just finished and nothing changed in
the interim (the common case — two workflows completing near-simultaneously
both want to index the same recent batch), skip straight to
`loadIfPossible()`/return instead of rescanning the whole history.

This is a small, contained change to the start of `rebuild()`'s locked
section — no ownership or lifecycle redesign, no new failure modes (worst
case it does exactly what it does today: a full rebuild). Ship it
independently of Problem 2 and Phase 1B below.

### Phase 1B — consolidate to a shared instance (done)

**Shipped 2026-08-27:** Added
`src/core/orchestration/HistorySearchIndexServiceRegistry.ts`, a module-level
registry keyed by normalized workspace path. `OutputHistoryManager` and
`HistorySearchService` now resolve their index service through that registry,
so refresh coalescing and the warm document cache are shared within a
workspace while separate workspaces remain isolated.

**Updated 2026-08-27 (post-Incident #2):** this section originally proposed
gating 1B on a few weeks of `[MemoryDiagnostics]` log data and deferring it
if 1A alone looked sufficient. That is superseded by the "Sequencing"
section below, added after Incident #2 — a real crash occurred during a
rebuild pass 1A would _not_ have skipped, so the wait-and-see plan for 1B is
dropped too. Build 1A and 1B together; do not wait for production log data
first.

The deeper fix is giving `OutputHistoryManager` (all of them) and the search
UI the same `HistorySearchIndexService` instance instead of one each. That
gets the _existing_ `rebuildPromise`/`rebuildQueued` coalescing to work
globally — not just for the "waited on the lock, recheck freshness" case
above, but for any two refreshes that would otherwise overlap at all — and
collapses what can currently be several duplicate warm document caches (the
search UI's retained copy, plus whatever a live workflow's write-only
refresh briefly builds before discarding) into the one retained copy the
original design already intended (`rebuild(..., { retainDocuments })`'s
doc comment: "the single reader keeps one warm copy").

This is a larger change than 1A, and it touches a subsystem this repo's own
instructions flag as fragile ("has OOM'd the extension host before"). It also
needs a lifecycle owner, and **`WorkflowOrchestrator` cannot be that owner
on its own**: the standalone CLI binary constructs `OutputHistoryManager`
directly (`cli.ts:936`, `cli.ts:1138`) with no `WorkflowOrchestrator`
involved at all, so an orchestrator-owned registry would leave the CLI path
still creating its own private `HistorySearchIndexService` per invocation.
Use a workspace-keyed module-level registry instead (e.g. a small new
`HistorySearchIndexServiceRegistry` in `src/core/orchestration/`, `Map<string,
HistorySearchIndexService>` keyed by resolved `workspaceFolderPath`) that
both the extension (`WorkflowOrchestrator`, `WorkflowInstance`,
`CtrlYokeWebviewProvider`/`HistorySearchService`) and the CLI binary go
through, rather than something reachable only from `WorkflowOrchestrator`.

Every current `new HistorySearchIndexService()` / `new HistorySearchService()`
call site (`OutputHistoryManager.ts:142`, `HistorySearchService.ts:53`, plus
whatever constructs those two) needs to resolve its instance through that
registry instead. This touches every `new OutputHistoryManager(...)` call
site too — `cli.ts` (2), `WorkflowOrchestrator.ts` (6), `WorkflowInstance.ts`,
`WorkflowSerializer.ts` (2) — either by having `OutputHistoryManager`'s
constructor resolve from the registry itself (simplest — no call-site changes
needed) rather than by threading an injected instance through every
constructor call.

The shared instance must be workspace-scoped (keyed by
`workspaceFolderPath`), not a single process-wide singleton — ctrlyoke
supports multiple workspace folders and this must not cross-contaminate
their indexes.

## Problem 2: No heap isolation for the rebuild scan itself

Even with Problems 1A/1B fixed, a full rebuild's scan loop
(`listRunSources` → per-run manifest/events read → candidate extraction →
JSONL stream-out) still runs on the extension host's own V8 heap. A
sufficiently large history, or a single unusually large run, can still push
that heap toward the same OOM this whole investigation started from — the
lock/dedup fixes reduce _how often_ a big rebuild runs, not _how much heap_
one rebuild can consume while it runs.

### Proposal: move the rebuild scan into a `worker_threads` worker

Node's `worker_threads` gives a worker its own V8 isolate/heap. A runaway
allocation there can't blow the main extension-host heap, and if the worker
does OOM, only that worker dies — the extension host, and every other live
workflow, is unaffected. This was evaluated against a full separate OS-process
daemon and rejected in favor of a worker thread; see **Non-goals** below
("No separate OS-process daemon") for why.

Design sketch:

- New worker entry module, e.g.
  `src/core/orchestration/historySearchRebuildWorker.ts`, performing exactly
  the locked section of today's `rebuild()`: list run sources, read each
  run's manifest/events, extract capped candidates, stream them to
  `documents.jsonl`, write the manifest, swap files into place.
- **The worker never sends documents back over the message channel.** It
  only posts small status messages (progress ticks matching today's
  `IndexRebuildProgressCallback` shape, and a final success/error result).
  A caller that needs the built documents in memory (the "retained" reader
  path) reloads them afterward via the existing `loadIfPossible()` /
  `readDocumentsJsonl()` streaming read from the now-fresh on-disk JSONL —
  the same code path already used for a cold load. This avoids structured-
  cloning a 642k-document array across the thread boundary, which would
  just relocate the heap-growth problem rather than solve it.
- The on-disk file lock (`withFileLock`) works identically from a worker —
  it's filesystem-based, not an in-process mutex — so none of the
  Problem-1 lock/coalescing logic needs to change to accommodate this; the
  worker acquires the same lock the main thread does today.
- **`vscode` is not available inside a `worker_threads` Worker, and the code
  being moved calls `Log.debug/info/warn` throughout** (rebuild
  starting/progress/complete, memory diagnostics) — `Log.ts` imports
  `vscode` directly, and a Worker gets its own module registry with no
  access to the extension host's injected `vscode` module. Checked: the
  other modules the moved code depends on (`TimelineRecorder`,
  `WorkflowLineageRepository`, `FileLockUtils`, `MemoryDiagnostics`,
  `WorkflowPaths`, `ProjectStatePaths`, `RunHistoryStoragePolicy`) have no
  direct or transitive `vscode` import — only `Log` does. This repo already
  has the fix for exactly this shape: `esbuild.js`'s `mcp-server.js` and
  `cli.js` bundles alias `vscode` to `src/platform/vscode-shim.ts` (a
  no-op shim), and `Log` already has a fully vscode-independent `cliMode`
  (`Log.initializeCli(workspaceDir, verbose)`, used by the CLI binary) that
  writes straight to a log file instead of a `vscode.LogOutputChannel`.
  Give the worker bundle the same `vscode` alias and have the worker call
  `Log.initializeCli(...)` at startup (pointed at the same log file the
  main thread is already writing to) — every existing `Log.*` call in the
  moved code then keeps working completely unchanged.
- `esbuild.js` needs a second bundle entry point for the worker script,
  the same way `out/cli.js` is already a separate bundle from the main
  extension-host bundle. `HistorySearchIndexService.rebuild()` spawns the
  worker, passes `workspaceFolderPath` + rebuild options, and awaits its
  result via `MessageChannel`/`Worker.on("message"/"error"/"exit")`.
- Scope this to `rebuild()`'s scan loop only. `search()`'s in-memory
  filter/sort over already-loaded documents is fast and doesn't need
  isolation; leave it on the main thread.
- **Spawn a fresh worker per rebuild (or recycle a pooled one after N
  rebuilds), never one long-lived worker for the process lifetime.**
  Terminating the worker after each rebuild is what releases its entire V8
  isolate back to the OS — a worker kept alive across many rebuilds would
  just relocate the same cross-session baseline-creep pattern seen in the
  2026-08-27 Incident #2 crash (see above) onto a second thread instead of
  eliminating it.

### Phase 2 — shipped 2026-08-27

Implemented in
`src/core/orchestration/historySearchRebuildWorker.ts`. Each rebuild now
spawns and terminates a fresh worker, which owns the lock-scoped freshness
recheck, history scan, streamed JSONL write, manifest publication, and stale
rebuild-directory cleanup. The host relays only progress ticks and the final
result, then reloads retained documents from disk.

The worker is bundled as `out/historySearchRebuildWorker.js` by `esbuild.js`.
Its `vscode` import is aliased to `src/platform/vscode-shim.ts`, and it calls
`Log.initializeCli()` with the host's current log path so existing logging and
memory diagnostics continue in the same workspace log file.

## Non-goals

- **No separate OS-process daemon.** Rejected during the incident
  investigation: the actual crash forensics showed the harness CLI process
  itself (spawned via `node-pty`) already survives an extension-host crash
  and runs to completion independently — what OOM'd was ctrlyoke's own
  in-heap bookkeeping (duplicate rebuilds, unbounded fallback text), not
  fundamentally "memory-intensive work" that needs a whole separate process.
  A real daemon would also cost far more than this plan's problems justify:
  a second bundled executable, an IPC protocol to design and version,
  process lifecycle/crash-restart/orphan-cleanup handling (this repo's own
  `dev/reference/DEVELOPING_CTRLYOKE_WITH_CTRLYOKE.md` notes graceful-close
  is "only empirically verified on Windows so far" for a much simpler
  dev-only case), multi-window/workspace singleton coordination (the same
  lock-contention shape as Problem 1, just moved to a socket), and version
  skew against the auto-updating extension.
- No worker-thread isolation for other subsystems (PTY output buffering,
  general output-history persistence) — this plan is scoped to the one place
  with concrete OOM evidence. A similar case would need to be made from data
  before extending the pattern elsewhere.
- No change to `HistorySearchService`'s disk-scan fallback beyond what
  already shipped (text cap). That path is a safety net for when the index
  is unavailable, not a hot path to optimize further here.

## Sequencing

**Recommendation (updated 2026-08-27, after Incident #2):** implement Phase 1
(1A + 1B) and Phase 2 together as one effort — do not gate Phase 2 on Phase 1
landing first anymore. The original sequencing deferred Phase 2 on the theory
that Phase 1 might make it unnecessary; Incident #2 closes that question:
a crash occurred during a pass that Phase 1 would _not_ have skipped (a
legitimate, non-redundant rebuild), so Phase 1 alone provably would not have
prevented it. Two confirmed extension-host OOM crashes from this one service
in the time this plan has existed is enough to stop treating Phase 2 as the
"heavier option to evaluate afterward."

- **Phase 1A** — still do this first; it's small, low-risk, and directly
  fixes the wasted-rescan case confirmed in the first follow-up above
  (search rebuild racing a just-finished sibling rebuild's fresh write).
- **Phase 1B** — still worth doing alongside 1A: fewer total rebuild passes
  per session directly reduces the baseline-creep mechanism identified in
  Incident #2, buying headroom even though it can't guarantee no future
  pass ever crosses the line.
- **Phase 2** (worker-thread isolation) — **raised from "next" to "do this
  now too."** It is the only proposed change that bounds a single rebuild
  pass's memory impact regardless of whether that pass was redundant or
  necessary, which is exactly the gap Incident #2 exposed. Build it with
  per-rebuild worker teardown (see the added note under Problem 2) so it
  also closes the baseline-creep mechanism, not just crash containment.

Net: treat Phase 1 (1A + 1B) and Phase 2 as one combined effort, not a
sequence gated on log data anymore — the data now says both are needed.

## Acceptance criteria

- [x] Two `HistorySearchIndexService` instances (e.g. two workflows completing
      near-simultaneously) no longer both run a full rebuild pass when the
      second one's data would already be fresh after the first's completes.
- [x] A full index rebuild's scan/extraction work runs off the extension host's
      main heap, and a worker-side OOM does not crash or degrade the extension
      host or any other live workflow.
- [x] `search()`'s synchronous rebuild-before-search path still reports progress
      to the UI (existing `SEARCH_INDEX_REBUILD_PROGRESS` messages) when the
      work has moved to a worker.
- [x] No regression to existing `HistorySearchIndexService`/`HistorySearchService`
      unit test coverage; new coverage for the freshness-recheck skip path and
      for worker success/failure/progress relay.
- [x] Phase 1B shipped through
      `HistorySearchIndexServiceRegistry.ts`: the registry uses a normalized,
      resolved `workspaceFolderPath` key (including Windows case folding), so each
      workspace gets one shared index-service instance and no index service is
      shared across workspace folders.
