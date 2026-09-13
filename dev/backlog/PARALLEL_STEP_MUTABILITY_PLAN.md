# Parallel Step Mutability Plan

> **Status:** Backlog / design proposal. Nothing here is implemented.
>
> **Prerequisite for:** [`RUN_DISPATCH_MENU_PLAN.md`](./RUN_DISPATCH_MENU_PLAN.md).
> That plan's Decision 1 ("Run in Parallel") appends a member to a group that is
> already executing, and states that _"`PromptQueue.assertEditableDuringExecution`
> already permits an insert at any index `> currentIndex`, so no execution-guard
> change is needed."_ **That claim is true and is exactly the problem** — the
> guard permits far more than it should, because during a parallel group
> `currentIndex` never moves. Stages 1–3 below are the minimum that must land
> before a late join is safe; Stage 4 is what the broader mutability rule needs.
>
> **Depends on:** [`PARALLEL_STEPS_PLAN.md`](../implemented/PARALLEL_STEPS_PLAN.md)
> (shipped) for the fork/join model this plan hardens.
>
> **Related:** [`EXECUTION_ROOT_COORDINATION_PLAN.md`](../implemented/EXECUTION_ROOT_COORDINATION_PLAN.md)
> (shipped) — its Decision 8 group ban is currently the _only_ thing keeping the
> step-mutating MCP tools away from the guards described here. Stage 1 is what
> would let that ban be justified by the guard rather than by the ban.

---

## The rule this plan implements

> **If a step has started, it is immutable — it cannot be edited, removed, or
> reordered. If it has not started, it is mutable, wherever it sits in the
> queue.**

Every mutation guard in the codebase is trying to say this. None of them says
it. They all say something else that happens to be equivalent under sequential
execution:

```ts
index < currentIndex; // "already started"
index === currentIndex && hasInFlightStep; // "currently executing"
```

That substitution is exact for a sequential queue, where exactly one step runs
and `currentIndex` advances past each one as it settles. It is **wrong for
every parallel-group member after the first**.

## Why it is wrong: `currentIndex` is frozen for the whole group

Mid-group settlements go through `PromptQueue.persistStepOutcome`
(`PromptQueue.ts:891`), which applies the outcome and writes the working file
but never touches `currentIndex` — deliberately, and in contrast to
`commitStepOutcomeAndAdvance` (`:901`), which does. `currentIndex` moves exactly
once per group, in `commitParallelGroupJoin` (`:917`):

```ts
this.state.currentIndex = Math.max(this.state.currentIndex, group.endIndex + 1);
```

So for the entire lifetime of a running group, `currentIndex === group.startIndex`.
Members at `startIndex + 1 … endIndex` are all `> currentIndex`, which every
guard reads as **"pending, freely mutable"** — while their workers are actively
running them.

This is not a deliberate policy that parallel groups are immutable. It is a set
of guards that cannot see parallel execution at all.

### What the guards actually check

| Guard                                                                 | Location                            | Predicate                                                                                                        | Group-aware?                                        |
| --------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `PromptQueue.assertEditableDuringExecution`                           | `PromptQueue.ts:2493-2512`          | `index < currentIndex`; `index === currentIndex && hasInFlightStep`                                              | No — no `parallelGroups` reference                  |
| `RunContinuationService.assertEditableDuringExecution` (the MCP path) | `RunContinuationService.ts:724-745` | same, **plus** `step?._runtime?.completedAt !== undefined`                                                       | No                                                  |
| `PromptQueue.reorderPendingPrompts`                                   | `:2270`                             | `hasInFlightStep && newPendingOrder[0] !== 0`                                                                    | No — assumes one in-flight step at slice position 0 |
| `reorderPendingTopologyWithRanges`                                    | `ParallelGroupTopology.ts:632-647`  | `startIndex < currentIndex \|\| any member has completedAt \|\| (hasInFlightStep && currentIndex ∈ [start,end])` | Yes, but see below                                  |

