# Parallel Step Mutability Plan

> **Status:** Implemented 2026-09-14. Stages 1–5 are shipped and covered by
> unit, integration, and caller-contract tests.
>
> **Prerequisite for:** [`RUN_DISPATCH_MENU_PLAN.md`](./RUN_DISPATCH_MENU_PLAN.md).
> That plan's Decision 1 ("Run in Parallel") appends a member to a group that is
> already executing. Stages 1–3 below are the safety boundary that must land
> before a late join or general mutation from a parallel member is enabled.
>
> **Depends on:** [`PARALLEL_STEPS_PLAN.md`](./PARALLEL_STEPS_PLAN.md)
> (shipped) for the fork/join model this plan hardens.
>
> **Related:** [`EXECUTION_ROOT_COORDINATION_PLAN.md`](./EXECUTION_ROOT_COORDINATION_PLAN.md)
> (shipped). Its Decision 8 currently withholds step-mutating tools from
> parallel-group members because the mutation guards and executor cannot safely
> observe a changing live group. Stage 5 deliberately removes that ban after the
> underlying invariants are real.
>
> **Follow-up:** [`MCP_PARALLEL_APPEND_PLAN.md`](./MCP_PARALLEL_APPEND_PLAN.md)
> owns the `append_step` contract for enqueueing future `parallel:` containers
> and joining the active group through MCP. This plan supplies its safety model.
>
> **Build order:** [`PARALLEL_MUTATION_ROLLOUT_PLAN.md`](./PARALLEL_MUTATION_ROLLOUT_PLAN.md)
> stages this plan against the other two — Stages 1–3 are its Phase 1, Stage 4 its
> Phase 2, and Stage 5 its Phase 8.

---

## The rule this plan implements

> **Permission follows the target, not the caller. A step that has started is
> immutable. A step that has not started may be edited or removed, including
> when the caller is itself a parallel-group member, provided the mutation does
> not move a started step or invalidate a live group's topology.**

This separates three questions that the current index checks conflate:

1. **May this caller use workflow-mutation tools?** Yes for an attached,
   run-addressed parallel member once Stages 1–3 have landed.
2. **May this particular step change?** Only before the executor claims it for
   dispatch.
3. **May this structural mutation change a live group?** Only within the narrow
   rules in Decision 3; the controlled late-join path in
   `RUN_DISPATCH_MENU_PLAN.md` remains the only way to add a member to the active
   group.

Every mutation guard is currently trying to approximate the second question
with an index comparison:

```ts
index < currentIndex; // "already started"
index === currentIndex && hasInFlightStep; // "currently executing"
```

That substitution is exact for a sequential queue, where exactly one step runs
and `currentIndex` advances past each one as it settles. It is wrong for every
parallel-group member after the first.

## Why it is wrong: `currentIndex` is frozen for the whole group

Mid-group settlements go through `PromptQueue.persistStepOutcome`, which
applies the outcome and writes the working file but never touches
`currentIndex`. `currentIndex` moves exactly once per group, in
`commitParallelGroupJoin`:

```ts
this.state.currentIndex = Math.max(this.state.currentIndex, group.endIndex + 1);
```

For the entire lifetime of a running group,
`currentIndex === group.startIndex`. Members at
`startIndex + 1 ... endIndex` are all `> currentIndex`, which the current guards
read as "pending, freely mutable" even while workers are executing them.

### What the guards actually check

| Guard                                                             | Location                                           | Predicate                                                               | Group-aware?                                       |
| ----------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------- |
| `PromptQueue.assertEditableDuringExecution`                       | `src/core/PromptQueue.ts`                          | `index < currentIndex`; `index === currentIndex && hasInFlightStep`     | No                                                 |
| `RunContinuationService.assertEditableDuringExecution` (MCP path) | `src/core/orchestration/RunContinuationService.ts` | Same, plus `completedAt`                                                | No                                                 |
| `PromptQueue.reorderPendingPrompts`                               | `src/core/PromptQueue.ts`                          | `hasInFlightStep && newPendingOrder[0] !== 0`                           | No; assumes one in-flight step at slice position 0 |
| `reorderPendingTopologyWithRanges`                                | `src/core/ParallelGroupTopology.ts`                | freezes a group from `currentIndex`, `completedAt`, and in-flight state | Partly; it cannot identify every running sibling   |

`PromptQueue.assertEditableDuringExecution` is used by insert, edit, replace,
and delete. Reorder has separate guards. The MCP reorder route also omits its
`pendingGroups` argument, so the range-aware branch is not the protection it
appears to be.

### The blast radius today

