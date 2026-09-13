# Run Dispatch Menu Plan

> **Status:** Backlog / design proposal. Nothing here is implemented.
>
> **Companion to:** [`STEER_MESSAGE_PLAN.md`](./STEER_MESSAGE_PLAN.md) (backlog).
> That plan introduces the split-button shell on `btn-editor-run` and its first
> menu item ("Send Steer Message"). This plan defines the finished menu, adds
> **Run in Parallel** and **Run in New Workflow**, and settles what happens to
> the Queue button.
>
> **Depends on:** [`PARALLEL_STEPS_PLAN.md`](../implemented/PARALLEL_STEPS_PLAN.md)
> (shipped) for the fork/join model that "Run in Parallel" extends, and on
> [`PARALLEL_STEP_MUTABILITY_PLAN.md`](./PARALLEL_STEP_MUTABILITY_PLAN.md)
> (backlog, **prerequisite**) for the execution guards. Stages 3 and 4 here
> assume a live group can be mutated safely; today it cannot, for reasons that
> plan documents. Its Stages 1–3 must land first, and the two plans share the
> `ParallelGroupRun` extraction — whichever gets there first owns it.
>
> **Build order is not fixed.** Whichever of the two plans lands first owns the
> split-button shell (Stage 1 below); the other one only contributes a menu
> item. Neither plan blocks the other.

---

## The question both plans answer

The prompt editor composes one draft. Today that draft has exactly two
destinations, and both are queue operations:

| Control | Destination                                                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queue   | tail of the queue, no execution (`ACTION_TYPES.QUEUE`)                                                                                                        |
| Run     | tail/next of the queue, then ensure the workflow runs (`ACTION_TYPES.RUN` → `RUN_NEXT` while running, `EditorFooter.tsx:274-288`, `PromptEditor.tsx:885-899`) |

Users routinely want three more destinations that the queue cannot express:

- **the live TUI session** — the harness is sitting there idle mid-turn and the
  user wants to redirect it now (steer);
- **alongside the running step** — kick off independent work without waiting
  for the in-flight step to finish;
- **a fresh workflow** — this thought is unrelated to what is running, and
  appending it to the current queue would be wrong.

So the editor does not need more _modes_; it needs one **dispatch menu**: same
text, same authoring surface, a choice of destination.

---

## Recommended UX

**Keep the primary button as Run/Run Next. Put the three alternate
destinations in its drop-up. Leave Queue as its own button.**

```
┌───────────────────────────────────────────────────────────────┐
│ ⚙ Properties  [harness][model][agent][skills] … [perm][ctx]   │
│                                    │ + Queue │ ➤ Run Next │ ▲ │
└───────────────────────────────────────────────────────────────┘
                                          ┌──────────────────────────────┐
                                          │ ⤳  Send Steer Message        │
                                          │ ⇉  Run in Parallel           │
                                          │ ──────────────────────────── │
                                          │ ✦  Run in New Workflow       │
                                          └──────────────────────────────┘
```

Menu order is deliberate: the two items that act on the _current run_ come
first, ordered by how tightly they bind to it (into the live session, then
beside the live step); the divider separates the one item that leaves the
current run alone.

### Why this shape

1. **One verb per surface.** Every item in the drop-up dispatches _now_; Queue
   is the only control that defers. Splitting on that line makes the menu
   explainable in one sentence ("where does this go?") and keeps Queue's
   meaning intact.
2. **The menu is never entirely dead.** Steer and Run in Parallel are both
   unavailable in the most common state (nothing running). A drop-up whose
   every item is disabled reads as broken. "Run in New Workflow" is enabled
   whenever Run is, so the menu always does something — this is the decisive
   argument for including it, rather than a nice-to-have.
3. **It costs no footer width.** The chevron adds ~16px to a button that
   already exists; `EditorFooter`'s `isMediumWidth`/`isSmallWidth` collapsing
   (`EditorFooter.tsx:84-95`) is untouched.
4. **It matches the mechanics.** All four destinations consume the same
   composed draft and the same prompt-reference expansion. Only the delivery
   differs. (Overrides are the exception, and only for steer — see
   `STEER_MESSAGE_PLAN.md`.)

### Disabled-item policy

**Show disabled items, never hide them**, with a tooltip naming the reason.
This settles the "disabled/hidden" ambiguity left open in
`STEER_MESSAGE_PLAN.md`'s UX section. Hidden items make a menu that changes
shape between clicks and never teaches the feature; a greyed row with "No live
harness session for this workflow" teaches it once.