`assertEditableDuringExecution` is called from insert (`:1697`), edit (`:2097`),
replace (`:2145`) and delete (`:2183`). Reorder has its own guard and does not
call it.

Two further gaps behind that table:

- **The one group-aware predicate is unreachable from MCP.** `reorderPendingTopologyWithRanges`
  only runs when `pendingGroups !== undefined`, and `handleReorderSteps` passes
  `undefined` (`mcp-server.ts:1166`). So the two errors it can raise — `"Cannot
change topology of settled or in-flight parallel group …"` (`:657-668`) and
  `"Cannot move members into or out of settled or in-flight parallel group …"`
  (`:674-688`) — never fire for an MCP caller.
- **The remaining topology mutators have no execution guard at all.**
  `insertParallelGroupSteps` (`:195`), `deleteParallelGroupStep` (`:256`),
  `replaceParallelGroupStep`, and `reorderParallelGroupSteps` are pure
  transforms. `deleteParallelGroupStep` will silently **dissolve** a group that
  drops below two members (`:267-271`).

### The blast radius today

Concretely, for a member at `startIndex + 1` that is mid-flight, via MCP:

- `edit_step` passes both checks (`index > currentIndex`, no `completedAt`) and
  edits a step a worker is executing.
- `remove_step` passes and deletes it; if the group drops to one member it also
  dissolves the group out from under the coordinator.
- `reorder_steps` passes, with the group-aware predicate unreachable.

Three downstream facts turn that from untidy into corrupting:

1. `executeParallelGroup` builds `pendingIndices` **once at entry** as fixed
   absolute integers (`WorkflowExecutor.ts:758-793`), and `runMember` re-reads
   `this.promptQueue.getState().steps[stepIndex]` at dispatch (`:835`). A splice
   that shifts indices hands a live worker **the wrong step object under the
   right index**.
2. `workerCount` is fixed at fork (`:908-914`) from `preflight.effectiveWidth`,
   so nothing appended later is ever picked up.
3. The join passes the **fork-time** `group` object (`:970`), so
   `commitParallelGroupJoin` writes a stale `endIndex + 1` into `currentIndex`
   and its range filter (`PromptQueue.ts:926-931`) drops or mis-attributes
   settlements for anything outside the old bounds.

**Why nothing has broken yet.** The `EXECUTION_ROOT_COORDINATION_PLAN.md`
Decision 8 group ban refuses the ctrlyoke server to parallel-group members, and
`toolAllowed` (`mcp-server.ts:171-193`) requires an attested run address for the
mutating tools — so no attested caller with those tools can currently exist
alongside a live group. The safety is entirely in the ban, not in the guards.

One hole in that: in `mcpAvailability: "disabled"` mode the ban does not fire,
and `skillsForPrompt` (`HarnessIntegration.ts:69-91`) only _omits the skill
document_ from a group member's prompt. Nothing stops an agent that knows the
CLI shape from calling `node out/mcp-server.js --tool edit_step` anyway. Narrow —
it needs a group member ignoring its instructions — but it is a real path from a
prompt to a corrupted group, and Stage 1 is what closes it properly.

---

## Decision 1 — "Started" becomes a real per-step signal, not an index comparison

The fix is not to teach each guard about parallel groups. It is to replace the
proxy with the fact, after which no guard needs group awareness at all: a
sequential step and a group member are both just steps that have or have not
started.

### The data is nearly there, but is not usable as-is

`PromptRuntimeMetadata.startedAt` already exists (`CtrlYokeTypes.ts:921`) and is
already persisted. **It cannot be used for this without a change**, for two
reasons:

- It is typed **required** (`startedAt: number`), so "is it present" is not a
  meaningful question to the type system.
