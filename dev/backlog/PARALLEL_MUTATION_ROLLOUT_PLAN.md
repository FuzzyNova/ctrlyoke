# Parallel Mutation Rollout — Staging Plan

> **Status:** Track C / Phase 3A complete. The queue-item union remains
> unpublished until Phase 3B; later rollout work remains backlog.
>
> **What this is:** the build order for three design plans that must ship
> together, sliced into nine phases and six workflow tracks that can be handed
> to independent spec-driven loops.
>
> **It coordinates, it does not replace:**
>
> - [`PARALLEL_STEP_MUTABILITY_PLAN.md`](./PARALLEL_STEP_MUTABILITY_PLAN.md) — "Mut"
> - [`RUN_DISPATCH_MENU_PLAN.md`](./RUN_DISPATCH_MENU_PLAN.md) — "Disp"
> - [`MCP_PARALLEL_APPEND_PLAN.md`](./MCP_PARALLEL_APPEND_PLAN.md) — "MCP"
>
> Those three remain authoritative for _what_ to build and _why_. This document
> is only _when_, _in what order_, and _in which checkout_. Where they disagree
> with this file about behavior, they win; where they disagree about ordering,
> this file wins.

---

## Decision — run the tracks as separate workflows, not as parallel steps

The tempting shape is one workflow whose queue contains a `parallel:` container
with two orchestrator members. **Do not do that.** Three reasons, in descending
order of how hard they block:

### 1. A parallel group member cannot call `append_step` today

The spec-driven loop's entire mechanism is a `finalStep` orchestrator that calls
`append_step` / `edit_step` / `remove_step` / `reorder_steps` to grow its own
queue. Those four tools are exactly `MCP_WORKFLOW_MUTATION_TOOL_NAMES`
(`src/utils/McpToolDefinitions.ts:533`), and they are withheld from group
members in three places today:

- `ParallelGroupPreflight.ts:278` rejects a member that requests them;
- `mcp-server.ts:192` filters them out when `context.groupMember` is set;
- the skill projection removes them from skill-mode parallel prompts.

So a spec-driven loop running as a parallel member is not merely risky, it is
**inert** — the orchestrator would plan the work and then have no way to queue
it. Removing that ban is Phase 8 of this very rollout. You cannot use the
feature to build the feature.

### 2. Parallel members share one execution root

`worktree` is a workflow-only property (`workflowOnlyProperties` in
`schemas/workflow-schema.json`; `workflowStep` explicitly forbids it).
Per-member worktrees are declared out of scope in all three plans. Two
implementation agents inside one group therefore edit the same checkout
concurrently — overlapping edits, two `npm test` runs fighting over the same
build output, and a snapshot projection that cannot attribute either.

Separate workflows each get their own `worktree:`, which is real isolation.

### 3. The tracks have different definitions of done

Each track wants its own review loop, its own `finalStep`, and its own queue
depth. One shared `finalStep` reviewing engine work and React work in the same
pass is worse at both.

### What to run instead

One **Spec-Driven Loop instance per track**, each in its own worktree, launched
a wave at a time. Waves are separated by hard merge barriers because the later
waves extend code the earlier waves create.

---

## Wave map

```text
WAVE 1  (3 loops in parallel)
  Track A  engine safety        Phase 1 -> Phase 2
  Track B  dashboard shell      Phase 4
  Track C  MCP contract         Phase 3A
                 |
          === BARRIER 1: merge all three to main ===
                 |
WAVE 2  (2 loops in parallel)
  Track D  executor + topology  Phase 5 -> Phase 6
  Track E  MCP enqueue          Phase 3B
                 |
          === BARRIER 2: merge both to main ===
                 |
WAVE 3  (1 loop, sequential)
  Track F  convergence          Phase 7 -> Phase 8 -> Phase 9
```

Phase numbers are stable identifiers, not execution order — they carry over from
the original nine-phase analysis. Phase 3 splits across waves because its second
half depends on Phase 2.