### Keep Queue as its own button

The user's instinct is right and this plan adopts it:

- Queue is the second-most-used action in the footer. Hiding the only
  non-executing action behind a click taxes the exact workflow (compose a
  batch of steps, then run) that ctrlyoke is for.
- Folding it in would put a "don't run" item in a menu where every other item
  runs, which is what makes the menu legible.
- Footer space is not actually the constraint — the responsive collapse
  already handles narrow widths.

**Rejected alternatives**

- _Fold Queue into the drop-up, primary becomes Run only._ Saves ~70px at the
  cost of the primary batching workflow and the menu's single-verb framing.
- _Give Queue its own split button (Queue at End / Queue Next)._ Two split
  buttons in a 40px-tall bar is noisy, and `QUEUE_NEXT` already exists unused
  (`ACTION_TYPES.QUEUE_NEXT`, `DashboardConstants.ts:957-963`) with no
  demonstrated demand. Revisit only if users ask.
- _A third permanent button, or a "destination" segmented control._ Rejected
  for the same reason `STEER_MESSAGE_PLAN.md` rejected them: they present
  rarely-available actions as peers of Run, and a segmented control implies a
  persistent mode when this is a per-submission choice.
- _"New Workflow" only in the header/workflow list._ That button exists but
  creates an **empty** workflow, forcing the user to re-type or re-paste the
  draft. The menu item's entire value is that the draft (and its property
  overrides) travels with it.

### Availability gates

| Item                | Enabled when                                                                                                                                                  | Disabled reason (tooltip)                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Run / Run Next      | `hasContent && !isExternallyManaged` (unchanged)                                                                                                              | unchanged                                                                                                                                      |
| Send Steer Message  | new-prompt mode, prompt step type, live `SESSION_KINDS.AI_CLI` session in `TERMINAL_SESSION_STATUS.RUNNING` for the active workflow (`STEER_MESSAGE_PLAN.md`) | "No live harness session for this workflow" / "Process exited"                                                                                 |
| Run in Parallel     | new-prompt mode, workflow `RUNNING`, an in-flight **queue** step (not the final step), effective fan-out width > 1                                            | "No step is running" / "The final step can't run in parallel" / "Parallel width is 1 — raise `queue.maxParallelSteps`" / "Workflow is pausing" |
| Run in New Workflow | `hasContent && !isExternallyManaged`                                                                                                                          | (never disabled while Run is enabled)                                                                                                          |

Every item additionally requires `hasContent` and is disabled by
`isExternallyManaged` (CLI watch mode), exactly like Run/Queue today.

"Run in New Workflow" has no gate at all, which is a direct consequence of
Decision 2: a spin-off inherits nothing from the current workflow, so it never
contends for the source run's worktree, lease, or session. (Had it inherited a
**named** worktree, it would have had to be disabled during an active run —
that run holds an `exclusive-worktree` lease and `isCompatible`
(`ExecutionRootLeaseManager.ts:219-226`) makes it conflict with every other
mode, so the spin-off would fail at start with `ExecutionLeaseConflictError`.
Not inheriting removes the gate rather than explaining it.)

The webview already holds most gate signals: `workflowStore.executionState`,
`activeStepIndices` (`workflowStore.ts:246`), `finalStepPhase` (`:251`),
`parallelGroups` (`:243`). The fan-out width is **not** available:
`queue.maxParallelSteps` (`CtrlYokeSettings.ts:185`) reaches the dashboard only
inside `fullGlobalSettings`, which is fetched on demand when the Global
Settings drawer opens (`GlobalSettingsDrawer.tsx:161`) and is `null` for a user
who never opened it. Add one field to the always-synced lightweight
`GlobalSettings` payload (`settingsStore.ts:108-149`) carrying the **effective**
width from `getEffectiveParallelGroupWidth(queue.maxParallelSteps)`
(`DashboardConstants.ts:889-897`), so the webview never re-derives the fan-out
gate.

---

## Decision 1 — "Run in Parallel" joins the running group, forming one if needed

The action means: **run this draft concurrently with the step that is running
right now, and let the queue continue only after both settle.** That is exactly
the shipped parallel-group contract, so the implementation must extend a group
rather than invent a second concurrency mechanism.

Two capabilities are required, because the in-flight step may or may not
already be a group member:

- **Late join** — a group that has already forked accepts one more member.
- **Ad-hoc promotion** — a sequentially executing step becomes the first member
  of a brand-new group at its own index, and the draft becomes the second.