- `PromptQueue.persistRuntimeMetadata` (`:1335-1351`) defaults it on _any_
  metadata write: `{ startedAt: Date.now(), ...step._runtime, ...updates }`. It
  therefore records "some runtime metadata was written", not "this step began
  executing". In practice today every such write happens during execution, so
  the values are right by accident rather than by construction — which is
  exactly the kind of thing that stops being true the first time someone
  persists resolved properties at queue time.

So: **add an explicit marker** rather than reinterpreting `startedAt`. The
recommended shape is a dedicated optional `_runtime.dispatchedAt`, written once
at member dispatch and never defaulted. An alternative is to make `startedAt`
optional and strip the default, which is tidier but touches every existing
reader (`PromptQueue.ts:1142-1143`, `:1174`); a new field can land without
auditing those. Either way the requirement is the same: **one field, written at
exactly one place, meaning exactly "a worker has picked this step up."**

The write belongs in `runMember` beside `running.set(stepIndex, target)`
(`WorkflowExecutor.ts:831`) and on the equivalent sequential dispatch path, so
that the in-memory `running` map — currently a closure variable no guard can
reach (`:800`) — gains a persisted, queryable twin.

### The guards then collapse

```ts
function hasStarted(step: WorkflowStep): boolean {
  return (
    step?._runtime?.dispatchedAt !== undefined ||
    step?._runtime?.completedAt !== undefined
  );
}
```

Both `assertEditableDuringExecution` implementations become `hasStarted(steps[index])`,
and the `index < currentIndex` / `index === currentIndex` arithmetic goes away.
`completedAt` stays in the predicate as a belt-and-braces term for steps
recovered from an older working file that has no `dispatchedAt`.

This is strictly **more** permissive in one direction and **more** restrictive
in the other, and both changes are correct:

- A pending member of a running group at `startIndex + 3` becomes editable —
  it genuinely has not started, and the user's rule says it should be.
- A running member at `startIndex + 1` becomes immutable — it genuinely has
  started, and today it is not protected at all.

### Working-file compatibility

A working file written before this ships has no `dispatchedAt` on any step, so
recovery must not treat every step as un-started. `getCurrentIndexFromRuntime`
(`PromptQueue.ts:2438-2443`) already reconstructs the execution head from the
first step lacking `completedAt`; the same pass should backfill `dispatchedAt`
for every step at or before that head. Pre-release means no persisted-format
compatibility obligation, but a recovered _in-progress_ run is a live scenario
and must not become mutable on reload.

---

## Decision 2 — The group's worker plan is addressed by identity, not position

Decision 1 makes it safe to _forbid_ mutating a started member. It does not make
it safe to _allow_ mutating an un-started one, because `pendingIndices` holds
absolute integers and `runMember` resolves them positionally at dispatch. Remove
a pending member at `startIndex + 2` and every later member's integer now points
at a different step.

This is why `RUN_DISPATCH_MENU_PLAN.md` restricts its relaxation to **appends at
`endIndex + 1`** and keeps rejecting reorder/remove/move: an append is the one
mutation that shifts nothing already planned. That restriction is correct and
should stay until this decision lands.

The fix is to key the group's pending set by step identity. `WorkflowStep`
already carries a stable `id`, so:

- `ParallelGroupRun` (the extraction `RUN_DISPATCH_MENU_PLAN.md` Stage 3 calls
  for) holds `pendingIds: string[]` rather than `pendingIndices: number[]`.
- `runMember` resolves `id → current index` at dispatch and skips an id that no
  longer resolves — which is exactly the correct behaviour for a member removed
  while pending.
- The group's bounds are re-read at the join rather than captured at fork
  (`WorkflowExecutor.ts:970`), which `RUN_DISPATCH_MENU_PLAN.md` Stage 3 already
  requires for late join and which this plan needs for the same reason.

Only after this is the user's full rule expressible: a pending member anywhere
in a live group can be removed or reordered, and the running members are
unaffected.

---

## Decision 3 — Every mutation path routes through one predicate