For a member at `startIndex + 1` that is mid-flight, an MCP mutation would
currently pass the target guard. If the existing caller-level ban were removed:

- `edit_step` could replace properties while a worker is executing the old
  definition.
- `remove_step` could delete it and possibly dissolve its group.
- `reorder_steps` could renumber it while targets, outcomes, terminal sessions,
  events, and coordination identity still refer to the old absolute index.

The executor compounds that risk:

1. `executeParallelGroup` builds `pendingIndices` once at entry and resolves a
   step again by absolute index at dispatch.
2. `preflightMembers` is also built once at entry. Editing an unstarted member
   would not affect the resolved harness, session, execution mode, variables,
   or prompt that the worker later uses.
3. `workerCount` is fixed at fork, so a late member is not discovered.
4. The join receives the fork-time `group` object, so a changed `endIndex`
   produces a stale advance and range filter.
5. `PromptQueue.mergeDiskSteps` preserves memory runtime/results only through
   an index-derived execution head. It cannot reconcile multiple running
   siblings after an external reorder or removal.

The current safety comes from the caller-level ban in
`ParallelGroupPreflight`, `mcp-server.ts`, and the skill projection in
`HarnessIntegration`, not from the mutation paths themselves.

---

## Decision 1 — Started state and queue identity become explicit runtime facts

The guards need the fact "a worker claimed this logical step", while the
executor needs an identity that survives edits and reorder. Neither is
available cleanly today.

### Started state

`PromptRuntimeMetadata.startedAt` already exists and is persisted, but it is
typed required and `PromptQueue.persistRuntimeMetadata` invents it on every
metadata write:

```ts
{ startedAt: Date.now(), ...step._runtime, ...updates }
```

That makes it mean "some runtime metadata was written", not "the executor
claimed this step". Make `startedAt` optional, remove the default, and write it
only through the dispatch claim described below. The shared predicate is then:

```ts
function hasStarted(step: WorkflowStep): boolean {
  return (
    step._runtime?.startedAt !== undefined ||
    step._runtime?.completedAt !== undefined
  );
}
```

`completedAt` remains a compatibility and corruption backstop. Do not add a
separate `dispatchedAt`: it would represent the same transition and create two
nearly identical timestamps after the runtime type has already been audited for
pre-dispatch identity.

### Stable run-scoped step identity

The previous draft assumed `WorkflowStep` already had a stable `id`. It does
not: the `id` on `ParallelGroupDefinition` identifies the group, not its
members. Add an internal `_runtime.stepId` generated once per queue step for a
promoted run. It is:

- assigned to all queue steps when a working run is created;
- assigned to every step inserted by the UI, file append, MCP, or late join;
- preserved by edit, replace, reorder, rewind, and recovery;
- unique within the run and never reused after deletion; and
- stripped with the rest of `_runtime` from authored Save As/export output, so
  it requires no workflow-schema property.

Centralize generation, backfill, uniqueness validation, and lookup in one
helper rather than teaching each append path to mint IDs independently.
`PromptRuntimeMetadata.startedAt` must be optional because a legitimate
`_runtime` object containing `stepId` exists before the step starts.

### Dispatch is an atomic claim

Writing the marker after `running.set(...)` still leaves a time-of-check /
time-of-use window: an external mutation can acquire the working-file lock,
observe no marker, and remove the step before the executor flushes it.

Add one queue/working-file operation that, under the same file lock used by
`RunContinuationService`:

1. merges the latest disk definition;
2. resolves `stepId` to its current index;
3. refuses a missing, terminal, or already-claimed step;
4. writes the started marker without bumping `definitionRevision`; and
5. returns the claimed step, current index, and definition revision to the
   executor.

Both sequential dispatch and `ParallelGroupRun` use this operation. The step is
not placed in the executor's running map and no process is launched until the
claim succeeds. A mutation that wins the lock first is honored and the missing
ID is skipped; a claim that wins first makes every later mutation reject it.

### Recovery

On recovery, assign missing `stepId`s to all surviving queue steps. Existing
`startedAt` values already identify old-file dispatches, including group members
after `currentIndex`; do not infer started membership merely from
`index <= currentIndex`, because that recreates the original bug. A terminal
`completedAt` without `startedAt` is still treated as started. A step with
neither is pending and can be scheduled again.

Rewind preserves `stepId` but clears the started marker and all terminal runtime
for the rewound suffix. The same helper must be used by every rewind path.

---

## Decision 2 — The group run is keyed by step identity and resolves at dispatch

`ParallelGroupRun` (the extraction shared with
`RUN_DISPATCH_MENU_PLAN.md` Stage 3) owns the mutable lifetime of one active
group. Its collections are keyed by `_runtime.stepId`, not absolute indices:

- `pendingIds: string[]` replaces `pendingIndices`.
- running membership and outcomes are keyed by ID; the current absolute index
  is retained only as the dispatch/event projection.
- a worker resolves and atomically claims an ID immediately before dispatch;
  an ID removed while pending simply no longer resolves.
- the join re-reads the group by group ID and its current bounds rather than
  retaining the fork-time object.

Started steps remain **index anchors** for this plan. Before committing any
structural mutation, a shared validator compares the before/after topology and
requires every started/terminal `stepId` to remain at the same absolute index.
That keeps existing manifest, timeline, PTY, snapshot, and coordination
attribution correct without widening this plan into a repository-wide event
format migration. Identity makes pending work mutable; it does not authorize
renumbering already-started work.

### Preflight must follow the mutable definition

The current `preflightMembers` map freezes resolved properties for all members
at group entry. A pending member edited after that point would execute the old
resolution. Split preflight into:

- group admission checks that are invariant for the group run; and
- per-member preflight performed after the atomic claim, using the current step
  definition and current running-member reservations.

The per-member path owns variable substitution, resolved harness/model/mode,
session collision checks, interactive capacity, integration isolation, and any
late-join checks from `RUN_DISPATCH_MENU_PLAN.md`. A rejected member receives a
normal failed settlement and does not poison healthy siblings unless the
group's `failFast` policy says it should.

This is required for edits as well as late joins. Merely invalidating a cached
entry on an in-process mutation is insufficient because MCP mutations arrive
from another process.

---

## Decision 3 — One target predicate and explicit live-topology rules

There are currently several overlapping meanings of "may I change this step":
the two `assertEditableDuringExecution` implementations, the reorder head
check, and the `immutableGroupIds` fold in `ParallelGroupTopology`. Replace
them with shared primitives:

- `hasStarted(step)` — one runtime fact;
- `assertStepMutable(step, operation)` — target-level error policy; and
- `assertStartedStepPositionsPreserved(before, after, operation)` — structural
  index-anchor validation.

The in-process queue and `RunContinuationService` must call the same exported
helpers. A parallel caller receives the same error as any other caller, for
example `Cannot edit a step that has already started`.

The active group's topology follows these rules:

- Editing/replacing an unstarted member in place is allowed.
- Reordering unstarted members within the active group's existing member slots
  is allowed when all started positions stay fixed.
- Removing an unstarted member is allowed when no started position shifts and
  at least two group members remain.
- Generic insert/reorder cannot move a step into or out of the active group.
  `resolveParallelGroupInsertIndex` continues to push ordinary inserts after
  the group.
- Adding a member to the active group is reserved for the explicit late-join
  operation, which updates `ParallelGroupRun` before returning success.
- `failFast`, group ID, and the before-snapshot identity are frozen once any
  member starts.
- Future, wholly unstarted groups remain ordinary editable topology.

This replaces the current all-or-nothing `immutableGroupIds` fold. A group with
one started member is not wholly immutable, but its identity, policy, started
anchors, and minimum cardinality are.

`reorder_steps` does not need to accept a second topology description merely to
preserve current membership. The reorder transform can carry each existing
member's group ID with its `stepId`, reject membership changes for the active
group, and continue treating future groups as blocks unless a topology-aware UI
request explicitly supplies ranges.

---

## Decision 4 — Queue insertion reports relocation

During a group, `position: "next"` resolves to `currentIndex + 1`, which lands
inside the group, and `resolveParallelGroupInsertIndex` pushes it to
`endIndex + 1`. The relocation is correct but currently silent.

Return structured placement information from the single insert resolver, for
example:

```ts
{
  requestedIndex,
  insertedIndex,
  relocation: { kind: "afterParallelGroup", groupId }
}
```

The MCP response can then say `requested next; placed after parallel group
<id>`. The same result is reusable by UI toasts and the late-join path; callers
must not reverse-engineer relocation by comparing integers.

---

## Decision 5 — Parallel members may mutate their attached workflow

Yes: once Stages 1–3 make target guards, identity, dispatch, merge, and join
safe, remove the blanket caller-level ban. This is the intended policy, not an
optional follow-up.

The motivating pattern is a parallel orchestrator: one group member implements
the current phase while another inspects the repository and adjusts future work.
It is the concurrent form of
[`spec-driven-loop.ctrlyoke.yaml`](../../src/templates/workflows/spec-driven-loop.ctrlyoke.yaml),
whose plan/review agent already uses `append_step`, `edit_step`, `remove_step`,
and `reorder_steps` to steer a sequential queue. The orchestrator's own started
step and its running sibling remain protected; future work does not become
immutable merely because the caller happens to be in a group.