### Which group it joins

Always the group that contains `currentIndex`, and the new member always lands
at that group's **end**:

- **A group is already running** → append after its current `endIndex`. If every
  fan-out slot is busy the member waits its turn in the pool. That is expected
  behavior, not an error; the steps panel shows it pending inside the group.
- **No group is running** (an ordinary sequential step is in flight) → promote
  that step and the draft into a new two-member group at `currentIndex`. The
  draft starts immediately, because a fresh group always has a free slot when
  the effective width is greater than 1.

`currentIndex` makes this unambiguous even with several members in flight: it
stays at the group's `startIndex` until the join commits, so "the group
containing `currentIndex`" identifies one group without a picker.

### Saturation is not the width gate

Two different situations, and only one of them disables the menu item:

- **Every `queue.maxParallelSteps` slot is busy (saturation).** Not a gate. The
  member is appended and runs when a slot frees; only its start time changes.
- **Effective width is exactly 1** (`queue.maxParallelSteps: 1`, a supported
  configuration meaning "run groups sequentially"). Joining then cannot produce
  concurrency at all — the member would run strictly after the in-flight step,
  which is what Run/Run Next already does. This is the only case where the item
  is disabled, and the tooltip names the setting so the user can raise it.

### The narrow rule change this needs

`PARALLEL_STEPS_PLAN.md` Decision 7 states: _"Group topology mutations
(group/ungroup/move into/out of) are rejected for any group that has at least
one settled or in-flight member. Adding a step to such a group is not
possible."_ This plan proposes the minimum relaxation that makes the feature
possible, and nothing more:

- **Allowed:** appending one new member immediately after the group's current
  `endIndex`. Existing members keep their indices, ids, runtime, and output;
  only `endIndex` grows and later steps/groups shift by one — the same shift
  every `RUN_NEXT` append already performs.
- **Still rejected:** reorder, ungroup, delete, and moving members into or out
  of a settled/in-flight group. Those are enforced today in
  `reorderParallelGroupPendingSteps` (`ParallelGroupTopology.ts:637-690`) and
  that guard is untouched.
- **Also rejected:** joining a group that is cancelling, stopping, pausing, or
  that has already tripped `failFast`.

The relaxation is safe because appending is the one mutation that cannot
invalidate anything already computed for the existing members: their indices,
their join-boundary reference snapshot, and their per-target attempt keys
(`queue:<stepIndex>`) are all unchanged.

**Corrected 2026-09-12 — an execution-guard change _is_ needed.** An earlier
revision noted that `PromptQueue.assertEditableDuringExecution`
(`PromptQueue.ts:2493-2512`) already permits an insert at any index
`> currentIndex` and concluded that no guard work was required. The premise is
right and the conclusion is backwards: during a parallel group `currentIndex`
stays pinned at `group.startIndex` until the join
(`PromptQueue.commitParallelGroupJoin`, `:917-942`; mid-group settlements go
through `persistStepOutcome`, `:891`, which never advances it). So the guard
permits an insert at any index `> startIndex` — including **on top of members a
worker is currently executing**. The append this decision needs happens to be
safe, but it is safe by luck of landing at `endIndex + 1`, not because anything
checked. See [`PARALLEL_STEP_MUTABILITY_PLAN.md`](./PARALLEL_STEP_MUTABILITY_PLAN.md);
its Stages 1–3 are the prerequisite, and its Decision 2 is why the relaxation
below must stay append-only until step identity replaces positional indices in
the worker plan.

### Topology operations to add

Today's insert helpers deliberately push _out_ of a group:
`resolveParallelGroupInsertIndex` maps an index inside a group range to
`endIndex + 1` **without** extending the group
(`ParallelGroupTopology.ts:136-162`), which is what makes `RUN_NEXT` during a
group land after the join. That behavior stays. Add two siblings:

```typescript
/** Extend a group by one member at endIndex + 1. Shifts later steps/groups. */
appendParallelGroupMember(
  topology: ParallelGroupTopology,
  group: string | number,
  step: WorkflowStep
): ParallelGroupTopology;

/** Wrap an ungrouped step and a new sibling into a fresh two-member group. */
promoteStepToParallelGroup(
  topology: ParallelGroupTopology,
  stepIndex: number,
  step: WorkflowStep,
  options?: { failFast?: boolean }
): ParallelGroupTopology;
```

