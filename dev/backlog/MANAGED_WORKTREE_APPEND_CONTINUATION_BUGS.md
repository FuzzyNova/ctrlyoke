# Managed Worktree — Append-Continuation Bugs

> **Status:** Backlog / diagnosis. Five defects, found by tracing "append a
> prompt to a completed workflow running on a managed worktree." Bugs 2 and 3
> are fixed; the remaining defects are confirmed by code reading.
>
> | # | Bug | Severity | Status |
> | - | --- | -------- | ------ |
> | 1 | Append after a landed run gets an empty checkout with setup skipped | High — agent starts in a tree that does not build | fixed in step 2 |
> | 2 | No-change append on a landed branch blocks finalization | High — normal conversational turn reports a bogus identity error | fixed |
> | 3 | `changedFileCount` diffs from the original base | Low — misreported count | fixed |
> | 4 | "Retry Setup" action is unreachable (zero callers) | Medium — failed setup has no recovery path | dropped — re-run is the recovery gesture |
> | 5 | Retry Setup would still no-op for managed once wired | Medium — blocks the fix for 4 | dropped — no action is wired |
> | 6 | Named mode silently runs in a half-provisioned worktree after a failed setup | High — no error, no setup, no warning | fixed |
>
> Bugs 1–3 are the "follow up on a landed managed run" case. Bugs 4–6 are the
> separate "recover from a failed setup" case; see *Recovery: re-run, not a
> button* below for why 4 and 5 should probably be dropped in favor of fixing 6.
>
> Only bites workflows that opted into managed mode —
> `defaults.worktree.mode` is `WORKTREE_MODES.NONE` (`CtrlYokeSettings.ts:334`).

## Why appends are special

An append-continuation **does not promote a new run**. `promoteToNewRun` is
gated on `!isAppendContinuation` (`WorkflowInstance.ts:1603-1634`), so the append
reuses the same `workflowKey` and `runRef`. Meanwhile terminal settlement of a
managed run clears both `activeWorktree` and `executionLease`
(`WorkflowInstance.ts:4017-4019`), so `prepareExecutionWorktree`'s early return
(`:3623`) does not apply and the append re-enters `ensureManagedWorktree` with
the *same run identity*.

Everything downstream then hinges on one line:

```ts
// WorktreeManager.ts:1235
const origin: WorktreeOrigin = existingRecord ? "recovered" : "created";
```

`origin` is decided **only** by whether the ownership record exists. Directory
state does not enter into it. Because managed branch names and worktree
directory names are both derived deterministically from the unchanged `runRef`,
the append targets the same branch and the same path either way.

---

## Bug 1 — a landed append gets an empty checkout with setup skipped

`removeAfterLanding` keeps the ownership record after removing the directory,
writing `directoryState: "removed"`, `branchState: "present"`
(`WorktreeManager.ts:1023-1030`). The record is unlinked *only* on the
no-change-plus-branch-deleted path (`:1045-1051`).

So after a run that landed changes, an append resolves:

- `existingRecord` found → `origin = "recovered"`
- `shouldRunSetup = Boolean(setup) && args.origin === "created"` (`:2371`) → **false**
- `addWorktree(..., { createBranch: false })` re-attaches the existing branch
  into a **freshly created, empty directory**

`node_modules`, `.env`, generated assets, and caches are ignored, therefore not
in the branch, therefore absent from the new directory — and setup, the one
thing that would restore them, is skipped. The agent starts in a tree that does
not build.

**Status: fixed in step 2.** `shouldRunSetup` now answers whether this
directory needs provisioning: it is true for `origin === "created"` or when
the resolver observed that it had to call `addWorktree`. The latter is the
authoritative signal; a recorded `directoryState: "removed"` corroborates the
recreate case without changing the honest `origin: "recovered"` projection.
Setup idempotency therefore matters more than the original design assumed.

## Bug 2 — a no-change append on a landed branch blocks finalization

`record.baseCommit` is never advanced to the landed tip; only
`lastVerifiedBranchTip` / `finalBranchTip` move (`:1140-1152`). On the append's
settlement (`completeManagedRun`, `:620-646`):

