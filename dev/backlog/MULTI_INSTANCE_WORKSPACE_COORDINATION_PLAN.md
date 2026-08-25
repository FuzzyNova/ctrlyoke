# Multi-Instance Workspace Coordination Plan

> **Status:** Proposed — not started
>
> **Priority:** P1 for Phase 1 (active correctness bug), P3 for Phases 2–3
> (nice-to-have visibility/UX)

## Problem

VS Code fully supports opening the same folder as the root of two or more
independent windows at once, and ctrlyoke does nothing to prevent it. This is
not a hypothetical: it is the normal shape of developing ctrlyoke with
ctrlyoke — one window running a production-installed ctrlyoke against the
`ctrlyoke` repo itself, and a second window running an Extension Development
Host (`F5`) against `ctrlyoke-test.code-workspace`, which is just the same
repo root (`.`) in a workspace file (`ctrlyoke-test.code-workspace:1-16`). Any
user who opens the same project in two windows — deliberately or by
accident — lands in the same situation.

ctrlyoke has **no concept of "another ctrlyoke instance already owns this
workspace."** Today that gap is silent in the best case and destructive in
the worst: a second instance's startup routine can force-stop a live,
actively-running workflow that a sibling instance is legitimately executing.

## Current Behavior (verified)

### Run storage is keyed by workspace path, not by process

By default, `storage.runHistoryLocation` is `"user"`
(`src/types/CtrlYokeSettings.ts:391`), so run storage — lock files, lineage
descriptors, and every run's `workflow.ctrlyoke.json`/`manifest.json`/
`events.jsonl` — lives under `<ctrlyokeStateHome>/projects/<slug>-<hash12>/
.runs/`, not inside the workspace's own `.ctrlyoke/` folder
(`.github/copilot-instructions.md` debugging section; `src/utils/
ProjectStatePaths.ts`). The project key is derived from the resolved
workspace root path, so **two processes that open the identical folder
resolve to the identical run-storage directory** regardless of which
`.code-workspace` file was used to open it. This is true whether
`runHistoryLocation` is `"user"` or `"workspace"` — in the latter case the
shared directory is even more obviously the same folder on disk.

### The runner lock has no cross-instance identity check

`WorkflowLockManager` (`src/utils/WorkflowLockManager.ts`) writes one
`runner.json` per lineage, naming the exact executing `RunRef`, the owning
`pid`, an `ownerToken`, and an optional `instanceId`
(`src/types/CtrlYokeTypes.ts:1095-1110`). `checkLock` / `inspectWorkflowLock`
(`src/utils/WorkflowLockInspector.ts:28-42`) only ever returns four statuses:
`none`, `stale` (dead PID or heartbeat >30s old, `LockSafetyPrimitives.ts`),
`active-cli`, or `active-vscode`. **`active-vscode` does not mean "this
process" — it means "some live VS Code Extension Host,"** and nothing
compares the lock's `instanceId`/`pid` against the caller's own identity to
tell those two cases apart.

### The startup normalization scan treats a live sibling's lock as leftover state from itself

`WorkflowOrchestrator.setupCliWatching()` runs
`WorkflowLockManager.normalizeStaleLocks()` on every activation
(`src/core/WorkflowOrchestrator.ts:5599-5618`). Its handling is:

```
if (status === LOCK_STATUS.ACTIVE_CLI) {
  // preserve RUNNING, register a CliWatchSession
} else {
  // "none", "stale", or "active-vscode" (we just started — can't be us)
  // normalize this run to STOPPED and delete the lock
}
```

