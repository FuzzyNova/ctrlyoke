# MCP Parallel Append Plan

> **Status:** Phase 3B / Stage 2 complete. The queue-item union, atomic future
> parallel-group enqueue, structured response, and generated MCP documentation
> are shipped. Barrier 2 inherits the complete future-enqueue contract; Phase 7
> inherits the still-unbuilt live-join admission work. `parallelWithCurrent`,
> live join, and durable admission remain unbuilt.
>
> **Scope:** Expand the existing `append_step` MCP tool so it can enqueue
> future `parallel:` groups and, as a second stage, add members to the group
> currently executing. Do not add a second MCP tool for the same mutation.
>
> **Build-order dependencies:** Future-group enqueue can land independently on
> the shipped parallel topology. Live-group join depends on
> [`PARALLEL_STEP_MUTABILITY_PLAN.md`](./PARALLEL_STEP_MUTABILITY_PLAN.md)
> Stages 1–3 and [`RUN_DISPATCH_MENU_PLAN.md`](./RUN_DISPATCH_MENU_PLAN.md)
> Stages 3–4. Calling either form from a parallel member additionally depends on
> the mutability plan's Stage 5 permission change.
>
> **Related shipped design:**
> [`PARALLEL_STEPS_PLAN.md`](../implemented/PARALLEL_STEPS_PLAN.md) defines the
> fork/join and authored `parallel:` semantics this API exposes.
>
> **Build order:** [`PARALLEL_MUTATION_ROLLOUT_PLAN.md`](./PARALLEL_MUTATION_ROLLOUT_PLAN.md)
> stages this plan against the other two — Stage 1 is its Phase 3A, Stage 2 its
> Phase 3B, Stage 3 its Phase 7, and Stage 4 its Phase 9.

---

## Outcome

`append_step` gains two explicit parallel behaviors:

1. A `{ parallel: [...] }` item in `steps` enqueues a **new future parallel
   group** while preserving the order of surrounding flat items.
2. `position: "parallelWithCurrent"` adds one or more flat inputs as **late
   members of the group executing now**, using the same promotion/join machinery
   as the editor's Run in Parallel action.

These are intentionally different operations. A container describes topology
inside the batch being queued; `parallelWithCurrent` describes the batch's
destination relative to live execution. Combining them would imply a nested
group and is rejected.

### Example: enqueue future work

```json
{
  "position": "end",
  "steps": [
    {
      "name": "prepare fixtures",
      "prompt": "Prepare the shared fixtures for the next phase."
    },
    {
      "parallel": [
        {
          "name": "implement phase",
          "prompt": "Implement the next phase of the specification."
        },
        {
          "name": "orchestrate phase",
          "prompt": "Inspect progress and adjust future workflow steps when needed."
        }
      ],
      "failFast": false
    },
    {
      "name": "verify phase",
      "prompt": "Verify the completed phase."
    }
  ]
}
```

The batch flattens to four executable steps and one normalized parallel-group
range around the two middle members.

### Example: join live execution

```json
{
  "position": "parallelWithCurrent",
  "steps": [
    {
      "name": "investigate failing tests",
      "prompt": "Investigate the failing tests independently and report or fix the cause."
    },
    {
      "name": "review current changes",
      "prompt": "Review the changes made so far and fix correctness issues."
    }
  ]
}
```

Both inputs become members of the one active group, in request order. Pool
saturation delays dispatch but does not reject the append.

---

## Decision 1 — Extend `append_step`; do not add `append_parallel_steps`

The mutation remains "append queue items at a destination." A second tool would
duplicate run addressing, queue limits, harness/model validation, locking,
definition revisions, placement reporting, and generated skill documentation.
It would also make mixed flat/group batches impossible without multiple calls
and an observable intermediate definition.

One tool with a discriminated item union and destination is the smaller, more
composable contract. `MCP_APPEND_STEP_TOOL_NAME` remains the single source of
truth for permission filtering and tool discovery.