`promoteStepToParallelGroup` is `insertParallelGroupSteps` at `stepIndex + 1`
followed by `groupParallelGroupSteps` over the two-step range
(`ParallelGroupTopology.ts:745`), so there is one grouping implementation.

**Ad-hoc groups default to `failFast: false`** even though the authored schema
default is `true`. The user is adding work to a run they are watching, not
declaring a batch with a shared failure policy; a bad late member must not
cancel the step the user is already invested in. The group header's `failFast`
control remains available for later runs of that definition.

### Executor changes

`WorkflowExecutor.executeParallelGroup` (`WorkflowExecutor.ts:718-970`) fixes
its entire plan at entry: `preflightGroup` runs once, `pendingIndices` is built
once from `startIndex..endIndex`, and `workerCount` is a single
`Promise.allSettled` over a fixed worker array (`:868-890`). Late join needs:

1. **Extract a `ParallelGroupRun` class** from that method's closure state
   (`outcomes`, `running`, `pendingIndices`, `abortController`,
   `failFastTriggered`, `groupBeforeState`). The method is already ~250 lines
   of closure; the join hook needs a real object to hang off, and the
   extraction is worth doing regardless.
2. **A growable worker pool.** The worker loop already re-reads
   `pendingIndices.length` each iteration, so a member appended while a worker
   is alive is picked up for free. Replace the one-shot `allSettled` with a
   drain loop that keeps awaiting while workers remain or pending members
   remain, and spawns an additional worker on join when
   `activeWorkers < effectiveWidth`.
3. **Per-member preflight.** Factor a `preflightParallelGroupMember` out of
   `preflightParallelGroup` so a joiner gets the same checks as its siblings:
   harness readiness, an isolated integration keyed `queue:<stepIndex>`,
   session-collision against the group's _current_ members (including running
   ones), the ctrlyoke-MCP block, interactive-multiplex capability, and
   in-group reference rejection.
4. **A rejected join must never fail the group.** Up-front preflight failure is
   a group-level error (`throwIfParallelGroupPreflightFailed`). A late join is
   a user action against a healthy run: on rejection, the member is _not_
   appended, the group continues untouched, and the client gets a toast naming
   the diagnostic.
5. **Join commit.** `commitParallelGroupJoin(group, outcomes)` must read the
   group's _current_ `endIndex`, not the value captured at fork time, so
   `currentIndex` advances past the late member.

### Reference resolution needs no new mechanism

`RunOutputResolver.resolvePriorContextItems` already takes an explicit
`groupStartBoundary` (`RunOutputResolver.ts:791-816`) and
`WorkflowExecutor.getParallelGroupStartBoundary(stepIndex)` derives it from the
group containing the member (`WorkflowExecutor.ts:1509`, `:3553`). A late
member therefore resolves `previous`/`all`/numeric refs against the same
pre-group boundary as its siblings, with no change — it cannot see the sibling
it is running beside, which is the correct and documented group semantics.

For an ad-hoc promotion the promoted step keeps whatever it already resolved
when it started (as an ungrouped step, boundary = its own index); the new
member resolves against the group's `startIndex`, i.e. the step before the one
now running. The editor should say this in the menu-item tooltip: _"Runs beside
step N. Prior context resolves from before step N."_

### Snapshot and undo consequences

`PARALLEL_STEPS_PLAN.md` Decision 8: a group captures one workspace snapshot
before it starts and re-captures after each member settles, attributed to
`queue:<startIndex>` with a `parallelGroupId` marker; per-step prompt undo is
withheld whenever width > 1, because sibling writes overlap the window.

Ad-hoc promotion inherits that cleanly, and this is the one non-obvious payoff
of promoting rather than inventing a detached sibling: the in-flight step's
own per-step "before" state **is** the group's before state (it was captured at
that step's start, before any sibling existed). On promotion, re-attribute it
as the group snapshot and drop the promoted step's per-step prompt undo. The
run then offers "Undo parallel steps N–M", which is an honest claim; per-step
undo after a join would not be.

### Why not a detached sibling

The obvious cheaper design — run the draft as a free-floating concurrent
target that is not a group member — was rejected. It has no join, so the queue
would advance past the running step while the sibling is still writing files;
it needs its own snapshot, output-attribution, stop/pause, and recovery rules;
and it would leave nothing in the run record explaining why two steps
overlapped. Promotion reuses the join, the output projection, the recovery
path, and the definition snapshot that already exist.

---

## Decision 2 — "Run in New Workflow" starts a second instance, it does not clear the first