| Phase | Source stages       | Wave | Track | Title                               |
| ----- | ------------------- | ---- | ----- | ----------------------------------- |
| 1     | Mut 1, Mut 2, Mut 3 | 1    | A     | Safety foundation                   |
| 2     | Mut 4               | 1    | A     | Structured placement                |
| 3A    | MCP 1               | 1    | C     | MCP item union + shared flattener   |
| 3B    | MCP 2               | 2    | E     | Future parallel-group enqueue       |
| 4     | Disp 1, Disp 2      | 1    | B     | Split button + Run in New Workflow  |
| 5     | Disp 3              | 2    | D     | Growable executor / late join       |
| 6     | Disp 4              | 2    | D     | Late-join topology + promotion      |
| 7     | Disp 5, MCP 3       | 3    | F     | Run in Parallel + durable admission |
| 8     | Mut 5               | 3    | F     | Permit parallel callers             |
| 9     | MCP 4               | 3    | F     | End-to-end enablement + dogfood     |

### Release checkpoints

| After   | Ships                                                      |
| ------- | ---------------------------------------------------------- |
| Wave 1  | Nothing user-visible except Run in New Workflow (Phase 4). |
| Wave 2  | Sequential agents can enqueue future `parallel:` groups.   |
| Phase 7 | Users and sequential MCP callers can join the live group.  |
| Wave 3  | Parallel-group agents can mutate future work.              |

Phase 4 is the only wave-1 work that is shippable on its own; Phases 1–3A are
invisible infrastructure. Do not gate a release on them individually.

---

## Wave 1

Three tracks, no dependency between them. Launch all three at once.

### Track A — Engine safety (Phases 1 and 2)

**Owns:** `src/core/PromptQueue.ts`, `src/core/WorkflowExecutor.ts`,
`src/core/ParallelGroupTopology.ts` (existing transforms),
`src/core/orchestration/RunContinuationService.ts`,
`src/core/ParallelGroupPreflight.ts` (the per-member preflight split only —
the caller-level mutation ban at `:278` stays untouched until Phase 8),
`src/types/CtrlYokeTypes.ts` (`PromptRuntimeMetadata`),
`schemas/workflow-schema.json`.

**Phase 1 — Safety foundation.** Mut Stages 1–3, as three separately tested
commits in this order:

1. Make `PromptRuntimeMetadata.startedAt` optional, remove the implicit default
   in `persistRuntimeMetadata`, add `_runtime.stepId` with centralized
   generation/backfill/lookup, and add the lock-held claim-by-ID operation. Both
   sequential and parallel dispatch must claim before launching.
2. Introduce `hasStarted`, `assertStepMutable`, and
   `assertStartedStepPositionsPreserved`; call them from `PromptQueue`,
   `RunContinuationService`, reorder, and the topology transforms. Reconcile
   external working-file changes by `stepId` rather than an index prefix.
3. Extract `ParallelGroupRun` with `pendingIds`, ID-keyed running/outcomes,
   current-bound join, and per-member dispatch-time preflight. Implement the
   active-group edit/remove/reorder rules including the two-to-one deletion
   rejection.

**This track owns the `ParallelGroupRun` extraction.** Track D extends it; it
must not re-extract it. That is the single most important cross-track rule here.

**Phase 2 — Structured placement.** Mut Stage 4. Return
`{ requestedIndex, insertedIndex, relocation }` from the one insert resolver and
surface it in MCP mutation responses. Small, but it must land in wave 1 because
Phase 3B consumes the contract.

**Exit criteria.** `src/test/promptQueue.test.ts` (note the path — there is
no `src/test/unit/PromptQueue.test.ts`),
`RunContinuationService.test.ts`, `ParallelGroupTopology.test.ts`, and
`WorkflowExecutor.*` cover the cases in Mut's test strategy. The caller-level
group ban is still in place and still passing its tests — Phase 1 closes the
_live_ hole underneath it, it does not remove it.

**Do not:** remove any mutation ban (Phase 8), add late join (Phase 5), touch
`src/ui/**`, or touch `src/mcp-server.ts` beyond the Phase 2 response field.