The name stays singular for now because it is already established and already
accepts an array. Renaming it is unrelated churn.

---

## Decision 2 — Use the authored container shape around the existing MCP member

The MCP member surface remains deliberately narrower than a full authored
`WorkflowStep`. This feature composes the fields `append_step` already accepts;
it does not silently add script steps, hooks, conditions, agents, skills,
permissions, or every execution property.

```ts
type McpAppendStepInput = Pick<
  PromptStep,
  "prompt" | "name" | "model" | "harness" | "resumeSession"
> & {
  sessionId?: number;
};

interface McpAppendParallelGroupInput {
  parallel: McpAppendStepInput[];
  failFast?: boolean;
}

type McpAppendQueueItem = McpAppendStepInput | McpAppendParallelGroupInput;

interface McpAppendStepArguments {
  steps: McpAppendQueueItem[];
  position:
    | typeof QUEUE_POSITION.NEXT
    | typeof QUEUE_POSITION.END
    | typeof QUEUE_POSITION.PARALLEL_WITH_CURRENT
    | number;
  source?: string;
}
```

The parallel container intentionally matches authored YAML/JSON:

- at least two members;
- `failFast` defaults to `true` for a newly enqueued group;
- no caller-supplied group ID, range, `_runtime`, or member `stepId`;
- no nested `parallel` item; and
- no empty group or partial acceptance.

`parallelWithCurrent` accepts **flat inputs only**. A parallel container with
that destination is rejected with a direct error explaining that the caller
must choose either a future group (`next`/`end`/numeric) or flat late members.

### Runtime schema validation

`McpToolInputSchema`/`McpSchemaValidator` currently cannot express the two
constraints this union needs safely: `minItems` and rejection of unknown object
properties. Add those two schema facets and enforce them recursively. Without
`additionalProperties: false`, an object containing both `prompt` and
`parallel` can incorrectly satisfy the flat branch because the validator ignores
the unknown discriminator; without `minItems: 2`, cardinality lives in a second
hand-written validator.

The `oneOf` implementation must require exactly one successful branch, not
merely return on the first. That gives malformed hybrid input a schema error
before any run file is opened.

`schemas/workflow-schema.yaml` and its generated JSON do not change. This is an
MCP argument-contract change, not a new workflow-file shape.

---

## Decision 3 — Normalize a batch once, then insert topology atomically

Add one shared flattener for the authored-style item union. Given resolved flat
members and containers, it returns a relative `ParallelGroupTopology`:

```ts
interface FlattenedParallelItems {
  topology: ParallelGroupTopology;
  itemCount: number;
  stepCount: number;
}
```

The helper owns order preservation, minimum cardinality, group-ID generation,
`failFast` defaulting, and normalized relative ranges. It belongs beside the
other topology transforms in `ParallelGroupTopology.ts`.

`PromptFileParser` should consume the same helper after it has resolved file
references and converted authored prompt/script members. The parser remains
responsible for file syntax and asynchronous member construction; the topology
helper becomes the single source for flattening and group-range math. The MCP
path maps its narrower member inputs to `PromptStep`s, calls the helper, assigns
run-scoped member `stepId`s when that feature is present, then passes the result
to `insertParallelGroupTopology`.

For `next`, `end`, or a numeric position:

- the entire input array is one atomic batch;
- position applies to the start of that batch;
- internal flat/group order is preserved;
- a requested index inside an existing group is snapped outside that group by
  the existing insertion policy; and
- every later group is shifted once by the flattened executable-step count.

Do not loop over items and call the existing flat append repeatedly. That would
create multiple definition revisions, expose invalid half-groups to the file
watcher, and let concurrent mutations interleave inside one caller's batch.

### Validation happens on flattened members

The current handler counts and validates top-level `steps`. After this change:

- queue capacity counts executable members, not containers;
- harness/model capability validation visits every flattened member;
- session references validate against the post-insertion absolute positions;
- all members are sanitized through the existing runtime/view-only stripping;
  and