```ts
const changed = await hasUncommittedChanges(info.worktreePath);   // false
const committedHead = await resolveCommit(info.worktreePath, "HEAD");
if (committedHead === record.baseCommit) { ...no-change path... }  // false — run 1 landed
if (!changed) {
  return blocked("Managed branch changed without a ctrlyoke landing; ...");
}
```

`validateManagedCheckoutIdentity` passes (branch tip still equals
`lastVerifiedBranchTip`, `:888`), so the guard that fires is the `!changed` one —
which exists to catch a branch that moved *outside* ctrlyoke. Here it fires on a
branch ctrlyoke itself landed one turn earlier.

Result: finalization is `blocked`, the directory is kept, the run reports a
misleading identity error. This is the ordinary shape of a conversational
planning turn that writes no files.

**Fix direction:** the no-change comparison must be against the run's *current*
landed tip, not its original base — compare `committedHead` to
`record.finalBranchTip ?? record.baseCommit`. Keep `baseCommit` as the review
base for the branch as a whole; it should not double as the per-attempt
watermark. `changedFileCount` has the same bug in milder form: it diffs from the
original base, so it re-counts every earlier turn's files.

## Bug 3 — `changedFileCount` diffs from the original base

Same root cause as Bug 2. `completeManagedRun` computes
`getDiffFilesBetweenRefs(repositoryRoot, record.baseCommit, committedHead)`
(`:653-661`), so every append re-counts all of the earlier turns' files. Fixing
Bug 2's watermark fixes this too.

## Bug 4 — "Retry Setup" is unreachable

The planned action had no caller: no VS Code command, webview message, Workflow
Properties control, or test. The action was deleted in step 4 rather than wired
up. A failed setup remains a hard error for that run, and pressing Run again
re-enters the resolver, which automatically re-runs the non-succeeded setup.

## Bug 5 — Retry Setup would still be a no-op for managed worktrees

This is dropped with Bug 4. Managed re-runs already create a fresh run and
re-provision when the checkout needs it; adding a user-action flag would create
another recovery surface without improving the named-mode failure. No retry
parameter is threaded through either mode.

## Bug 6 — named mode silently runs unprovisioned after a failed setup

`resolveNamedWorktree` now reads a versioned setup record keyed by the resolved
worktree path. It runs setup whenever the durable outcome is absent, `pending`,
`running`, or `failed`, and skips it only for `succeeded`.

`existingSetupOutcome` was read from the **current run's** working file, and
`promoteToNewRun` writes a fresh `_runtime` with no worktree block. A fresh
re-run therefore forgot the failed setup, discovered the surviving worktree,
and skipped setup.

The silent path is the more damaging of the two, and it is the default one for
anyone who reacts to a failed run by pressing Run again.

Step 4 stores a versioned setup record under
`<commonDirectory>/ctrlyoke/named-worktrees/<sha256(resolved worktree path)>.json`.
The resolver reads that record and runs setup whenever its outcome is absent,
pending, running, or failed; only `succeeded` suppresses setup. Each transition
is written durably alongside the existing per-run runtime update, so a crash
after pending or running leaves a state that the next Run re-provisions.

---

## Recovery: re-run, not a button

Whether Bugs 4 and 5 are worth fixing as specified depends on whether an
explicit Retry Setup action earns its place. It probably does not.

**Managed already recovers by re-running.** A plain re-run promotes a new run →
new `runRef` → new branch name and directory path → no ownership record →
`origin = "created"` → setup runs. The only defect is a leak: the blocked
attempt's directory, branch, and ownership record are never cleaned up, and one
accumulates per failed attempt.

**Named does not recover** — that is Bug 6, and its fix is durable per-worktree
setup state plus re-running setup whenever the last outcome is not `succeeded`.
Once that lands, re-run is a complete recovery gesture for both modes and a
dedicated action has nothing left to do.

`WORKTREE_SUPPORT_PLAN.md` requires explicit user action because "retrying may
repeat a non-idempotent command." That reasoning holds for re-running a
**succeeded** setup and is much weaker for a **failed** one, where re-running is
the ordinary human response. Encode exactly that: never re-run a succeeded
setup, always re-run a failed one.