**Schema note:** `schemas/workflow-schema.json` is the source; the `.yaml` is
generated from it by `npm run generate-schema` during `precompile`. Edit the
JSON.

Concretely, `promptRuntimeMetadata` in that file carries
`"required": ["startedAt"]`. Phase 1 must drop it and add an optional `stepId`
property, or every pre-dispatch `_runtime` block fails validation.

#### Track A session split

Track A is staged as six sessions. Stage boundaries from
`PARALLEL_STEP_MUTABILITY_PLAN.md` are preserved; Stages 1 and 2 are each split
in two because their halves are independently testable and too large together.

| #   | Mut stage | Deliverable                                                        |
| --- | --------- | ------------------------------------------------------------------ |
| 1   | 1a        | `_runtime.stepId` identity helper; `startedAt` optional and honest |
| 2   | 1b        | Locked claim-by-ID; every dispatch path claims before launch       |
| 3   | 2a        | Shared `hasStarted` / target / structural validators, all callers  |
| 4   | 2b        | `mergeDiskSteps` reconciles by `stepId`                            |
| 5   | 3         | `ParallelGroupRun` extraction + per-member dispatch-time preflight |
| 6   | 4         | Structured insert placement/relocation (Phase 2)                   |

Session 5 is the one Track D extends. Session 5 also performs the
`preflightParallelGroupMember` split, because Decision 2 needs per-member
resolution for _edits_, not only for the Phase 5 late join.

#### Track A status

Track A (Phases 1 and 2) is complete and ready for Barrier 1. The six sessions
landed stable step identity, lock-held claim-by-ID dispatch, shared mutation
guards, identity-keyed disk reconciliation, the `ParallelGroupRun` extraction,
and structured insert placement. Placement is a plain
`ParallelGroupInsertPlacement` returned by the topology resolver and carried
through the continuation transaction as well as the MCP append response;
`next` still never joins a live group. Track D can consume that result directly
for late-join work, and Track E can extend the MCP response without changing the
insertion transaction.

### Track B — Dashboard shell (Phase 4)

**Owns:** `src/ui/webview-react/components/shared/SplitButton.tsx`,
`components/editor/EditorFooter.tsx`, `components/editor/PromptEditor.tsx`,
`hooks/`, `utils/dropdownUtils`, `src/ui/WebviewMessageRouter.ts`,
`src/ui/WorkflowStepHandlers.ts`, plus `runInNewWorkflowForClient` in
`src/core/WorkflowOrchestrator.ts` and the `forceNewWorkflow` removal in
`src/core/WorkflowInstance.ts`.

**Not in this track:** `src/ui/WebviewSettingsSync.ts` and
`store/settingsStore.ts`. The only reason those files appear in this plan is the
effective-parallel-width field in the lightweight `GlobalSettings` payload, and
that field exists solely to gate **Run in Parallel** — Phase 7 work, listed
under Phase 7 below. Phase 4 must not add it: the width gate has no consumer
until `ACTION_TYPES.RUN_PARALLEL` exists, and shipping an unused settings field
in wave 1 puts a dead payload in front of every client.

**Phase 4 — complete.** Disp Stages 1–2: extract `useAnchoredPopupPosition` shared between
`FooterQuickPicker` and `SplitButton`; add `menuPlacement` / compact size /
`portal` to `SplitButton`; wire the footer split button with "Run in New
Workflow" enabled and the other two items present-but-disabled; implement
`RUN_IN_NEW_WORKFLOW` end to end with pending-PTY-controller registration, view
switch, and toast; delete `forceNewWorkflow`.

**Exit criteria — met.** New
`src/ui/webview-react/test/components/editor/EditorFooter.test.tsx`,
`PromptEditor.test.tsx` updated, and `src/test/unit/WorkflowOrchestrator.test.ts`
proving the previous instance keeps running. `.btn-editor-run` stays on the
**primary** button, and the primary button keeps its `Run` accessible name —
that name, not the class, is what the existing `PromptEditor.test.tsx`
assertions select on, which is why `SplitButton` gained `mainAriaLabel`.