- one invalid member rejects the whole batch before persistence.

Move the queue-size check into the locked `RunContinuationService` transaction.
The current pre-lock read in `mcp-server.ts` can race another append and let both
requests independently pass the limit.

---

## Decision 4 — Future-group enqueue never means late join

`position: "next"` keeps its existing meaning. While a group runs, the requested
index falls inside that group and is relocated to `endIndex + 1`; a parallel
container therefore becomes the next **future** queue item after the join. It
does not expand the active group.

This preserves a valuable safety property: ordinary append calls can never
accidentally acquire active-group membership. A caller must state
`parallelWithCurrent` to request concurrency with live work.

Numeric positions behave the same way. If the requested position falls inside
any existing group, the complete incoming batch is placed after that group and
the structured relocation from `PARALLEL_STEP_MUTABILITY_PLAN.md` Decision 4 is
returned.

---

## Decision 5 — Live join reuses the manual operation through a disk-linearized handoff

`parallelWithCurrent` is not implementable as "write `endIndex` and hope the
watcher notices." The MCP server runs in another process, while the live
`ParallelGroupRun` and its worker pool are in the extension/CLI runner process.
The join must have one durable linearization point with group settlement.

### Durable admission state

Persist a small root-runtime projection while a queue group is active:

```ts
interface ActiveParallelGroupRuntime {
  groupId: string;
  admission: "accepting" | "closing";
}
```

The string values are constants in `DashboardConstants.ts`. This is runtime
coordination, not authored topology, and is stripped from Save As like other
root runtime fields.

- Group start or sequential-step promotion writes `accepting`.
- Pause, cancellation, stop, terminal fail-fast, and the final join change it
  to `closing` under the working-file lock before cancelling/draining.
- Recovery rebuilds `accepting` only for the current unsettled group of a run
  that is genuinely resuming; stale admission on a stopped/terminal run is
  ignored and cleared.

The MCP transaction accepts a live join only when execution is `RUNNING`, the
current queue target is not `finalStep`, and admission is `accepting`. Effective
parallel width of one is rejected because accepting work that cannot overlap
would contradict the destination. A saturated pool with width greater than one
is accepted; members wait for capacity.

### Existing active group

Under the run-file lock, append all incoming flat steps at the current group's
`endIndex + 1`, extend its range once, shift later topology once, and persist one
definition revision. Preserve the group's existing `failFast` policy. The MCP
caller cannot override it through a late join.

The working-file watcher merges the revision by `stepId`. A queue-definition
event asks the active `ParallelGroupRun` to reconcile its group ID and enqueue
unknown surviving member IDs. Reconciliation is idempotent, so both the watcher
and an in-process manual dispatch may request it safely.

### Running sequential step

Match the editor behavior rather than making the same destination depend on the
caller:

- promote the current sequential step plus all incoming flat inputs into one
  group;
- default the new ad-hoc group to `failFast: false`, as settled in
  `RUN_DISPATCH_MENU_PLAN.md`;
- reattribute the current step's before snapshot to the group and suppress its
  per-step undo; and
- initialize admission as `accepting`.

The executor's sequential settlement must acquire the same lock and re-read the
current topology before advancing. If the target was promoted, it hands its
outcome to the idempotent `ParallelGroupRun` reconciliation instead of calling
the ordinary sequential advance. This closes the race in which the source step
finishes immediately after the MCP transaction commits but before a filesystem
watch event arrives.

### Join closes atomically

`ParallelGroupRun` cannot join based on an unlocked "pending is empty" check.
Its drain loop performs a locked reconcile-and-close operation:

1. merge the latest disk definition;
2. resolve the active group by ID;
3. if it contains unknown surviving IDs, enqueue them and return to drain;
4. otherwise set admission to `closing`, commit all outcomes, advance past the
   current `endIndex`, and persist the join before releasing the lock.