### Permission changes

After the safety stages land:

- remove the dynamic-queue rejection from `ParallelGroupPreflight`;
- allow `MCP_WORKFLOW_MUTATION_TOOL_NAMES` for an attached group member in both
  filtered `ListTools` and `CallTool` authorization;
- stop removing `MCP_SKILL_NAMES.TOOLS` from skill-mode parallel prompts in
  `HarnessIntegration.skillsForPrompt`; and
- update the now-stale "parallel groups ban mutation" comments around
  `ctrlYokeToolFamilies` while retaining `deniedTools` as the user's explicit
  way to remove any tool family.

This does **not** grant workflow mutation to unattached external participants,
does not bypass run-address validation or optimistic revision checks, and does
not make coordination attestation a security boundary. It only removes
`groupMember` as a reason to reject an otherwise valid attached workflow tool.

Every call still runs through `RunContinuationService` under the working-file
lock and definition revision protocol. Concurrent siblings may race; one
serialized mutation wins, and the other evaluates against the resulting latest
definition rather than overwriting it.

Permission alone does not realize the complete example because `append_step`
currently rejects `parallel:` input. The MCP input and live-join protocol are
specified separately in `MCP_PARALLEL_APPEND_PLAN.md`; keeping that adapter
contract there avoids mixing it into the executor safety stages here.

---

## Implementation stages

Stages 1–3 are the prerequisite milestone for
`RUN_DISPATCH_MENU_PLAN.md` Stages 3–5 and for the permission relaxation here.

**Stage 1 — Honest runtime identity and atomic dispatch claim — complete.** Make
`PromptRuntimeMetadata.startedAt` optional, remove the implicit default, add
`_runtime.stepId`, centralize ID assignment/backfill/lookup, and add the locked
claim-by-ID operation. Use it for sequential and parallel dispatch. Rewind
preserves IDs and clears execution state. Land tests proving every dispatch
path claims before launch.

**Stage 2 — Repoint every guard and disk merge — complete.** Introduce the shared target
and structural validators; use them from `PromptQueue`,
`RunContinuationService`, reorder, and topology transforms. Reconcile external
working-file changes by `stepId`, preserving in-memory runtime/results for every
matching started member rather than only an index prefix. This stage closes the
current live safety hole even while the caller-level group ban remains.

**Stage 3 — Identity-keyed mutable group run — complete.** Extract `ParallelGroupRun` with
`pendingIds`, ID-keyed running/outcomes, current-bound join, and per-member
dispatch-time preflight. Implement the active-group edit/remove/reorder rules,
including the two-to-one deletion rejection. This is the executor foundation
shared with late join.

**Stage 4 — Placement transparency — complete.** Return structured placement/relocation
from the insert resolver and include it in MCP mutation responses.

**Stage 5 — Permit parallel callers — complete.** Removed all three caller-level
mutation bans and updated generated tool documentation and diagnostics. Native
MCP and MCP-as-skill expose the same effective tools, and the richer append
contract is shipped on this permission boundary.

---

## Edge cases

- **A member disappears before its claim.** Claim-by-ID returns no target and
  the worker skips it. It is not reported as a cancelled execution because it
  was intentionally removed from the definition.
- **A claim wins before a competing mutation.** The started marker is durable
  under the same lock; edit/remove/reorder rejects the target.
- **Recovered old working file.** Missing `stepId`s are backfilled. Existing
  `startedAt` or `completedAt` values preserve immutability for all group
  members, not just the execution head.
- **`maxParallelSteps: 1`.** Exactly one member is claimed at a time. Later
  members remain mutable until a worker slot claims them.
- **Disabled member.** Before group admission it is mutable. Once the executor
  records its skipped terminal outcome, `completedAt` makes it an immutable
  attribution anchor even though no harness process launched.
- **Retries.** A retried step keeps its first claim timestamp and stays
  immutable across attempts.
- **Pending rewind.** IDs survive; started/terminal fields in the rewound suffix
  are cleared. Prefix guards remain in force.
- **Deleting a pending member from an active group.** Allowed only if no started
  index shifts and at least two members remain. The group run drops the ID from
  its pending set after the definition revision is observed.
- **Deleting from two members to one.** Rejected while the group is active or
  has any terminal member. Dissolving it would orphan the live group's snapshot,
  coordination identity, fail-fast policy, output projection, and join contract.
- **Editing a pending member's harness/session/mode.** Dispatch-time preflight
  uses the new definition and current reservations; no fork-time resolution is
  reused.