**Do not:** implement Run in Parallel behavior (Phase 7) or Send Steer Message
(owned by `STEER_MESSAGE_PLAN.md`). Both are disabled placeholders with tooltips
in this phase.

**Note:** this track is the only wave-1 work that ships something a user can
see. It is also the least coupled — if you only have capacity for two parallel
loops in wave 1, this is the one to run alongside Track A.

### Track C — MCP contract surface (Phase 3A)

**Owns:** `src/utils/McpToolDefinitions.ts`, `src/utils/McpSchemaValidator.ts`,
`src/utils/McpToolSkillGenerator.ts`, `src/core/PromptFileParser.ts`, and a
**new, appended** flattener in `src/core/ParallelGroupTopology.ts`.

**Phase 3A status:** MCP Stage 1 is complete. It includes the schema/type
contract surface (`minItems` and `additionalProperties: false` schema facets
with recursive enforcement, exact-one `oneOf` validation, the
`McpAppendParallelGroupInput` / `McpAppendQueueItem` types, and the unpublished
queue-item union schema), the exported
`flattenParallelItems(items: readonly ResolvedParallelItem[]): FlattenedParallelItems`
(where `ResolvedParallelItem` is `WorkflowStep | ResolvedParallelContainer`, both
exported beside it)
flattener, and the behavior-preserving `PromptFileParser` move. Phase 3B
inherits the flattener and its relative topology contract; it must publish the
union schema before accepting containers through `append_step`.

**Exit criteria met.** `src/test/unit/McpSchemaValidator.test.ts` accepts flat,
future-parallel, and mixed inputs and rejects empty / one-member / nested /
hybrid / unknown-property inputs; `ParallelGroupTopology.test.ts` covers mixed
batch flattening; `PromptFileParser` tests still pass unchanged, proving the
refactor is behavior-preserving.

**The container union is built but not published.** `append_step`'s
`inputSchema` in `MCP_TOOL_DEFINITIONS` keeps its current flat `items` shape
through this phase, and the runtime `"parallel" in step` rejection in
`handleAppendStep` (`src/mcp-server.ts`) stays. Phase 3A defines and unit-tests
the queue-item union as a separate exported schema constant; Phase 3B swaps
`items` onto it and deletes the rejection in the same commit. This is Rule 3's
principle applied one phase earlier — the published schema is the capability
boundary, so advertising a container the handler still rejects would be a lying
contract for the length of a wave. Track C therefore never edits
`src/mcp-server.ts`.

**Do not:** expose `parallelWithCurrent` in any schema or tool description
(Phase 7), publish the container union in `append_step`'s `inputSchema` or touch
`src/mcp-server.ts` (Phase 3B), change the insertion transaction (Phase 3B), or
modify any existing function in `ParallelGroupTopology.ts` — append only.

### Wave 1 conflict surface

Two files are touched by more than one track. Neither is a real conflict if the
rule is followed:

| File                       | Tracks  | Rule                                                                                        |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| `ParallelGroupTopology.ts` | A, C    | C appends one new pure function at end of file and edits nothing existing. A owns the rest. |
| `DashboardConstants.ts`    | A, B, C | Append new constants to the relevant existing block. Never reorder or reformat neighbours.  |

Everything else is disjoint. Track A never enters `src/ui/**`; Track B never
enters `src/core/Parallel*` or `PromptQueue.ts`; Track C never enters
`src/core/PromptQueue.ts` or `WorkflowExecutor.ts`.

---

## Barrier 1

Merge A, B, and C to `main` before starting wave 2. Wave 2 extends
`ParallelGroupRun` (from A), consumes the placement contract (from A), and
builds the insertion transaction on the flattener (from C). Starting it early
means rebuilding against a moving target.

Gate: `npm test` green on merged `main`, plus `npm run lint` and
`npm run typecheck`.

---

## Wave 2

### Track D — Executor late join and topology (Phases 5 and 6)

**Owns:** `src/core/WorkflowExecutor.ts`, `src/core/ParallelGroupRun.ts`,
`src/core/ParallelGroupTopology.ts`, `src/core/PromptQueue.ts`,
`src/core/ParallelGroupPreflight.ts`, and — for the echo fix in Phase 6 only —
`src/core/WorkflowInstance.ts`.