An MCP append that acquires the lock first is guaranteed to be discovered and
joined. A join that acquires it first closes/advances the group, so the later
MCP append rejects with `No parallel group is accepting members`. Success never
means "the definition changed, but the coordinator may already have missed it."

The topology mutation itself should be the same
`appendParallelGroupMember(s)` / `promoteStepToParallelGroup` operation used by
the manual path. MCP adds a cross-process adapter and admission protocol, not a
second flavor of late join.

---

## Decision 6 — Responses describe flattened topology and destination

Keep the existing response fields that remain truthful (`success`,
`newQueueSize`, `insertIndex`, run address, and revisions), but define
`stepsAdded` as the number of executable flat members. Remove
`stepsRejected`: append is atomic and that field is permanently zero today.

Add structured fields:

```ts
interface McpAppendStepResult {
  success: true;
  destination: "queue" | "activeParallelGroup";
  queueItemsAdded: number;
  stepsAdded: number;
  newQueueSize: number;
  insertIndex: number;
  insertedEndIndex: number;
  parallelGroupsAdded: Array<{
    id: string;
    startIndex: number;
    endIndex: number;
    failFast: boolean;
  }>;
  joinedParallelGroup?: {
    id: string;
    startIndex: number;
    endIndex: number;
    promoted: boolean;
  };
  placement: ParallelGroupInsertPlacement;
  workingFile: string;
  runDirectory: string;
  workflowKey: WorkflowKey;
  runRef: RunRef;
  definitionRevision: number;
  descriptorRevision: number;
}
```

`placement` is the `ParallelGroupInsertPlacement`
(`{ requestedIndex, insertedIndex, relocation? }`) that Stage 1's Phase 2 work
already landed and that `append_step` already returns; the relocation this plan
originally described as a separate `QueueInsertRelocation` field lives inside it.
Do not add a second, flattened copy — `insertIndex` stays only because it is an
already-published alias for `placement.insertedIndex`.

For a future mixed batch, `parallelGroupsAdded` contains only groups from the
incoming batch after absolute-index translation. For a live join,
`joinedParallelGroup` contains the active group's new full range and
`parallelGroupsAdded` contains the promoted group only when promotion created
one.

The generated MCP skill/reference must include one flat example and one future
container example. Tool descriptions must say explicitly that `next` queues
after the active group; joining it is not available through this position enum
until the later live-join stage.

---

## Permission and security boundary

- Unattached external MCP participants still cannot call `append_step`.
- The tool remains pinned to the caller's attached run; arguments never choose
  a workflow key, run reference, or file path.
- A parallel member receives the tool only after
  `PARALLEL_STEP_MUTABILITY_PLAN.md` Stage 5 removes the caller-level ban.
- Target mutability, started-index anchors, group admission, queue limits, and
  definition revision are all rechecked inside the locked transaction.
- Caller-supplied `_runtime`, group IDs/ranges, and nested topology are rejected
  at schema validation rather than sanitized silently.
- `deniedTools: ["append_step"]` continues to remove both flat and parallel
  forms because they remain one tool.

A parallel orchestrator can recursively add more future groups or late members.
That is intentional. `maxParallelSteps` limits active concurrency and the
existing queue-size policy limits queued expansion when configured; no second
parallel-specific quota is added.

---

## Type and file changes

- `src/utils/McpToolDefinitions.ts`
  - `McpAppendParallelGroupInput` and `McpAppendQueueItem`;
  - `QUEUE_POSITION.PARALLEL_WITH_CURRENT` in the position schema;
  - `minItems` / `additionalProperties` schema facets;
  - expanded descriptions and result contract.
- `src/utils/McpSchemaValidator.ts`
  - recursive `minItems` and unknown-property enforcement;
  - exact-one `oneOf` validation.
- `src/core/ParallelGroupTopology.ts`
  - shared item-to-relative-topology flattener;
  - batch `appendParallelGroupMembers` in addition to the single-member helper
    from `RUN_DISPATCH_MENU_PLAN.md`.