**Do not route this through
[`FEEDBACK_AUTOMATION_COMPATIBILITY_STAGING.md`](../active/FEEDBACK_AUTOMATION_COMPATIBILITY_STAGING.md)
Stage F.** That stage has a closed scope — 6 enumerated action-bearing
`show*Message` sites plus the `USER_INTERACTION_REQUEST` correlation contract
(timeouts, dismissal, disconnect, headless fallbacks). Retry Setup is not one of
those sites and is not a message today; adding it would widen a scope that is
bounded deliberately. If an affordance is ever wanted, it belongs on the
worktree status surface beside the blocked state, as a dashboard action rather
than a correlated interaction request.

**Recommendation:** fix Bug 6, drop Bugs 4 and 5 as specified, and delete
`WorktreeManager.retrySetup()` / `WorkflowInstance.retryWorktreeSetup()` as dead
code rather than wiring them up. Separately, clean up blocked managed worktrees
so failed attempts stop accumulating.

---

## Decided: re-provision on every append (2026-08-14)

Fixing Bug 1 the direct way — re-run setup whenever the directory was recreated
— means setup runs on **every** append, because managed settlement removes the
directory each time. With a 5-minute `npm ci` that is 5 minutes per follow-up
prompt.

**That cost is accepted.** Managed mode's contract is a throw-away worktree
removed when the workflow completes; a user who picks it and then appends
without `keep` is working against the mode they chose, and should feel the
re-provisioning cost rather than have the product quietly change what managed
means.

The rejected alternative was deferring removal until the lineage promotes a new
run. It fails on directory bloat: **most runs never get a second run**, so their
directories would persist indefinitely — precisely the outcome a user selecting
managed-without-keep is trying to avoid. Optimizing the append case would
penalize the common case.

Also rejected: promoting an append to a new run. It discards the
accumulate-on-one-branch property that makes a follow-up feel like a
continuation.

### Required with the fix: tell users what each mode costs

The behavior is defensible only if the UI states it at the point of choice. Add
single-sourced help text following the existing `EXECUTION_MODE_HELP_TEXT`
pattern (`DashboardConstants.ts:1102`, consumed by `WorkflowPropertiesPanel`,
`PropertiesDrawer`, and `ScriptConditionEditor`):

`WORKTREE_MODE_HELP_TEXT` — replaces the current mode `description` at
`WorkflowPropertiesPanel.tsx:1517`:

> None runs in your working checkout. Managed creates a throw-away worktree and
> branch per run and removes the directory when the workflow completes, leaving
> the branch for review — pick it for isolated runs you will not follow up on.
> Named targets a persistent worktree you own, which ctrlyoke never commits,
> merges, or removes — pick it for conversational workflows you will append to.
> Worktrees are workflow-level and do not apply to individual prompts.

`WORKTREE_KEEP_HELP_TEXT` — replaces the `description` and the duplicated
sub-paragraph at `WorkflowPropertiesPanel.tsx:1620` and `:1637-1640`:

> Keeps the managed worktree directory after the run instead of removing it.
> Without it, appending a follow-up prompt recreates the directory from the
> branch — ignored files such as `node_modules` are gone and the setup command
> runs again, so a long setup pays that cost on every append. Removing the
> directory also ends filesystem undo for that run.

Surfaces to update:

| Surface                                                  | What                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| `DashboardConstants.ts`                                  | the two new help constants                                  |
| `WorkflowPropertiesPanel.tsx:1517`, `:1620`, `:1637-1640` | consume them; drop the duplicated keep sub-paragraph        |
| `settings/WorktreesSection.tsx`, `DefaultsHarnessPage.tsx` | same text on the `defaults.worktree` rows                   |
| `schemas/workflow-schema.json:226`, `:238`, `:251`        | branch-object and `keep` descriptions (YAML authoring hover) |
| `schemas/settings-schema.json:293`, `:300`, `:318`        | the settings-side equivalents                               |