Track A's `ParallelGroupRun` extraction landed in its own file, so wave 2's
executor work is split across `WorkflowExecutor.ts` and `ParallelGroupRun.ts`;
Disp Stage 3 predates that split and still describes both as one method.
`WorkflowInstance.ts` was missing from the earlier ownership list even though
Phase 6 names the echo fix inside it — it is in scope, for that fix only.

**Phase 5 — Growable executor.** Disp Stage 3, **extending the Track A
`ParallelGroupRun`, not re-extracting it**: replace the one-shot
`Promise.allSettled` with a drain loop that spawns an extra worker on join while
`activeWorkers < effectiveWidth`; **call** the `preflightParallelGroupMember`
that Track A already factored out of `preflightParallelGroup`
(`src/core/ParallelGroupPreflight.ts:150`, reached through
`WorkflowExecutor.preflightGroupMember`) for the late-join admission checks
rather than factoring it again; add `joinRunningParallelGroup(stepIndex)`; make
a rejected join leave the group healthy rather than failing it. Testable against
an authored group with no UI.

Admission needs an **open/closed** state on the run even in this phase, or a
join racing the end of the drain loop is silently dropped rather than rejected.
Phase 5 owns the in-memory flag and the rejection it produces; Phase 7 owns
persisting `ActiveParallelGroupRuntime` and the locked reconcile-and-close.

Track A's extraction lives in `src/core/ParallelGroupRun.ts`. It owns the
ID-keyed `pendingIds`, `running`, `outcomes`, abort watcher, fixed worker pool,
and current-bound join, while `WorkflowExecutor` supplies execution,
preflight, persistence, snapshot, and coordination callbacks. Phase 5 should
extend that object with a drain loop and late-join reconciliation; it must not
move the closure back into the executor or create a second group-run type.

**Phase 6 — Late-join topology.** Disp Stage 4: `appendParallelGroupMember` and
the batch `appendParallelGroupMembers` MCP needs, `promoteStepToParallelGroup`
(implemented as `insertParallelGroupSteps` + `groupParallelGroupSteps` so there
is one grouping implementation), snapshot re-attribution on promotion with
per-step undo suppressed, `PromptQueue` wiring that bumps the definition
revision, and the `WorkflowInstance.ts:3478` echo fix that currently omits
`parallelGroups` and `workflowId` (compare the `appendFromFile` echo at `:2864`,
which passes both).

Ad-hoc groups default to `failFast: false`, against the authored schema default
of `true`. That is deliberate — see Disp Decision 1.

**Promotion collides with a Track A guard, and the fix is a parameter, not a
fork.** `groupParallelGroupSteps` (`ParallelGroupTopology.ts:800`) rejects the
range outright if any step in it `hasStarted`. Promotion wraps the step that is
_running right now_, so it trips that guard by construction. Do not write a
second grouping implementation to dodge it — Disp Decision 1 requires exactly
one. Extend `groupParallelGroupSteps` with an explicit opt-in naming the started
anchor index, and keep the ban for every other member of the range. The
relaxation is sound because promotion preserves the started step's index, id,
and `_runtime`; only its group membership changes, which is precisely what
`assertStartedStepPositionsPreserved` already permits.

#### Track D session split