- `src/core/PromptFileParser.ts`
  - reuse the shared flattener after member construction.
- `src/mcp-server.ts`
  - remove the flat-only rejection;
  - flatten members for capabilities validation;
  - branch queue insertion versus live join by destination;
  - serialize the structured response.
- `src/core/orchestration/RunContinuationService.ts`
  - accept an incoming `ParallelGroupTopology`, not only `WorkflowStep[]`;
  - enforce flattened queue capacity inside the lock;
  - add the locked late-join transaction and admission checks.
- `src/types/CtrlYokeTypes.ts` / `src/types/DashboardConstants.ts`
  - active-group runtime admission contract and constants.
- `src/core/PromptQueue.ts`, `src/core/WorkflowExecutor.ts`, and
  `src/core/WorkflowInstance.ts`
  - topology-definition reconciliation event;
  - idempotent promotion/join handoff;
  - locked reconcile-and-close join.
- `src/utils/McpToolSkillGenerator.ts`
  - document both parallel forms without creating another skill/tool family.

---

## Implementation stages

**Stage 1 — MCP item union and shared normalization — complete.** The schema
facets, types, examples, published union, validator tests, and the exported
`flattenParallelItems(items: readonly ResolvedParallelItem[]): FlattenedParallelItems`
(where `ResolvedParallelItem` is `WorkflowStep | ResolvedParallelContainer`, both
exported beside it)
flattener are landed. `PromptFileParser` consumes the same flattener for
authored `parallel:` items, keeping relative range math single-sourced. Stage 2
inherits this helper and its normalized topology result. The queue-item union
schema is published through `append_step` alongside the handler change.

**Stage 2 — Future parallel-group enqueue — complete.** Session 1 landed the shared
queue-limit helpers, topology-accepting continuation transaction, atomic
topology insertion, flattened in-lock capacity validation, and append metadata
for absolute groups and added steps. Session 2 landed publication of the
queue-item union and MCP-side flattened validation/structured response. Session
3 landed generated MCP docs covering both append forms. This stage ships before
manual late join and is already useful to sequential orchestrators. Barrier 2
inherits the complete future-enqueue contract; Phase 7 inherits the unbuilt
`parallelWithCurrent` live-join path and durable admission state.

**Stage 3 — Durable live-join admission.** After the mutability and dispatch
prerequisites, persist admission state, add queue-definition reconciliation,
make sequential settlement promotion-aware, and implement locked
reconcile-and-close. Then expose `parallelWithCurrent` in the MCP schema.

**Stage 4 — Parallel-caller end-to-end enablement.** Land with or after the
mutability plan's Stage 5. Verify native MCP and MCP-as-skill expose identical
contracts to a group member and dogfood the implementation/orchestrator workflow
pattern.

Do not expose `parallelWithCurrent` in tool discovery before Stage 3 is complete.
Future container enqueue and live join are independently releasable because the
position enum is the explicit capability boundary.

---

## Edge cases

- **One-member future container:** reject; do not silently flatten it.
- **Container with `parallelWithCurrent`:** reject as ambiguous/nested.
- **Mixed batch:** preserve exact flat/group/flat order in one revision.
- **Numeric position inside a group:** relocate the whole batch outside and
  report it.
- **`next` while a group runs:** enqueue after the group; never join.
- **No running queue step:** `parallelWithCurrent` rejects; never falls back to
  `next` or `end`.
- **Final step running:** reject; final steps cannot be parallel members.
- **Pausing, cancelling, stopped, terminal, or fail-fast closing:** reject from
  persisted admission state.
- **Effective width one:** reject live join and name `queue.maxParallelSteps`;
  future group enqueue remains legal because settings may change before it runs.
- **Pool saturated:** accept live members and leave them pending by `stepId`.
- **Several live members in one request:** append atomically in request order;
  per-member preflight may settle them differently later.
- **Concurrent future appends:** run-file lock and definition revision preserve
  whole batches without interleaving.