Correction (2026-08-14): the `mode` properties in `workflow-schema.json` are bare
`const` values with **no** `description` field (`:229-232`, `:254-257`). The
mode-level prose lives on the enclosing branch objects — `"Managed worktree
configuration."` (`:226`) and `"Named worktree configuration."` (`:251`) — so
that is what the new copy replaces there. `settings-schema.json:298` does have a
real `mode` description.

The JSON schemas cannot import the TS constant, so their descriptions stay a
deliberate near-duplicate — schema text serves YAML authoring, the constant
serves the UI. Regenerate `schemas/workflow-schema.yaml` via
`npm run generate-schema` after editing the JSON.

**Sequencing:** this copy must land **with** the Bug 1 fix, not before it. Today
setup does *not* re-run on append — that is Bug 1 — so shipping the text first
would document behavior the code does not have.

---

## Interaction with the two failure modes

Which bug an append hits depends on whether the *previous* turn wrote files:

| Previous turn | Record after settle | Append `origin` | Setup | Outcome                                        |
| ------------- | -------------------- | --------------- | ----- | ---------------------------------------------- |
| landed        | kept                 | `recovered`     | runs  | fixed: recreated checkout is provisioned      |
| no changes    | unlinked             | `created`       | runs  | new branch + directory; setup re-runs each time |

The second row is the "setup fires on every append" case. The first is the
inverse and more damaging. A spec-design conversation alternates between the two
shapes turn by turn, so an append-heavy workflow hits both.

## Recommendation for append-heavy workflows

`worktree.keep: true` is the documented recommendation for append-heavy managed
workflows: the directory remains attached at settlement, so an append reuses
the checkout with its ignored files intact and does not pay setup again. It
also avoids Bug 1's old empty-checkout failure. It does not change the
no-change watermark behavior from Bug 2.

With `keep: false`, managed mode still re-provisions and reruns setup on every
append by design, as specified above.

## Implementation plan (staged 2026-08-14)

Five steps, in dependency order. Each lands with tests and its own commit, and
updates this document's status table as it goes.

| Step | Scope | Bugs | Status |
| ---- | ----- | ---- | ------ |
| 1 | Settlement watermark in `completeManagedRun` | 2, 3 | complete |
| 2 | Re-provision managed worktrees whose directory was recreated | 1 | complete |
| 3 | `WORKTREE_MODE_HELP_TEXT` / `WORKTREE_KEEP_HELP_TEXT` + schema copy | — | complete |
| 4 | Durable per-worktree named setup state; delete Retry Setup | 6, 4, 5 | complete |
| 5 | Clean up blocked managed attempts so they stop accumulating | — | not started |

Sequencing constraints that are not arbitrary:

- Step 3 must not land before step 2. The copy describes setup re-running on
  append, which is only true once Bug 1 is fixed.
- Step 4 must delete `retrySetup` only *after* the same step makes a failed
  setup re-run automatically; deleting first would leave named mode with no
  recovery path at all.

Step 4's storage decision is to use a sibling `named-worktrees` store and key
records by the resolved worktree path. The directory is the provisioning unit,
not the branch: a branch can be detached and reattached at another path, while
the setup state belongs to the directory that was provisioned. The existing
hashed record-path, JSON read/validation, and atomic write helpers are shared
with managed ownership records; the named store has its own schema version so
its records cannot be mistaken for ownership records. Step 5's cleanup decision
remains open for its own implementation.

## Testing

- Managed worktree, `setup` configured, run 1 writes a file and lands; append a
  second prompt → the worktree directory exists **and** setup ran (or the
  directory was never removed).
- Managed worktree, run 1 lands; append a prompt that writes nothing →
  settlement is `no-changes`, not `blocked`.
- Named worktree whose setup failed → a fresh re-run either re-runs setup or
  fails loudly; it must never run in the worktree with setup silently skipped.
- Managed worktree whose setup failed → a fresh re-run provisions cleanly, and
  the blocked attempt's directory/branch/record do not accumulate.
- `changedFileCount` on the second landed append counts only that append's
  files.