| #   | Phase | Deliverable                                                       | Status / next-session note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 5     | Growable drain loop + open/closed admission on `ParallelGroupRun` | Complete. `ParallelGroupRun.admit()` rejects duplicate/closed or stopping admissions, starts a worker when capacity exists, and the drain loop waits for late members. Session 2 should use `isAdmissionOpen` and supply the live member resolution/preflight path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2   | 5     | `joinRunningParallelGroup` + per-member admission preflight       | Complete. `joinRunningParallelGroup(stepIndex): Promise<ParallelGroupJoinResult>` returns `{ accepted: true }` or `{ accepted: false, diagnostic }`; rejection covers no live/closed run, non-member or started step, and admission-preflight issues without affecting the group.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 3   | 6     | Topology append + promotion (started-anchor opt-in)               | Complete. Added `appendParallelGroupMember(topology: ParallelGroupTopology, group: string \| number, step: WorkflowStep): ParallelGroupTopology`, `appendParallelGroupMembers(topology: ParallelGroupTopology, group: string \| number, steps: WorkflowStep[]): ParallelGroupTopology`, and `promoteStepToParallelGroup(topology: ParallelGroupTopology, stepIndex: number, step: WorkflowStep, options?: { failFast?: boolean }): ParallelGroupTopology`. `groupParallelGroupSteps` now accepts `startedAnchorIndex?: number` as its sixth parameter; promotion uses it to preserve the running anchor. Ad-hoc promotion defaults to `failFast: false`. Session 4 should call the append/promotion signatures and publish the resulting topology. |
| 4   | 6     | `PromptQueue` wiring, revision bump, `WorkflowInstance` echo fix  | Complete. Added `PromptQueue.appendParallelGroupMember(group, step)` and `PromptQueue.promoteStepToParallelGroup(stepIndex, step, options?)`; both use the shared topology helpers, preserve started-step anchors, bump the definition revision, and persist the working topology. The ephemeral dashboard echo now includes `workflowId` and `parallelGroups`. Phase 7's `RUN_PARALLEL` path calls these same signatures; it must not add a second topology implementation.                                                                                                                                                                                                                                                                       |
| 5   | 6     | Promotion snapshot re-attribution + integration coverage          | Complete. Sequential settlement now re-attributes the held before-state to the promoted group's start target, marks it with the group id, and withholds the promoted step's per-step snapshot; integration coverage verifies persisted append/promotion topology and unsettled-member recovery.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

**Review corrections (applied after session 5).** Three fixes landed in the
review pass, and one of them moves a requirement into Phase 7:

- **The promotion undo-echo is Phase 7's, not Track D's.** Session 5 suppressed
  undo recording in `useMessageHandler` for every `STEPS_EXTENDED` carrying an
  `executionState`, on the theory that only runtime echoes carry it. They do
  not: the clipboard-paste echo (`WorkflowInstance.ts:3115`) passes
  `getAuthoritativeExecutionState()`, which is never `undefined`, so the
  heuristic made **every paste non-undoable**. It was reverted, and a webview
  test now pins that a step insert arriving with a piggybacked `executionState`
  still records undo. Nothing regressed by the revert, because promotion has no
  production caller until Phase 7 — which must pause undo for the promotion
  echo _specifically_ (an explicit signal, not an inference from a field that
  user edits also carry).
- **`PromptQueue`'s two member insertions run inside the working-file operation
  queue.** They originally mutated `this.state` outside it and persisted with
  `updateWorkingFile`, leaving the read-modify-write open to interleaving with a
  concurrent MCP append. Both now share one private helper that runs in
  `runInQueue` and persists with `updateWorkingFileDirect`, matching
  `insertStepAfterIndex`.
- **A promoted anchor's held before-state is released once consumed.**
  `pendingSequentialSnapshotBeforeStates` was only cleared on the non-promoted
  path, pinning a workspace capture per promoted group for the executor's
  lifetime.

**Track D status — complete.** Phase 7 inherits
`joinRunningParallelGroup(stepIndex): Promise<ParallelGroupJoinResult>`, which
resolves to `{ accepted: true }` or `{ accepted: false, diagnostic }` for
no-live/closed, non-member/started, and admission-preflight rejection paths.
It also inherits the `PromptQueue.appendParallelGroupMember(group, step)` and
`PromptQueue.promoteStepToParallelGroup(stepIndex, step, options?)` operation
names and the shared topology helpers behind them. A promoted group keeps the
in-flight step's original before-state as its group snapshot at
`queue:<startIndex>` with `parallelGroupId`; its per-step prompt undo is
withheld, and later member settlements update that group-level snapshot.