- **Concurrent append and join:** locked reconcile-and-close gives exactly one
  winner and no missed successful append.
- **Concurrent manual and MCP late join:** both topology changes serialize and
  reconciliation de-duplicates by `stepId`.
- **Sequential source settles during promotion:** settlement observes the
  promoted topology under lock and transfers to the group join.
- **Invalid harness/model in one member:** reject the whole request before the
  definition changes.
- **Queue limit crossed by flattened members:** reject the whole request inside
  the mutation lock.
- **Crash after future-group persistence:** ordinary working-file recovery sees
  normalized topology.
- **Crash after accepted live join:** admission plus member IDs cause recovery
  to schedule only surviving unsettled members.
- **Repeated request after transport timeout:** not idempotent, matching current
  `append_step`. Do not invent request IDs in this plan.

---

## Test strategy

- `src/test/unit/McpSchemaValidator.test.ts`
  - accepts flat, future parallel, and mixed examples;
  - rejects empty/one-member/nested/hybrid/unknown-property inputs;
  - verifies exactly-one `oneOf` behavior.
- `src/test/unit/ParallelGroupTopology.test.ts`
  - flattens mixed batches with correct relative ranges and policies;
  - translates multiple incoming ranges at one insertion point;
  - appends several live members while shifting later groups once.
- `src/test/unit/RunContinuationService.test.ts`
  - persists future topology in one definition revision;
  - counts flattened members under the queue limit inside the lock;
  - preserves atomic batches across concurrent appends;
  - linearizes append versus close and promotion versus sequential settlement.
- `src/test/unit/McpServer.test.ts`
  - validates capabilities for members inside containers;
  - reports flattened counts, created groups, destination, join, and relocation;
  - rejects every live-join availability edge without fallback.
- `src/test/unit/McpToolSkillGenerator.test.ts`
  - generated docs include both parallel forms and the `next`/join distinction;
  - denying `append_step` removes the entire expanded surface.
- `src/test/unit/WorkflowExecutor.*`
  - watcher reconciliation schedules every accepted ID exactly once;
  - saturated late members wait;
  - closing prevents a missed join;
  - fail-fast/stop/pause close admission before drain.
- `src/test/integration/`
  - a sequential orchestrator enqueues a future implementation/orchestrator
    group which later fans out;
  - a group orchestrator adds a future group and live siblings through native
    MCP and MCP-as-skill;
  - promotion, snapshots, output attribution, recovery, and final join remain
    correct under concurrent mutation.

---

## Not in scope (YAGNI)

- A new `append_parallel_steps` tool.
- Full MCP append parity with every authored prompt/script property.
- Nested parallel groups or a group inside `parallelWithCurrent`.
- Selecting an arbitrary running group; there is exactly one current queue
  group per workflow run.
- Joining a group belonging to another workflow/run.
- Changing a live group's `failFast` policy through append.
- Waiting for late members to finish before returning the MCP call. Success
  means durable admission to the group, not group completion.
- Request-level idempotency keys or deduplication.
- Per-member worktrees, dependencies, DAG scheduling, or partial joins.
- Shipping the parallel spec-loop template itself.

---

## Settled questions

1. **New tool or expanded tool?** Expand `append_step`.
2. **Input shape?** Authored-style `{ parallel, failFast }` containers around
   the existing narrow MCP prompt member.
3. **Can a request mix flat and grouped future items?** Yes, atomically.
4. **How does a caller join live work?** Flat items plus the explicit
   `parallelWithCurrent` destination.
5. **Does `next` join?** No; it queues after the active group.
6. **Can MCP promote a running sequential step?** Yes, matching the editor,
   through the same topology/snapshot operation and a locked settlement handoff.
7. **What does `stepsAdded` count?** Flattened executable members.
8. **What happens on partial invalidity?** The entire request rejects.
9. **How is append-versus-join race safety achieved?** Persisted admission plus
   locked reconcile-and-close.