(`src/utils/WorkflowLockManager.ts:311-327`, comment included verbatim.) The
comment's assumption — that an `active-vscode` lock seen during *my* startup
must be a leftover from a `vscode` process that can no longer be alive,
because I "just started" — is only true when there is exactly one ctrlyoke
VS Code instance per workspace. It is false the moment a second instance
exists: if Window A has a workflow genuinely `RUNNING` with a live,
heartbeating lock, and Window B (a second Extension Development Host, or a
second normal window) opens the same folder, **Window B's own activation scan
sees Window A's lock as `active-vscode` with a live PID and a fresh
heartbeat — i.e. not stale — and stops it anyway**, because the code path
that reaches this branch does not check "not stale" at all, only whether the
runner is `cli`. It rewrites `_runtime.executionState` to `"stopped"` on
disk, marks the interrupted step `"cancelled"`, and deletes Window A's lock
file out from under it (`WorkflowLockManager.ts:329-386`). Window A's own
in-memory `WorkflowExecutor` keeps running — its heartbeat writes will now
recreate a lock with a *new* `ownerToken`, but the run has already been
externally marked terminated on disk and in Window A's dashboard readers,
who's-more-current logic (`orchestration.instructions.md`'s manifest vs.
working-file divergence note) will show effects.

This is a genuine data-loss/correctness bug, independent of any broader
multi-instance feature: **opening a workspace with a running workflow in a
second ctrlyoke window can silently kill that running workflow.**

### The hosted server has no cross-instance awareness either