The extension already supports several live `WorkflowInstance`s
(`WorkflowOrchestrator.instances`, `WorkflowOrchestrator.ts:331`), and
`registerNewInstance` (`:2393`) both creates one and points the calling client
at it. Running workflows stay alive in the background and remain visible in the
workflow list (`WorkflowList.tsx`, `RunningWorkflowItem.tsx`). So the feature
is a small orchestration addition, not new infrastructure.

**Do not reuse `forceNewWorkflow`.** `executeEphemeralPrompt`'s existing flag
(`WorkflowInstance.ts:3267-3290`) calls `clearWorkflow()`, which is a
documented no-op on a RUNNING/PAUSING/PAUSED instance
(`WorkflowInstance.ts:2649-2660`). Sending `true` while a workflow runs would
therefore silently append to the current workflow — the exact opposite of the
user's intent — and while it is idle it would _destroy_ the current draft
instead of starting a second workflow. No UI sends `true` today
(`PromptEditor.tsx:950-953`, `:975-979`). Once this ships, delete the parameter
rather than leave a trap; pre-release means no compatibility cost.

New path instead:

1. Webview posts `RUN_IN_NEW_WORKFLOW { text, properties, promptName }`. It is
   **not** wrapped in `postWorkflowDefinitionMutation` — there is no existing
   definition to revision-guard, and the current workflow is not being mutated.
2. `WebviewMessageRouter` routes it to a new
   `WorkflowOrchestrator.runInNewWorkflowForClient(text, properties, promptName, send, clientId)`
   which: registers a fresh instance for that client, registers the client as
   pending PTY controller (`getPtyProcessManager()?.setPendingController`, the
   same guard `executeEphemeralPrompt` applies at `WorkflowOrchestrator.ts:5626-5641`,
   otherwise every observer races to claim the new TUI), seeds it with
   `buildEphemeralWorkflowStep` + `initializeNewWorkflow`, replays state to the
   client, and starts the run.
3. The previous instance is untouched: still running, still owning its PTY
   sessions, reachable from the workflow list.

**What travels with the draft: the step's own explicit properties, and nothing
else.** The spin-off is a genuinely new workflow — global-settings defaults at
the workflow level, exactly like the header's New Workflow button — carrying one
ephemeral step built from what the user set in the editor (harness, model,
agent, skills, permissions, executionMode, conditions, hooks, color, name, and
any other `EXECUTION_PROPERTY_KEYS` override they actually chose,
`CtrlYokeTypes.ts:321-338`).

Inheriting the current workflow's `WORKFLOW_PROPERTY_KEYS` was considered and
rejected. Three reasons:

- **Two things called "new workflow" must not behave differently.** The header
  button already means "start from defaults". A menu item with the same name
  that silently starts from the current workflow's configuration is a trap.
- **Workflow-level configuration is invisible from the editor.** `hooks`,
  `preCondition`/`endCondition`, `mcpServers`, `secrets`, and
  `trustedExternalRoots` are not surfaced by the footer quick pickers. Carrying
  them means the spin-off can run validation scripts, hooks, and MCP servers the
  user never asked it to run and cannot see from where they clicked.
- **It removes a whole class of coupling.** With nothing inherited, the spin-off
  cannot contend for the source run's named worktree (no execution-lease
  conflict, no availability gate), cannot re-trigger a `trustedExternalRoots`
  approval, and needs no carve-outs for `sessionId` or `priorContext`. The
  feature reduces to "create an instance, seed one step, run it".

The step's explicit overrides still travel because they are what the user
demonstrably chose for _this prompt_ — that is the whole content of the editor.

**The three consequences worth documenting**, all of which fail visibly rather
than silently, and none of which justifies inheritance:

- **A workflow-level harness/model does not follow.** A user who set the harness
  on the workflow (not the prompt) sees `Inherit (claude-cli)` in the footer
  picker and gets the global default in the spin-off. Mitigation: the client
  switches to the new workflow immediately, where its own pickers show the
  resolved values and one click changes them.
- **`{{var}}` references in the draft do not substitute.** `vars` is
  workflow-level, so a draft written against the source workflow's variables
  arrives unsubstituted. `VarSubstitutor` already finds unresolved placeholders
  outside fenced code blocks (`VarSubstitutor.ts:63`), so this reports rather
  than silently running an incomplete prompt.
- **External-root `@` references may be inaccessible.** If the source workflow
  declared `trustedExternalRoots`, a draft referencing a file under one of those
  roots hits the new workflow's default (user/workspace) roots and fails closed
  with the usual approval path.