There are currently three partly-overlapping implementations of "may I change
this step": `PromptQueue.assertEditableDuringExecution`,
`RunContinuationService.assertEditableDuringExecution`, and the
`immutableGroupIds` fold in `ParallelGroupTopology`. They disagree —
`RunContinuationService` checks `completedAt` and `PromptQueue` does not; the
topology fold checks group-level settledness that neither of the others sees;
`reorderPendingPrompts` has a fourth rule of its own.

Once Decision 1 lands, they should all consume one exported predicate
(`hasStarted`, plus a `assertStepMutable(step, operation)` wrapper carrying the
message). The topology fold keeps its group-level role — a group is
topology-frozen if _any_ member has started, which is a different and still
correct question — but it should derive "has started" from the same function
rather than from `startIndex < currentIndex`.

The guard is then also the right place to give the MCP tools a real error. Today
`append_step` is the only tool with any parallel-aware message
(`mcp-server.ts:933-937`, and it only rejects _creating_ a group). After this,
`edit_step` / `remove_step` / `reorder_steps` against a running member fail with
`"Cannot edit a step that is already running"` instead of silently succeeding.

---

## Decision 4 — `resolveQueueInsertIndex` should say what it did

Adjacent, cheap, and worth folding in because it is the same class of bug:
silent relocation.

During a group, `position: "next"` resolves to `currentIndex + 1`
(`DashboardConstants.ts:2132-2145`), which lands inside the group, and
`resolveParallelGroupInsertIndex` (`ParallelGroupTopology.ts:136-162`) then
pushes it out to `endIndex + 1`. So "next" silently means "after the entire
group". The relocation itself is correct and should stay — it is what keeps
`RUN_NEXT` from corrupting a running group — but the caller is never told. The
`append_step` response reports the final index (`mcp-server.ts:1046`) with no
explanation, and an agent that asked for "next" has no way to learn its step
will run several members later.

Add a relocation note to the append response (`"requested next; placed after
parallel group <id>"`). No behaviour change, and it turns a silent surprise into
something an agent can reason about.

---

## Implementation stages

Stages 1–3 are the prerequisite for `RUN_DISPATCH_MENU_PLAN.md` Stage 3/4.
Stage 4 is independent and can land any time after Stage 1.

**Stage 1 — The started marker.** `_runtime.dispatchedAt`, written at
`runMember` dispatch and the sequential equivalent; `hasStarted` predicate;
recovery backfill. No guard changes yet — land the signal and assert it is
written for every dispatch path first.

**Stage 2 — Repoint the guards.** Both `assertEditableDuringExecution`
implementations, `reorderPendingPrompts`, and the `immutableGroupIds` fold
consume `hasStarted`. MCP tools gain real errors for started members. This is
the stage that closes the live hole: after it, a group member cannot mutate its
own running siblings even in disabled mode.

**Stage 3 — Identity-keyed worker plan.** `pendingIds` in `ParallelGroupRun`,
id-resolving dispatch, join reads current bounds. Shares the `ParallelGroupRun`
extraction with `RUN_DISPATCH_MENU_PLAN.md` Stage 3 — whichever lands first owns
it.

**Stage 4 — Relocation transparency.** The `resolveQueueInsertIndex` note in the
append response.

**Stage 5 (optional, gated on Stages 2–3) — Revisit the coordination ban.**
With the guards real, `EXECUTION_ROOT_COORDINATION_PLAN.md`'s reason for denying
step-mutating tools to group members weakens considerably: the coordinator's
join is protected by the guard rather than by the absence of the tools. Whether
to relax it is a separate judgement — a group member appending steps to its own
workflow is still a design smell even when it is safe — but it should be decided
on those merits rather than inherited from a guard that could not see parallel
execution.

---

## Edge cases

- **A member that crashed before writing `dispatchedAt`.** Recovery sees an
  un-started step and reschedules it. Correct — that is precisely what should
  happen to a member the worker never picked up.