**Exit criteria.** `ParallelGroupTopology.test.ts` covers
append-extends-`endIndex`, later-group shifting, valid two-member promotion, and
rejection for a settled/cancelling group; `WorkflowExecutor.*` covers a
mid-fan-out join, a width-limited join waiting for a slot, a rejected join
leaving the group healthy, and stop/pause during a late join.

**Do not:** add the `ACTION_TYPES.RUN_PARALLEL` UI wiring (Phase 7), persist
admission state (Phase 7), or remove any mutation ban (Phase 8).

### Track E — Future parallel-group enqueue (Phase 3B)

**Owns:** `src/core/orchestration/RunContinuationService.ts`,
`src/mcp-server.ts`.

**Phase 3B.** MCP Stage 2: publish the Phase 3A queue-item union as
`append_step`'s `items` schema and delete the flat-only `"parallel" in step`
rejection in `handleAppendStep`; accept an incoming `ParallelGroupTopology` rather
than only `WorkflowStep[]`; insert the whole batch atomically in one definition
revision; move the queue-size check from the pre-lock read in `mcp-server.ts`
**inside** the locked transaction and count flattened executable members;
validate harness/model capability for every flattened member; return the
structured response with `parallelGroupsAdded`, `queueItemsAdded`, `stepsAdded`,
and the Phase 2 `relocation`. Drop `stepsRejected`.

`next` and numeric positions keep their current meaning: a requested index
inside a running group relocates to `endIndex + 1` and enqueues a **future**
group. It never joins.

**Exit criteria.** `src/test/unit/RunContinuationService.test.ts` proves one
revision per batch, in-lock flattened capacity enforcement, and no interleaving
across concurrent appends; `McpServer.test.ts` proves member-level capability
validation inside containers and the structured response shape;
`McpToolSkillGenerator.test.ts` proves the generated docs cover the future
container form.

**Do not:** expose `parallelWithCurrent` (Phase 7) or touch
`WorkflowExecutor.ts`.

### Wave 2 conflict surface

| File                        | Tracks | Rule                                                                  |
| --------------------------- | ------ | --------------------------------------------------------------------- |
| `ParallelGroupTopology.ts`  | D, E   | D writes it; E only calls the Phase 3A flattener and D's new helpers. |
| `RunContinuationService.ts` | E      | Track D must not enter this file in wave 2.                           |

If both tracks need a new helper in the same file mid-wave, the owning track
adds it and the other waits for barrier 2 rather than duplicating it.

---

## Barrier 2

Merge D and E. Gate: `npm test`, `npm run lint`, `npm run typecheck`.

---

## Wave 3 — Track F, sequential (Phases 7, 8, 9)

One loop, one worktree, phases in order. This wave is **not** parallelizable:
every phase in it converges on the same join-and-admission code path, and Phase
8 broadens who can exercise everything the previous eight phases built.

**Phase 7 — Run in Parallel and durable admission.** Disp Stage 5 then MCP
Stage 3, in that order:

- `ACTION_TYPES.RUN_PARALLEL` and `QUEUE_POSITION.PARALLEL_WITH_CURRENT` end to
  end; `resolveQueueInsertIndex` gains its optional `parallelGroups` argument;
  `useRunDispatchTargets` composes the availability gates; the effective
  parallel width is added to the always-synced lightweight `GlobalSettings`
  payload so the webview never re-derives the fan-out gate from
  `fullGlobalSettings` (which is `null` until the Global Settings drawer opens).
- Persist `ActiveParallelGroupRuntime { groupId, admission }` as root runtime,
  stripped on Save As. Make sequential settlement promotion-aware under the same
  lock. Implement the locked reconcile-and-close join. Only then expose
  `parallelWithCurrent` in tool discovery.

Both halves must call the Phase 6 topology operations. There must be exactly one
late-join implementation shared by the editor and MCP.

**Exit criteria.** `EditorFooter.test.tsx` covers the width-1 and
no-step-running disabled reasons; `WorkflowExecutor.*` proves closing prevents a
missed join and that watcher reconciliation schedules every accepted ID exactly
once; `McpServer.test.ts` proves every live-join availability edge rejects
rather than falling back to `next` or `end`.