State the policy in the menu item's tooltip — _"Starts a separate workflow with
default settings and this prompt"_ — so the behavior is learned at the click,
not discovered afterwards.

**View switching:** switch the client's viewed workflow to the new one — the
user asked to start something and needs to watch it — and post a toast
(`ToastViewport` exists) reading _"Started 'name' — 'previous' is still
running"_ with an action that switches back. Switching silently, or not
switching at all, are both worse: the first loses the old run, the second
starts a run the user cannot see.

**Naming** falls out of the existing path: `initializeNewWorkflow` via
`generateWorkflowNameFromPrompt` derives the workflow name from the draft.

---

## Split-button component work

`SplitButton` already exists (`components/shared/SplitButton.tsx`) with the
right API (`SplitButtonOption` supports `icon`, `disabled`, `divider`,
`shortcut`) and full keyboard navigation, but it was built for the header:

- its menu is hard-coded to `absolute top-full` (`SplitButton.tsx:277`) — it
  must be able to drop **up**;
- it is sized from `HEADER_BUTTON_SIZES`, not the footer's `px-3 py-1 text-xs`;
- it renders in-flow, so it will be clipped by the editor's `overflow-clip` /
  `overflow-hidden` ancestors (`PromptEditor.tsx:1334`,
  `EditorFooter.tsx:128`).

The footer already solved the last problem: `FooterQuickPicker` portals its
popup to `document.body` with fixed positioning and
`constrainPopupToViewport`/`parsePixelProp` from `utils/dropdownUtils`
(`FooterQuickPicker.tsx:38-100`). Extract that positioning into a shared
`useAnchoredPopupPosition` hook and have both `FooterQuickPicker` and
`SplitButton` consume it, rather than growing a second copy — the popup
placement math is exactly the kind of thing this repo single-sources.

Add to `SplitButton`: `menuPlacement?: "top" | "bottom"`, a `size` variant
(or explicit class overrides) for the compact footer form, and `portal?:
boolean`. Keep `.btn-editor-run` on the **primary** button — three existing
tests select on it (`PromptEditor.test.tsx:112`, `:298`, `:694`) — and give the
chevron trigger `.btn-editor-run-menu`.

---

## Type / message changes

- `src/types/DashboardConstants.ts`
  - `ACTION_TYPES.RUN_PARALLEL: "runParallel"` — an append-and-run variant, so
    it belongs with the other actions rather than in a new message type.
  - `QUEUE_POSITION.PARALLEL_WITH_CURRENT: "parallelWithCurrent"`, plus group
    awareness in `resolveQueueInsertIndex` (`:2088-2101`). That function is
    documented as the single source for every append path, so it takes an
    optional `parallelGroups` argument rather than acquiring a second resolver
    beside it.
  - `MESSAGE_TYPES.RUN_IN_NEW_WORKFLOW: "runInNewWorkflow"`.
- `src/ui/WebviewMessageRouter.ts` — route `RUN_IN_NEW_WORKFLOW`;
  `EXECUTE_PROMPT` needs no new route, only the new action value.
- `src/core/WorkflowOrchestrator.ts` — `runInNewWorkflowForClient`; remove the
  `forceNewWorkflow` parameter from `executeEphemeralPrompt` once nothing sends
  it.
- `src/core/WorkflowInstance.ts` — handle `ACTION_TYPES.RUN_PARALLEL` in
  `executeEphemeralPrompt`: resolve the target group via
  `PromptQueue.getCurrentParallelGroup()` (`PromptQueue.ts:956-962`), append or
  promote, then ask the executor to join. **Fix the echo while you are there:**
  the ephemeral-append call at `WorkflowInstance.ts:3358-3365` omits
  `parallelGroups` and `workflowId`, unlike the `appendFromFile` echo at
  `:2761-2769` which passes both. A group-forming append through that path
  would leave the dashboard's topology stale.
- `src/core/PromptQueue.ts` — `appendParallelGroupMember` / promotion wrapper
  around the new topology helpers, bumping the definition revision like every
  other mutation.
- `src/core/ParallelGroupTopology.ts` — the two new operations above.
- `src/core/WorkflowExecutor.ts` — `ParallelGroupRun` extraction, growable
  worker pool, `joinRunningParallelGroup(stepIndex)`.
- `src/core/ParallelGroupPreflight.ts` — per-member preflight entry point.
- `src/ui/webview-react/components/shared/SplitButton.tsx` — placement, size,
  portal.