`CtrlYokeHostedServer.listen()` retries on `EADDRINUSE` by falling back to an
OS-assigned port (`src/server/CtrlYokeHostedServer.ts:2036-2067`,
`server.instructions.md`'s `authAndTransport` section). If
`.ctrlyoke/settings.json` has `server.enabled: true` (a workspace-scoped
setting, shared by every instance that opens the folder), **every** instance
auto-starts its own server on activation
(`src/extension.ts:1294-1297`, default port 3000 at `extension.ts:1109`).
The result is two independent `CtrlYokeHostedServer`s, each bridging its own
process's `WorkflowOrchestrator`/`DashboardBroadcastHub` to whichever browser
clients happen to connect to it — silently coexisting rather than either
refusing to start or making the collision visible. (The dev-only
`.ctrlyoke/dev/server-url.txt` mirror is at least scoped to `IS_DEV_MODE`
builds, so a production install never contends for that particular file —
see the companion reference doc,
`dev/reference/DEVELOPING_CTRLYOKE_WITH_CTRLYOKE.md`.)

### No UI signal exists for "owned by another ctrlyoke instance"

`WorkflowSummary.managedBy?: RunnerId` already exists precisely to flag
non-local ownership, but its own doc comment gives away the gap: *"Set to
`'cli'` when the workflow is being executed by the ctrlyoke CLI. Undefined
means vscode-managed"* (`src/types/CtrlYokeTypes.ts:1070-1071`). It is
written **only** with `RUNNER_IDS.CLI`
(`src/core/WorkflowOrchestrator.ts:5951,5971`) or left `undefined`
(`WorkflowOrchestrator.ts:6326`) — never `RUNNER_IDS.VSCODE`, even though
that value already exists in the enum (`DashboardConstants.ts:1974-1978`).
`Header.tsx` (`src/ui/webview-react/components/layout/Header.tsx:171`) reads
`activeWorkflow?.managedBy === RUNNER_IDS.CLI` to lock the dashboard into
read-only "watch mode" for a CLI-managed run — the exact same treatment a
run owned by a sibling VS Code instance should get, but currently doesn't,
because nothing ever tells this instance that the run belongs to someone
else. Today, if Window B's `normalizeStaleLocks` didn't clobber Window A's
run (see above), Window B would instead load that run into its own dashboard
as an ordinary local workflow and offer full editing/re-run controls against
a lineage another live process is actively executing.

## Root Cause

All of the above traces to one gap: **ctrlyoke has a per-lineage execution
lock (`runner.json`), but no per-workspace instance registry.** The lock
answers "is *a* runner executing this lineage," but nothing answers "which
*instances* currently consider themselves attached to this workspace,"
so a newly-activating instance cannot tell "stale state from my own prior
crash" apart from "a live sibling is legitimately running this right now."

`ExecutionRootLeaseManager` (`src/core/orchestration/
ExecutionRootLeaseManager.ts:21-73`) already solved an analogous problem for
worktree execution roots — a `{ runner, instanceId, pid }` lease with the
same staleness rule (`isOwnerStale`) and a descriptive conflict message
(`"${owner.runner} instance ${owner.instanceId}, PID ${owner.pid}"`). That
pattern is a reasonable model for a workspace-level lease, rather than
inventing a new coordination primitive.

## Proposed Solution (phased)

### Phase 1 — Stop the data-loss bug (do this regardless of Phases 2–3)

**Implemented:** `normalizeStaleLocks` now leaves live `active-vscode` run and
lock files untouched; only `none`/`stale` locks are normalized and deleted.
Its return shape intentionally remains unchanged (no new `active-vscode` array)
so Phase 2 can choose that shape against real call-site needs.

Fix `normalizeStaleLocks`' `active-vscode` branch so it only normalizes a
lock that is actually stale (dead PID or heartbeat >30s), never a live one.
Concretely: reorder the check in `WorkflowLockManager.normalizeStaleLocks`
(`WorkflowLockManager.ts:311-327`) so the branches are `ACTIVE_CLI` → preserve
+ CLI watch, **truly live `ACTIVE_VSCODE`** (not stale) → preserve + register
some equivalent of a watch session instead of a locally-owned
`WorkflowInstance` (see Phase 2), and only `NONE`/`STALE` → normalize to
`STOPPED`. This alone removes the "second window kills the first window's
run" failure mode even with zero other changes — a genuinely dead sibling
(closed window, crashed extension host) still gets cleaned up exactly as
today, since `isOwnerStale` already covers that case correctly.

### Phase 2 — Surface "owned by another ctrlyoke instance" in the dashboard

Generalize the existing `managedBy`/watch-mode machinery
(`RUNNER_IDS.VSCODE`, already defined) the same way CLI-managed runs are
handled today:

- When Phase 1's live-`active-vscode` branch is hit, register a read-only
  watch (reuse or adapt `CliWatchSession`'s polling/tailing approach) instead
  of silently doing nothing or adopting the lineage into a local
  `WorkflowInstance`.
- Set `managedBy: RUNNER_IDS.VSCODE` on that summary so `Header.tsx`'s
  existing `isCLIManaged` check (`Header.tsx:171`, and the `isCLIManaged`
  branches through the file) generalizes to "managed by any other runner" —
  likely renaming the derived flag to something like `isExternallyManaged`
  and keeping a separate label ("Running in another ctrlyoke window" vs.
  "Running via ctrlyoke CLI") sourced from `managedBy`.
- Decide what "Stop" should do for a sibling-owned run from this instance:
  today `handleStopCliRun` posts `STOP_CLI_RUN`
  (`Header.tsx:257-263`) which presumably signals through shared state the
  CLI process polls; an equivalent signal channel is needed for a sibling
  VS Code process (it cannot just delete the lock — see Phase 1's ownerToken
  protection — so it likely needs its own lightweight cross-process request,
  e.g. a sentinel file the owning instance's watcher polls for, mirroring how
  `runner.json` creation is already watched by `setupRunnerJsonCreateWatcher`).

### Phase 3 — Hosted server awareness (lower priority)

Make a second instance's server auto-start detect that the port it fell back
from is already answering as a *ctrlyoke* server (not just "something is on
that port") — e.g. probe `GET /api/...` with the configured token before
assuming EADDRINUSE means "unrelated process." If it is a sibling ctrlyoke
server, either: skip starting a second server and show a status-bar/settings
notice pointing at the existing one, or keep todays's silent-fallback
behavior but surface it in the Settings server section (which already has UI
for `portFallback`, see `server.instructions.md`) with sibling-aware wording
instead of "port was already in use by something."

## Related, Lower-Severity: The "Open Worktree in New Window" Case

The dashboard also lets a user open a ctrlyoke-managed or named worktree
directly as the root of a brand-new VS Code window — the **Open Worktree in
New Window** action in `RunSummaryBanner.tsx`
(`src/ui/webview-react/components/output/RunSummaryBanner.tsx:324-338`),
which calls `vscode.commands.executeCommand("vscode.openFolder", …, true)`
(`src/extension.ts:866-882`) on the exact `worktreePath` recorded for that
run. If ctrlyoke is installed as a normal extension, that new window
activates its own ctrlyoke instance — a second kind of "two instances, one
directory" situation, structurally different from the same-folder case
above.

### Why it is not the same bug

A worktree and its source checkout are two different paths, so the new
window's project-state hash (`src/utils/ProjectStatePaths.ts`) differs from
the originating instance's. That means:

- Run storage, `runner.json`, and lineage state are **not shared** — there is
  no `normalizeStaleLocks` collision, because the two instances never write
  the same lock file.
- The new window's run history starts empty; it has no visibility into (and
  cannot corrupt) the run history of the project that created the worktree.

The open question is narrower: **can the two instances' harness processes
write to the same files at the same time?**

### That part is already handled

`ExecutionRootLeaseManager` (`src/core/orchestration/
ExecutionRootLeaseManager.ts`, described in `dev/implemented/
WORKTREE_SUPPORT_PLAN.md`'s "Concurrency: Shared and Exclusive Execution
Leases" section) scopes leases by the **worktree's own absolute Git
directory**, resolved under the shared Git common directory — not by project
state root. Every ctrlyoke-orchestrated run, ordinary or worktree-targeted,
acquires a lease in that same scope before doing any harness/script work
(`WorkflowInstance.ts:4296-4300` acquires `shared-native` for ordinary runs;
managed/named worktree runs acquire `exclusive-worktree`). Concretely:

- While the originating instance's managed/named run is actively executing
  (lease held from provisioning through finalization/removal), any workflow
  the new window tries to run in that same worktree is **blocked
  immediately** with an actionable conflict error naming the owning
  workflow/PID/state root, plus the existing **Open Owning Workspace** action
  (`VSCODE_COMMANDS.OPEN_WORKTREE_OWNER`, `src/extension.ts:1231-1246`) — the
  same mechanism already built for ordinary same-directory lease conflicts.
- Symmetrically, once the new window starts its own ordinary run there
  (`shared-native` lease), the originating instance cannot start a *second*
  worktree-targeted run against that same worktree until the new window's
  run ends.
- Branch-deletion safety is independent of any of this: `WorktreeManager`
  only deletes a managed branch after verifying its tip still matches the
  last tip ctrlyoke itself recorded, so edits made from the second window
  cannot cause the owning instance to silently discard them.

So for the realistic case this button exists for — opening a `keep: true`
managed worktree, or a named/persistent worktree, after the owning run has
settled — the two instances are already correctly arbitrated by existing,
shipped infrastructure. This needs no new locking primitive.

### What is genuinely missing (visibility only, not correctness)

1. **No indication, in the new window, that the folder is a ctrlyoke-owned
   worktree.** `Header.tsx`/`WorkflowStatus.tsx` only consult the ownership
   record and lease state while *driving* a worktree run; a window opened
   directly on the worktree path never reads its own ownership record
   (`<git-common-dir>/ctrlyoke/managed-worktrees/<branch-hash>.json`) to tell
   the user "this is branch `ctrlyoke/ui-refactor/run-…`, owned by
   `<sourceCheckoutRoot>`." Worth a read-only banner built on discovery code
   that already exists (`WorktreeManager.discoverRecoverableManagedWorktrees`
   / `git worktree list`), not a new coordination mechanism — a natural
   addition to Phase 2's dashboard-visibility work above rather than a new
   phase.
2. **A narrow creation-time race.** The exclusive lease is acquired at
   lifecycle step 6, one step after `git worktree add` at step 4 (see the
   Managed/ephemeral lifecycle in `WORKTREE_SUPPORT_PLAN.md`). A user who
   opens and edits the directory in that brief gap isn't yet blocked by
   anything. Worst case the edit is either swept into the owning run's
   auto-commit or trips the `.ctrlyoke/` runtime-path guard and blocks
   finalization (directory kept) — never silent loss — so this is a
   low-priority polish item, not a correctness gap.
3. **Worktree-of-a-worktree is unvalidated.** If the second window itself
   authors a workflow with `worktree: true`/named targeting a *further*
   nested worktree, confirm the placement guards ("reject a root contained
   within any discovered worktree") still resolve correctly when
   `sourceCheckoutRoot` is itself a linked worktree rather than the
   repository's main checkout. Likely fine given the guards are already
   phrased in terms of "any discovered worktree," but untested.

**Recommendation:** no new phase. Fold item 1 into Phase 2 as an additional
bullet — surfacing external ownership is the same theme as generalizing
`managedBy` — and leave items 2–3 as watch items; they're pre-existing edge
cases of the worktree feature itself, not new risk introduced by the
coordination gap this document is otherwise about.

## Non-Goals

- **Do not prevent multiple windows from opening the same folder.** That is
  core VS Code behavior and out of ctrlyoke's control or business to block.
- **Do not build distributed consensus / leader election.** A lease-and-watch
  model (mirroring `ExecutionRootLeaseManager`) is sufficient; ctrlyoke does
  not need every instance to agree on a single source of truth beyond "who
  currently holds the execution lock for this lineage," which the lock
  already answers once Phase 1 stops corrupting it.
- **Do not attempt to merge two instances' in-memory dashboard state.** A
  sibling-owned run stays read-only/watch-only in every instance that
  doesn't hold its lock, same as CLI-managed runs today.

## Suggested Priority

Ship Phase 1 on its own as a straightforward correctness fix — it has no
UI/schema surface and removes a real data-loss bug for any user who ever
opens one project in two windows. Phases 2–3 are UX polish on top and can
wait for evidence of real user friction (mirroring how CLI-managed watch mode
was justified) rather than being built speculatively. The "Open Worktree in
New Window" case above needs no dedicated phase — its only real gap (item 1)
rides along with Phase 2 whenever that work happens.

## Related Files

- `src/utils/WorkflowLockManager.ts` / `WorkflowLockInspector.ts` /
  `LockSafetyPrimitives.ts`
- `src/core/WorkflowOrchestrator.ts` (`setupCliWatching`,
  `startCliWatchSession`, `handleRunnerJsonEvent`)
- `src/core/orchestration/ExecutionRootLeaseManager.ts` — model to follow for
  Phase 1–2, and already the mechanism arbitrating the "Open Worktree in New
  Window" case above
- `src/types/CtrlYokeTypes.ts` (`WorkflowRunnerLock`, `WorkflowSummary.managedBy`)
- `src/types/DashboardConstants.ts` (`RUNNER_IDS`, `LOCK_STATUS`)
- `src/ui/webview-react/components/layout/Header.tsx` (`isCLIManaged` and
  its watch-mode lockdown — the pattern Phase 2 generalizes)
- `src/ui/webview-react/components/output/RunSummaryBanner.tsx` — **Open
  Worktree in New Window** action (`src/extension.ts:866-882`) that opens the
  related, lower-severity cross-window scenario above; also
  `VSCODE_COMMANDS.OPEN_WORKTREE_OWNER` (`src/extension.ts:1231-1246`), the
  existing "Open Owning Workspace" action that already generalizes to that case
- `src/server/CtrlYokeHostedServer.ts` (`listen()` EADDRINUSE fallback)
- `dev/implemented/CLI_WATCH_MODE.md`,
  `dev/implemented/STALE_RUNNING_STATE_AND_COORDINATION.md` (prior art this
  plan extends)
- `dev/implemented/WORKTREE_SUPPORT_PLAN.md` (worktree lifecycle, ownership
  records, and the execution-lease model the cross-window section above
  relies on)
- `dev/reference/DEVELOPING_CTRLYOKE_WITH_CTRLYOKE.md` (the practical,
  today-available mitigation via `CTRLYOKE_HOME` while this plan is
  unimplemented)