- **Two orchestrators mutate concurrently.** The file lock serializes writes.
  Each operation validates the definition it actually read; neither performs a
  blind last-write-wins overwrite.
- **Ordinary `next` append during a group.** Lands after the group and reports
  why. It does not join.
- **Late join.** Uses the dedicated group operation from
  `RUN_DISPATCH_MENU_PLAN.md`, updates the live `ParallelGroupRun`, and is not
  expressible accidentally through an ordinary queue append. MCP exposure is
  specified in `MCP_PARALLEL_APPEND_PLAN.md`.
- **Stop/fail-fast with pending IDs.** Resolve remaining IDs before recording
  cancellation. Removed IDs receive no fabricated settlement; surviving
  unclaimed members follow the existing stop/fail-fast policy.
- **Join after shrink or growth.** Re-read the group by ID. A missing group is a
  corruption error, never an instruction to use fork-time bounds.
- **Save As.** Runtime IDs and timestamps are stripped. A topology mutation that
  really changed authored grouping remains visible as ordinary `parallel:` YAML.

---

## Test strategy

- `src/test/promptQueue.test.ts` (the PromptQueue suite is at the `src/test/`
  root, not under `src/test/unit/`)
  - every sequential/parallel claim writes the marker before launch;
  - a pending sibling is editable and a claimed sibling after `startIndex` is
    not;
  - a structural mutation cannot shift any started `stepId`;
  - rewind keeps IDs and restores suffix mutability.
- `src/test/unit/RunContinuationService.test.ts`
  - MCP edit/remove/reorder uses the same shared errors;
  - two locked mutations serialize without lost updates;
  - old-file ID backfill and definition revision remain atomic;
  - ordinary `next` append returns its group relocation.
- `src/test/unit/ParallelGroupTopology.test.ts`
  - unstarted members can reorder within live-group slots;
  - safe shrink works, two-to-one shrink rejects, started anchors never move;
  - generic inserts cannot acquire active-group membership.
- `src/test/unit/WorkflowExecutor.*`
  - removal drops a pending ID without disturbing running members;
  - an edited pending member is freshly preflighted and executes the edit;
  - session/interactive conflicts introduced by an edit fail at dispatch;
  - join reads current bounds; stop, pause, retry, and fail-fast settle by ID;
  - a mutation/claim race has deterministic lock-order outcomes.
- `src/test/unit/ParallelGroupPreflight.test.ts`
  - workflow mutation tools no longer produce the dynamic-queue diagnostic
    after Stage 5; explicit `deniedTools` still removes them.
- `src/test/unit/McpServer.test.ts` and `McpToolSkillGenerator.test.ts`
  - attached group members list and invoke mutation tools in native and skill
    modes;
  - unattached external callers remain denied.
- `src/test/integration/`
  - a two-member implementation/orchestrator group appends, edits, and removes
    flat future work and joins without stale indices;
  - output, snapshot, PTY, and coordination attribution stay attached to the
    started members after pending mutations;
  - recovery schedules only surviving unclaimed IDs.

---

## Not in scope (YAGNI)

- Changing the persisted meaning of `currentIndex`; it remains the execution
  head and advances once at group join.
- Migrating manifest/events/PTY messages from index attribution to step IDs.
  Started-index anchors are the boundary that avoids that expansion.
- Defining how MCP requests enqueue a future group or invoke the explicit
  Run-in-Parallel operation; that belongs to `MCP_PARALLEL_APPEND_PLAN.md`.
- Editing `failFast`, group identity, or snapshot policy after a member starts.
- Nested groups, DAG scheduling, `dependsOn`, partial joins, per-member
  worktrees, or implicit sibling-output reads.
- Shipping the parallel variant of `spec-driven-loop.ctrlyoke.yaml`; implement
  and dogfood it after the mutation engine lands.

---

## Settled decisions

1. **`startedAt` is the dispatch-claim marker.** Make it optional and honest,
   remove its implicit default, and do not add `dispatchedAt`. This yields one
   timestamp with one meaning while allowing `_runtime.stepId` to exist before
   dispatch.
2. **A live or historically started parallel group never shrinks below two
   members.** Reject removal of the last pending member from a two-member group
   once any member has started or settled. A later draft cloned without runtime
   metadata can dissolve the authored group normally; the historical run cannot.
3. **Parallel members may call workflow-mutation tools after Stages 1–3.** The
   guard evaluates the target step and resulting topology rather than
   distrusting the caller class. Stage 5 removes the current preflight,
   native-MCP, and skill-mode bans together. `MCP_PARALLEL_APPEND_PLAN.md`
   expands `append_step` without weakening those target guards.