- `src/ui/webview-react/components/editor/EditorFooter.tsx` — split button in
  the new-prompt branch, menu assembly, disabled reasons.
- `src/ui/webview-react/components/editor/PromptEditor.tsx` —
  `runInParallel` / `runInNewWorkflow` callbacks beside `executePrompt`, both
  clearing the draft on success exactly like Run.
- `src/ui/WebviewSettingsSync.ts` + `settingsStore.GlobalSettings` — one new
  field carrying the effective parallel width (see Availability gates).
- `src/ui/webview-react/hooks/` — a `useRunDispatchTargets(workflowId)` hook
  returning `{ steer, parallel, newWorkflow }` availability plus reasons, so
  `EditorFooter` never reaches into `terminalStore`/`workflowStore` directly.
  It composes `useActiveInteractiveSession` from `STEER_MESSAGE_PLAN.md`.

No `schemas/workflow-schema.json` change: an ad-hoc group serializes as an
ordinary `parallel:` container, which the schema already accepts.

---

## Edge cases

- **Nothing running, "Run in Parallel" clicked from a stale menu.** Re-check
  server-side; if no in-flight queue step remains, fall back to nothing and
  toast "No step is running" rather than silently appending a normal step. The
  fallback must never be "queue it at the end" — a silent destination change is
  worse than a no-op.
- **The final step is running.** Disabled; parallel `finalStep` is unsupported
  by the shipped plan and the coordinator has no group to join.
- **Effective width is 1** (`queue.maxParallelSteps: 1`, or a closed
  `PARALLEL_GROUP_FAN_OUT_ENABLED` in a test build). Disabled with a tooltip
  naming the setting. Accepting the join and running it _after_ the in-flight
  step would deliver the opposite of the action's promise.
- **Pool already at width.** Accepted; the member waits for a free slot. The
  steps panel shows it pending inside the group.
- **Repeated clicks.** Each appends another member; `endIndex` keeps growing.
  No special casing.
- **Pausing/paused.** Disabled while `PAUSING`; while `PAUSED` there is no
  in-flight member, so this is the ordinary Run path — no group forms.
- **Script drafts.** Allowed. Script steps are legal group members and
  interactive script PTYs are already multi-session. Steer stays prompt-only.
- **Stop during a group with a late member.** Identical to any other member —
  the group's abort controller and the resource registry already cover it.
- **Crash/reload after a promotion.** The promoted group is in the working
  file, so recovery restores it and schedules only unsettled members. This is
  precisely why the ad-hoc group is persisted rather than kept in memory.
- **Save As after a promotion.** The authored file contains a real `parallel:`
  container. That is accurate history: those steps did run concurrently.
- **Undo/redo of a promotion.** `parallelGroups` is in the zundo `partialize`
  set (`workflowStore.ts:1821-1828`), so the topology change is undoable in the
  webview — but it is a runtime-driven mutation and must arrive through
  `withUndoPause`, like the other runtime echoes, so running a workflow never
  enables Undo.
- **Viewer vs controller.** Unlike steer, both new actions are ordinary
  definition mutations / instance creation and inherit today's guards. No new
  privilege question.
- **`RUN_IN_NEW_WORKFLOW` while the current run is externally managed** (CLI
  watch mode). The footer is disabled wholesale in that mode, so this cannot be
  reached; no special handling.
- **Draft references `{{vars}}` or external-root files.** Neither travels to a
  spin-off (Decision 2). Both fail loudly — unresolved placeholders are
  detected, external roots fail closed with the approval path — so no special
  handling beyond the tooltip wording.
- **Source workflow uses a named worktree.** Irrelevant to the spin-off, which
  never inherits it and therefore never contends for its execution lease.

---

## Implementation stages

**Stage 1 — Split-button shell (shared with `STEER_MESSAGE_PLAN.md`).**
`useAnchoredPopupPosition` extraction, `SplitButton` placement/size/portal
props, `EditorFooter` split button with a single always-enabled item ("Run in
New Workflow") plus disabled placeholders. New `EditorFooter.test.tsx` (none
exists today).

**Stage 2 — Run in New Workflow.** `RUN_IN_NEW_WORKFLOW` message,
`runInNewWorkflowForClient`, pending-controller registration, view switch and
toast, `forceNewWorkflow` removal.