**Phase 8 — Permit parallel callers.** Mut Stage 5. Remove all three bans
_together_ — `ParallelGroupPreflight.ts:278`, the `context.groupMember` check at
`mcp-server.ts:192`, and the skill projection's removal of
`MCP_SKILL_NAMES.TOOLS` from skill-mode parallel prompts. Native MCP and
MCP-as-skill must expose the same effective tools; enabling one delivery mode
before the other is a bug, not a staging step. Update the now-stale "parallel
groups ban mutation" comments around `ctrlYokeToolFamilies` while keeping
`deniedTools` as the user's explicit opt-out.

**Exit criteria.** `ParallelGroupPreflight.test.ts` no longer produces the
dynamic-queue diagnostic but still honors explicit `deniedTools`;
`McpServer.test.ts` and `McpToolSkillGenerator.test.ts` prove an attached group
member lists and invokes mutation tools in both modes while unattached external
callers stay denied.

**Phase 9 — End-to-end enablement.** MCP Stage 4 plus the integration coverage
from all three plans: a two-member implementation/orchestrator group appends,
edits, and removes flat future work and joins without stale indices; output,
snapshot, PTY, and coordination attribution stay attached to started members
after pending mutations; recovery schedules only surviving unclaimed IDs.

Then dogfood it: build a parallel variant of
`src/templates/workflows/spec-driven-loop.ctrlyoke.yaml` and run it against a
real task. **Do not ship that template in this rollout** — all three plans list
it as out of scope. It is the acceptance test, not a deliverable.

---

## Running this with spec-driven loops

Instantiate the **Spec-Driven Loop** template once per track, pointing
`specFile` at this document, and set a worktree so the tracks cannot collide:

```yaml
worktree: rollout/track-a # named worktree, one per track
```

Then narrow the plan step's prompt. The template's plan prompt reviews the whole
spec; add one scope fence before it ends:

> Implement **Track A (Phases 1 and 2)** only. Treat every other track's "Owns"
> file list as off-limits — if the work seems to require touching them, queue a
> note instead of the edit and say so in your summary. Honor the track's "Do
> not" list literally: those items are later phases, not omissions.

Because each loop runs `append_step` from its own `finalStep`, the tracks are
genuinely independent — no coordination tooling is needed between them beyond
the merge barriers.

**One worktree per track is not optional.** Two loops sharing a checkout will
interleave edits and race each other's `npm test`.

---

## Rules that survive re-planning

1. **Track A owns the `ParallelGroupRun` extraction.** Track D extends it.
   Whichever plan document you are reading, this rollout assigns it to Phase 1.
2. **The caller-level mutation ban comes out in one commit, in Phase 8, for all
   three delivery paths at once.** Never partially.
3. **`parallelWithCurrent` must not appear in tool discovery before Phase 7 is
   complete.** The position enum is the capability boundary.
4. **`next` never joins a live group.** Ordinary appends can never accidentally
   acquire active-group membership; a caller must ask for it explicitly.
5. **Started steps are index anchors.** No phase in this rollout migrates
   manifest, events, or PTY attribution from indices to step IDs. Identity makes
   pending work mutable; it does not authorize renumbering started work.
6. **Wave barriers are merges to `main`, not "the branch compiles".** The whole
   point of the barrier is that the next wave builds on landed code.

---

## Alternatives considered

**One workflow with a `parallel:` container of orchestrators.** Rejected —
`append_step` is withheld from group members until Phase 8, so the orchestrators
would be unable to queue anything; and members share one execution root. See the
Decision section.

**Nine sequential phases in a single spec-driven loop.** Correct but slow, and
it wastes the genuinely disjoint wave-1 work: engine safety, React dashboard,
and MCP schema validation share almost no files.

**Six loops launched at once with no barriers.** Rejected — Phases 5, 6, 7, and
3B all extend code that does not exist until wave 1 lands. The loops would spend
their budget guessing at interfaces.

**Two waves instead of three** (folding wave 3 into wave 2). Rejected — Phase 7
needs the Phase 6 topology operations to exist, and Phase 8 must come after
everything it exposes.