- **Recovered run from a pre-`dispatchedAt` working file.** Backfilled at load
  from the `completedAt` boundary (Decision 1). Steps after the head are treated
  as un-started, which matches what `getCurrentIndexFromRuntime` already
  concludes.
- **`maxParallelSteps: 1`.** Members run strictly in sequence inside the group,
  so exactly one has `dispatchedAt` without `completedAt` at a time — the guards
  behave identically to the sequential case with no special handling.
- **A disabled step inside a group.** Never dispatched, so never marked, so
  stays mutable. Matches `pendingIndices`'s existing skip (`WorkflowExecutor.ts:758-793`).
- **Retries.** A retried step already has `dispatchedAt` from its first attempt
  and stays immutable across the retry, which is correct — the user cannot edit
  a step between attempts today either.
- **`pendingRewind`.** Both guards short-circuit on it before any other check
  (`PromptQueue.ts:2494`, `RunContinuationService.ts:731`). Rewind deliberately
  un-runs steps, so it must clear `dispatchedAt` for everything it rewinds or
  the rewound steps stay permanently frozen.
- **Removing the last pending member of a two-member group.** Still dissolves
  the group (`ParallelGroupTopology.ts:267-271`), but now only when that member
  has not started. Whether dissolution or rejection is right for a _running_
  group with one pending member is an open question below.
- **`replaceStep` on a started step.** Currently guarded by the same
  `assertEditableDuringExecution` call (`PromptQueue.ts:2145`), so it inherits
  the fix with no separate work.

---

## Test strategy

- `src/test/unit/PromptQueue.test.ts`: a pending member of a running group is
  editable; a dispatched member is not; the error names the operation. Assert
  specifically at `startIndex + 1`, the index the old guard got wrong.
- `src/test/unit/RunContinuationService.test.ts`: the MCP path rejects
  `edit_step` / `remove_step` / `reorder_steps` against a dispatched member, and
  permits them against a pending one.
- `src/test/unit/ParallelGroupTopology.test.ts`: the `immutableGroupIds` fold
  derives from `hasStarted`; a group with one dispatched member is
  topology-frozen even when `currentIndex` still equals its `startIndex`.
- `src/test/unit/WorkflowExecutor.*`: removing a pending member mid-fan-out
  drops it from the plan without disturbing running members; the join reads
  current bounds.
- `src/test/integration/`: a recovered pre-`dispatchedAt` working file does not
  become mutable on reload; a rewind restores mutability.

---

## Not in scope (YAGNI)

- Making `startedAt` optional and auditing its existing readers. A new field
  avoids the churn; revisit only if the two fields prove confusing.
- Any change to what `currentIndex` means or when it advances. It remains the
  execution head and the join's business; this plan only stops guards from
  treating it as a per-step started marker.
- DAG scheduling, `dependsOn`, partial joins, nested groups — unchanged from
  `PARALLEL_STEPS_PLAN.md`.
- Surfacing per-member started state in the dashboard. `activeStepIndices`
  already carries it for presentation (`IDashboardSink.ts:43`) and is
  deliberately not a guard input.

---

## Open questions

1. **Dedicated `dispatchedAt` or optional `startedAt`?** Recommended:
   `dispatchedAt`, because it can land without auditing existing readers and
   because the two concepts genuinely differ (one metadata write vs. a worker
   pickup). Revisit if carrying both proves confusing in the working file.
2. **Removing the last pending member of a running two-member group.** Dissolve
   the group (current behaviour, extended), or reject the removal? Dissolution
   mid-run means the remaining member's outcome is attributed to an ungrouped
   step whose group snapshot was taken as a group. Leaning reject, but no usage
   data yet.
3. **Does Stage 5 actually want to happen?** Making the guards real removes the
   _correctness_ argument for the coordination ban, not the _design_ argument.
   Deliberately left open.