**Stage 3 — Executor late join.** `ParallelGroupRun` extraction, growable
worker pool, per-member preflight, `joinRunningParallelGroup`. Testable on its
own against an authored group with no UI at all. **Blocked on
`PARALLEL_STEP_MUTABILITY_PLAN.md` Stages 1–3**, which share the
`ParallelGroupRun` extraction and supply the guard this stage assumes.

**Stage 4 — Topology + ad-hoc promotion.** `appendParallelGroupMember`,
`promoteStepToParallelGroup`, snapshot re-attribution, `PromptQueue` wiring,
the `WorkflowInstance` echo fix.

**Stage 5 — Run in Parallel wiring and gates.** `ACTION_TYPES.RUN_PARALLEL`
end to end, `useRunDispatchTargets`, tooltips, rejection toasts.

**Stage 6 — Steer item.** Owned by `STEER_MESSAGE_PLAN.md`; only the menu entry
belongs here.

---

## Test strategy

- `src/ui/webview-react/test/components/editor/EditorFooter.test.tsx` (new):
  menu contents per state, disabled reasons, that `.btn-editor-run` still fires
  Run, drop-up placement, keyboard navigation.
- `PromptEditor.test.tsx`: each menu action posts the right message with the
  right action value and clears the draft.
- `src/test/unit/ParallelGroupTopology.test.ts`: append extends `endIndex` and
  shifts later groups; promotion produces a valid two-member group; both reject
  a settled/cancelling group; existing push-out behavior of
  `resolveParallelGroupInsertIndex` is unchanged.
- `src/test/unit/WorkflowExecutor.*`: a member joined mid-fan-out runs, the
  join waits for it, a rejected member leaves the group healthy, width-limited
  joins wait for a slot, stop/pause during a late join settles cleanly.
- `src/test/integration/`: promotion of a sequential in-flight step produces a
  persisted group, a group-level snapshot, correct `groupStartBoundary` for the
  new member, and a recovery that reruns only unsettled members.
- `src/test/unit/WorkflowOrchestrator.test.ts`: `runInNewWorkflowForClient`
  leaves the previous instance running and rebinds only the calling client.

---

## Not in scope (YAGNI)

- Keyboard shortcuts for the menu items (the split button's own keyboard nav
  aside). Revisit once usage patterns are known.
- A "Queue Next" menu item or a Queue split button.
- Choosing _which_ running step or group to run beside — always the group
  containing `currentIndex`, appended at its end.
- Carrying workflow-level properties (`worktree`, `vars`, `hooks`, conditions,
  `mcpServers`, `secrets`, `trustedExternalRoots`) into a spin-off — a
  deliberate exclusion, see Decision 2, not a deferral.
- Steering or parallel dispatch while editing an existing queued step. Both are
  new-prompt-mode only.
- Any DAG/`dependsOn` scheduling, per-member worktrees, or cross-member
  coordination — see `EXECUTION_ROOT_COORDINATION_PLAN.md` for the latter.
- A "Run in Parallel" entry point outside the editor (e.g. the steps panel
  context menu).

---

## Settled questions

Every question this plan opened has been answered; nothing here is blocking.

1. **Which group does a join target, with several members in flight?** The
   group containing `currentIndex`, appended at its end (Decision 1). If a
   group is already running it is extended; if not, the in-flight sequential
   step is promoted into a new two-member group.
2. **Menu wording.** "Run in Parallel" — it matches the shipped feature's
   vocabulary (`parallel:`, "parallel steps N–M"). Everything else the user
   needs (which steps it runs beside, that prior context resolves from before
   the group, that a busy pool means it waits) goes in the tooltip, not the
   label.
3. **What the width gate means.** Only `effective width === 1` disables the
   item. Saturation — all `maxParallelSteps` slots busy — is normal operation:
   the member is appended and runs when a slot frees. The webview needs the
   effective width surfaced in the lightweight settings payload, since
   `fullGlobalSettings` is only fetched when the Global Settings drawer opens.
4. **Does a spin-off inherit workflow properties?** No. It starts from
   global-settings defaults like the header's New Workflow button, carrying only
   the step's own explicit overrides (Decision 2). This was reversed from an
   earlier "inherit everything" position: inheritance would have made two
   controls named "new workflow" behave differently, carried invisible
   configuration (hooks, conditions, MCP servers, trusted roots) into a workflow
   the user thinks of as fresh, and forced an availability gate for named
   worktrees. Not inheriting deletes all three problems.
5. **Toast on the new-workflow view switch.** Keep it: switch the view and post
   a toast naming the still-running source workflow with an action to switch
   back. No suppression setting in v1.
