# Workflow Variants: Duplicate

> **Status:** Implemented — Phases 1–3 complete; acceptance criteria verified
>
> **Priority:** P2 — lightweight multi-harness comparison
>
> **Related:** `WORKFLOW_CONTEXT_MENU_PLAN.md` (one of Duplicate's entry points),
> `PROMPT_TOTAL_TOKEN_USAGE_PLAN.md`, `WORKTREE_SUPPORT_PLAN.md`

---

## Problem

ctrlyoke already has the important comparison mechanics:

- run navigation can switch a client between a lineage's draft and stored runs;
- each hosted browser tab owns its selected workflow/run and has a deep-linkable
  URL, so two tabs provide side-by-side viewing;
- distinct workflows can execute in parallel;
- Save As can export a clean workflow definition.

The remaining friction is creating the second workflow. Today a user who wants
to compare two harnesses must Save As, choose a file, open the exported file,
and then change its harness. Save As is an export operation: it does not create,
register, and open a new independent lineage.

Do not build a native split view, run-alignment service, evaluator, or comparison
report merely to remove this setup friction.

---

## Decision record: one command, not two

An earlier revision of this plan proposed two user-facing actions — **Duplicate
Workflow** (source: the lineage's draft) and **Fork as New Workflow** (source:
the addressed draft _or_ historical run). Checked against the current code, that
split does not survive:

### 1. "The lineage's draft" usually does not exist

`WorkflowLineageRepository.allocateRun` sets
`draftFilePathToRemove: isFirstRun ? draftFilePath : undefined`, and the caller
deletes it. A lineage has a draft **only before its first run**, or while a
`pendingEdit` is open — which is exactly how `WorkflowSerializer.getRecentWorkflows`
computes the flag the UI uses:

```typescript
const hasDraft =
  !descriptor.latestRunRef || descriptor.pendingEdit?.kind === "draft";
```

So a Duplicate defined as "copy the draft" is unavailable on the overwhelming
majority of lineages — every one that has run at least once. The definitions
that reliably exist and are addressable are **runs**.

### 2. Once Duplicate has to accept a run source, Fork has no remaining job

Both commands would then take a `WorkflowViewAddress`, read that address's
working file, strip runtime, apply a name and optional overrides, and write a new
lineage's draft. Same service, same dialog, same result. The only difference left
is which address the invoking control passes — and that is a property of the
entry point, not of the command.

### 3. "Fork" already means something else here

The codebase already spends "fork" on same-lineage operations: commit `659cfda7`
is _"fork promoted runs into drafts for edits"_, and
`WORKFLOW_CONTEXT_MENU_PLAN.md` uses "forks history" for re-run. Both stay
_inside_ one lineage. A user-facing **Fork** that means "leaves the lineage"
inverts the word against its established use here.

**Decision:** ship one command, **Duplicate Workflow…**, whose source is an
explicit `WorkflowViewAddress` supplied by whichever control invoked it. The
dialog names that source on screen so the user can see what is being copied.

**What would reopen this:** a second operation that produces a materially
different artifact — copying run history, or creating a variant _inside_ the
source lineage rather than beside it. Neither is in scope (see Non-goals). A
different default source alone is not enough to justify a second menu item.

---

## Not this: `seedNewRun`

`WorkingFileManager.seedNewRun(workspaceRoot, workflowKey, fromRunRef, { harness?, model? })`
already copies a run's definition and applies harness/model overrides. It is the
existing "re-run this with a different harness" path, and it is **not** what this
plan adds: it allocates the new run **inside the same lineage**, so both variants
share one row in the workflow list, one name, one favorite flag, and one
interleaved run history.

Duplicate is the same copy step targeting a **new lineage**. Read `seedNewRun`
before implementing — its override shape, its runtime stripping, and its
descriptor handling are the template, and the two should not drift.

---

## Semantics

One operation:

> **Duplicate Workflow** — read the definition at an explicit
> `WorkflowViewAddress`, and create a new, independent workflow lineage whose
> draft is that definition under a new name, with optional harness/model
> overrides.

### Source resolution

The source is always an address the invoking control already holds. There is no
implicit "latest run" fallback anywhere — a control that cannot name an address
does not offer the command.

| Invoked from                           | Source address                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| Header / `WorkflowControls`            | `uiStore.displayedViewAddress` — the run or draft this client is looking at right now    |
| A run-panel row                        | that row's own address (draft, or `run:<runRef>`)                                        |
| A recent or running row's context menu | that lineage's primary address (`RecentWorkflow.address` — its latest run, or its draft) |

This answers the question the two-command split was trying to answer. Duplicating
from the header while viewing run 2 duplicates **run 2**, not the latest run.
That is not a special case invented for this feature — it is the rule Save As
already follows: `Header.handleSave` posts `SAVE_WORKFLOW_REQUEST` with
`address: displayedViewAddress`, and the header's `RunIdentityBadge` is already
on screen naming which run that is.

### What is copied

The authored definition: prompts, scripts, conditions, workflow properties,
agents, skills, MCP configuration, granular permissions, worktree setting.

### What is not copied

Run history, execution state, timestamps, output, session IDs, runner locks,
favorite state, undo history, `_runtime`, `pendingEdit`.

### Naming

Default `<source name> Copy`, editable in the dialog.

**No uniquifying logic is needed.** `WorkflowPaths.allocateWorkflowKey` slugifies
the name hint, appends an ISO timestamp, and retries on `EEXIST`, so two
lineages may carry the same display name without conflict. Do not add a
"Copy (2)" allocator; do not validate the name as a filename the way
`SaveWorkflowDialog` does with `validateSafeName` — nothing here becomes a path
component verbatim.

### Overrides are workflow-level only — never touch step overrides

`PromptStep extends ExecutionProperties`, so individual steps can pin their own
`harness` and `model`, and a step-level pin wins over the workflow-level one.

**The override sets the workflow-level field and nothing else.** It never
rewrites, clears, or inspects a step's own `harness`/`model`. This is exactly
what `seedNewRun` already does, and Duplicate must not diverge from it:

```typescript
...(overrides.harness ? { harness: overrides.harness } : {}),
```

**Why this is not negotiable.** Per-step harness pins are frequently the _point_
of a workflow, not an incidental setting. Consider:

```
step 1: have Claude draft a plan          (claude-cli pin)
step 2: have Copilot draft a plan         (copilot-cli pin)
step 3: have Antigravity draft a plan     (antigravity-cli pin)
step 4: synthesize the final plan         (workflow default)
step 5: implement the final plan          (workflow default)
```

Clearing the pins here does not produce a variant of this workflow — it destroys
it, collapsing three deliberately different authors into one. And the bake-off
this workflow's owner actually wants is "which harness _synthesizes and
implements_ best," which is precisely a change to the workflow-level default
with steps 1–3 left alone. The narrow rule serves the comparison use case
_better_ than the broad one, not merely more safely.

An earlier revision of this plan proposed clearing step pins under an override.
It was wrong; do not reintroduce it, and do not add a "also apply to all steps"
checkbox — that is a bulk-edit feature, and it belongs to the step editor if it
belongs anywhere.

**What carries the honesty instead is the label.** The dialog's fields are named
**Workflow Harness** and **Workflow Model**, so a user who expected their step
overrides to move is told the scope before they submit rather than surprised
after. No warning text, no conditional hint — the label is the whole mechanism.

Note that this needs no defensive code: `stripStepRuntime` removes only
`_runtime`, and `stripViewOnlyWorkflowStepFields` removes only `status`/`details`.
Neither reads `harness` or `model`, so steps carry their pins through the copy by
construction. Preserving them is the default, not a rule the service enforces.

### Provenance

The new descriptor records source `workflowKey`, source `runRef` when the source
was a run, source display name, and creation time — new optional fields on
`WorkflowLineageDescriptor`. Pre-release, so no descriptor migration is needed
and `DESCRIPTOR_SCHEMA_VERSION` need not change; older descriptors simply lack
the fields.

Informational only: the two histories are independent, and deleting either
lineage must not invalidate the other. Do not render a provenance chain UI in
this plan.

---

## Where the controls live

Four entry points, one command, one dialog. Every one of them resolves to a
`WorkflowViewAddress` before opening the dialog.

### 1. `WorkflowControls.tsx` — the New split button _(primary)_

A fourth dropdown option after "Queue from File…". This is the right home
because every other item in that menu creates a workflow, and because the file
**already subscribes to exactly the state the command needs** —
`const { displayedViewAddress } = useUiStore()`, currently used only for the
`isViewingRun` label switch.

Follow that same label convention, which already exists in this file:

```typescript
{
  label: isViewingRun
    ? "Duplicate This Run as New Workflow…"
    : "Duplicate Workflow…",
  value: "duplicate-workflow",
  icon: <i className="codicon codicon-copy" />,
  onClick: handleDuplicateWorkflow,
  disabled: !displayedViewAddress,
}
```

The label change is what keeps "which snapshot?" honest at the moment of
invocation, before the dialog confirms it.

### 2. Run-panel rows — `RunSummaryRow` inside `RunPanel.tsx`

**This is the "draft/run actions" the earlier revision of this plan referred to
without naming.** `RunPanel` is the drill-in view of one lineage's draft + run
history (reached from a workflow row's run indicator or the header's
`RunIdentityBadge`), and `RunSummaryRow` renders one row per draft/run. Today
each row's `RowActionRail` holds only Delete.

Duplicate joins these rows **through the context menu**, not as a rail button —
the rail is deliberately narrow and its width is reserved on every row to keep
the time column aligned.

This is the surface where per-run duplication is unambiguous, and it is the one
`WORKFLOW_CONTEXT_MENU_PLAN.md` does not currently cover. See that plan's
"Fourth surface" section.

### 3. Recent and running rows — the workflow context menu

`RecentWorkflowRow` and `RunningWorkflowItem`, via
`WORKFLOW_CONTEXT_MENU_PLAN.md`'s menu. Source is the row's primary address.

### 4. The header split button — the workflow context menu

`WorkflowStatus.tsx`'s `workflow-split-button`, via the same menu. Source is
`displayedViewAddress`, identical to entry point 1. Both exist because the
split-button menu is where the other whole-workflow actions (favorite, delete)
live, while the New menu is where creation lives; the command is the same either
way.

**Not an entry point:** the step context menu, the output context menu, or any
per-step affordance. Duplicate is a whole-workflow operation.

---

## The dialog

New `DuplicateWorkflowDialog`, over the shared `Modal`. Deliberately much smaller
than `SaveWorkflowDialog` — read that component to see what **not** to copy.

| Field            | Control                      | Default                                 | Notes                                                                                                               |
| ---------------- | ---------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Source           | read-only text               | `"<Name> · Run 3"` / `"<Name> · Draft"` | Not editable. Label it with the same helper the header uses (`viewedRunLabel`) so the wording matches the badge.    |
| Name             | text input, autofocus+select | `<source name> Copy`                    | Required, non-empty. No filename validation.                                                                        |
| Workflow Harness | select                       | "Same as source"                        | Options from `HARNESS_IDS`. The word **Workflow** is load-bearing — see above; do not shorten it back to "Harness". |
| Workflow Model   | select                       | "Same as source"                        | Filtered by the selected harness; see `ModelConstants.ts`.                                                          |

Footer: **Cancel** / **Duplicate**. Enter submits when the name is non-empty.

### Decided: the harness/model fields stay, workflow-scoped

Weighed and settled. Dropping them was seriously considered — they serve a
**niche** case, and the plan should not pretend otherwise: most duplicates are
"same workflow, different prompt / permissions / conditions," and those need only
the name.

They stay because, scoped to the workflow level, they cost one line of request
payload and two selects that default to inherit — the name-only path is still one
field and one Enter — and because they remove the "duplicate, open the copy, find
the harness setting, change it" round trip for the comparison this feature was
justified by.

Do not respond to their niche-ness by growing them: no post-creation "configure
now?" prompt, no third field, no step-scoped variant. Two inherit-by-default
selects is the whole of it.

Explicitly **absent**, and why:

- **No location / format / Browse.** Duplicate creates a lineage in run storage,
  not a file on disk. `SaveWorkflowDialog`'s location picker, format toggle, and
  `BROWSE_SAVE_LOCATION` plumbing have no analogue here.
- **No overwrite check.** There is no destination path to collide with; see
  Naming above. Do not port `CHECK_SAVE_PATH`.
- **No bundle preview.** Nothing is inlined, copied, or pruned — see the
  sanitizer note below.
- **No "also run it" checkbox.** See Concurrency and Worktrees.

On success the requesting client navigates to the new draft
(`navigateToWorkflowAddress`) and the dialog closes; the toast names the new
workflow. On failure the dialog stays open with the error inline, so the typed
name is not lost. Announce both accessibly and restore focus to the invoking
control when the dialog closes.

---

## Shared clone contract

One platform-neutral application service, not file manipulation reproduced in the
React client, VS Code adapter, CLI, or hosted server.

```typescript
interface CreateWorkflowVariantRequest {
  requestId: string;
  source: WorkflowViewAddress;
  workflowName: string;
  overrides?: {
    harness?: HarnessId;
    model?: string;
  };
}
```

### Where it lives

- **Service:** a new `WorkflowVariantService` under `src/core/orchestration/`,
  next to `WorkflowLineageRepository` and `RunContinuationService`. It composes
  `WorkflowLineageRepository` + `WorkingFileManager` and takes a `workspaceRoot`
  — no VS Code, webview, or server types, so the CLI and MCP binaries could call
  it later without a rewrite.
- **Not on `WorkflowSerializer`.** That class is the webview's
  read/serialize/export layer; creating a lineage is not serialization.
- **Not on `WorkflowOrchestrator`.** Duplication touches no live instance, no
  client view binding, and no PTY. Keeping it out avoids the viewed-address and
  revision-assertion machinery that every orchestrator entry point carries and
  that this operation genuinely does not need.
- **Routing:** three entries in `WebviewMessageRouter`'s dispatch table —
  `CREATE_WORKFLOW_VARIANT` in, `WORKFLOW_VARIANT_CREATED` /
  `WORKFLOW_VARIANT_FAILED` out, correlated by `requestId` and addressed to the
  requesting `ctx.clientId` only. Add all three to `MESSAGE_TYPES`.
- **Reply through `ctx.postMessage`, never a broadcast.** `CtrlYokeHostedServer`
  exposes a `broadcast` helper that several handlers use; using it here would
  navigate every connected hosted tab to the new draft, violating this plan's
  "other clients keep their selection" criterion. The hosted server otherwise
  passes these messages straight through — it intercepts only heartbeat/theme/
  preview types — so no server-side change is needed beyond the shared
  `MESSAGE_TYPES` additions.
- **Delivery is request-id idempotent.** The router keys a bounded, expiring
  reply cache by `(ctx.clientId, requestId)` so hosted reconnect retries replay
  one creation result without allocating a second lineage. The webview retains
  the exact payload, reissues it on an interval, and retires it with an inline
  error after a bounded number of attempts; late replies are ignored.

The service:

1. resolves the exact `WorkflowViewAddress` to its working file
   (`WorkflowPaths.runFilePath` / `draftFilePath`);
2. reads that working file;
3. strips runtime through the **existing** step sanitizers;
4. applies the new name and optional overrides;
5. allocates a new lineage through `WorkflowLineageRepository.createLineage`;
6. writes the new draft atomically through `WorkingFileManager`;
7. returns the new draft address.

### Use the working-file sanitizer, not Save As's export allowlist

An earlier revision said to extract Save As's clean-workflow allowlist from
`WorkflowSerializer` and share it. **Do not.** `WorkflowSerializer.buildCleanWorkflow`
produces an _export document_: it drops `workflowName`, `startedAt`, and
`originalFile`, and the Save As path around it also inlines and bundles assets.
A new lineage's draft is a `WorkingFile` and needs those fields.

The correct reuse already exists and is already shared:
`stripStepRuntime` + `stripViewOnlyWorkflowStepFields` from
`WorkflowStepSanitizer`, applied exactly as `seedNewRun` applies them. Duplicate
is another caller of that pair, not a new definition of "runtime-free workflow."

> **`seedNewRun` is the only model left.** A sibling primitive,
> `WorkingFileManager.seedDraftFromRun`, applied the same sanitizer pair and
> would have looked like a second template — but it was deleted on 2026-08-16 as
> dead code (added by `659cfda7` for
> `WorkflowOrchestrator.prepareDefinitionMutation`; orphaned by `a32f5ef2`
> "phase 2 of RUN_HEAD_MUTABILITY", which moved promoted runs to being validated
> in place with "no draft fork, no instance rebinding"). If you find it in
> history, do not resurrect it as a starting point: it set
> `pendingEdit = { kind: "draft" }` on the source descriptor, and Duplicate must
> never write to the source at all.

### Atomicity

Creation is all-or-nothing. If the draft write fails after
`createLineage` has allocated the key, remove only the newly allocated
incomplete lineage and report the failure. The source lineage is read-only
throughout — no descriptor lock on the source, no revision expectation, because
duplication does not mutate it. (This is the one place Duplicate is _simpler_
than `seedNewRun`, which must guard the source descriptor because it writes to
it.)

---

## Comparison flow

1. author one workflow;
2. duplicate it;
3. choose a different workflow harness/model in the dialog (steps that pin their
   own harness keep it — that is usually what you want);
4. run each workflow;
5. switch between their rows, or open each URL in a separate browser tab;
6. compare status, output, changed files, duration, and workflow total tokens.

`PROMPT_TOTAL_TOKEN_USAGE_PLAN.md` adds aligned workflow-total token usage to
`WorkflowList.tsx`, making the common harness comparison visible without a
dedicated comparison engine.

If the user does _not_ want a second row in the workflow list — just the same
workflow re-run under a different harness — the existing `seedNewRun` path
already covers that, and Duplicate is the wrong tool.

---

## Concurrency and worktrees

Creating variants does not imply that it is safe to run both at the same time in
one checkout. Parallel workflows can edit the same files and interfere.

- Do not add a **Race** or **Run Both** action, and do not add an "also run it"
  option to the dialog.
- Sequential execution remains fully supported.
- Users may manually run variants in parallel under the existing behavior.
- Coordinated simultaneous launch belongs after `WORKTREE_SUPPORT_PLAN.md` can
  give each write-capable workflow an isolated checkout.

---

## Implementation Phases

### Phase 1 — Shared clone service

- [x] Add `WorkflowVariantService` (`src/core/orchestration/`) over
      `WorkflowLineageRepository.createLineage` + `WorkingFileManager`, reusing
      `stripStepRuntime` / `stripViewOnlyWorkflowStepFields`. Model it on
      `WorkingFileManager.seedNewRun`.
- [x] Support both draft and run source addresses.
- [x] Apply overrides to the **workflow-level** `harness`/`model` only, exactly
      as `seedNewRun` does. Step-level pins are copied through untouched.
- [x] Add the three message types and their `WebviewMessageRouter` entries,
      `requestId`-correlated and delivered to the requesting client only.
- [x] Roll back the allocated lineage if the draft write fails.
- [x] Add the provenance fields to `WorkflowLineageDescriptor` and record them.
- [x] Unit tests (`src/test/**`): exact-source resolution for a draft and for a
      non-latest run; runtime stripping; override application; **a multi-harness
      workflow whose steps pin three different harnesses keeps all three pins
      after a duplicate that overrides the workflow harness**; provenance;
      rollback of incomplete creation; source lineage byte-identical afterward;
      two duplicates of the same workflow coexisting with the same display name.

### Phase 2 — Duplicate UX

- [x] Add `DuplicateWorkflowDialog` (source / name / workflow harness / workflow
      model).
- [x] Add **Duplicate Workflow…** to `WorkflowControls`'s dropdown, with the
      `isViewingRun` label switch and disabled when there is no displayed
      address.
- [x] Add **Duplicate Workflow…** to the workflow context menu
      (`WORKFLOW_CONTEXT_MENU_PLAN.md`) on recent rows, running rows, the header
      split button, and run-panel rows.
- [x] Refresh recent workflows and switch **only the requesting client** to the
      new draft.
- [x] React tests (`src/ui/webview-react/test/**`): the dialog names the
      displayed run as source when the header shows a non-latest run; a
      run-panel row duplicates _that_ row's address; dialog validation; success
      navigation; failure keeps the dialog open with the typed name; focus
      restoration; other clients keep their selection.

### Phase 3 — Hosted convenience

- [x] Add **Open in New Tab** after creation, using the existing serialized
      workflow-address route.
- [x] Verify two tabs retain independent selected addresses during live updates.
- [x] Keep native split view out of scope until user evidence shows browser tabs
      are insufficient.

---

## Acceptance Criteria

- Any addressable definition — the draft, or any stored run — can be duplicated
  into a new independent lineage without exporting or reopening a file.
- Duplicating from the header while viewing run 2 copies run 2, not the
  lineage's latest run.
- Duplicating from a run-panel row copies that row's run.
- The dialog states the source on screen before the user confirms.
- The source lineage, its descriptor, and its run history are unchanged.
- The new lineage contains no `_runtime`, output, sessions, locks, timestamps,
  favorite state, `pendingEdit`, or inherited history.
- The new lineage opens as a draft, ready to run.
- Harness/model overrides are applied only to the new draft, and only to its
  workflow-level fields.
- Every duplicate preserves the source's per-step harness/model pins exactly,
  with or without an override.
- The dialog's fields read **Workflow Harness** and **Workflow Model**.
- Two lineages with the same display name coexist without error.
- Other connected clients keep their current workflow/run selection.
- Duplicate reuses `WorkflowStepSanitizer`, not `WorkflowSerializer.buildCleanWorkflow`.
- No harness execution is launched as a side effect.

---

## Non-goals

- A second command (**Fork as New Workflow…**) — see the decision record.
- Clearing, rewriting, or bulk-applying step-level `harness`/`model`, and any
  "apply to all steps" checkbox in the dialog.
- Copying or linking run histories.
- A provenance chain / lineage graph UI.
- Duplicating into the _same_ lineage — that is `seedNewRun`, which exists.
- A `ctrlyoke duplicate` CLI command or an MCP tool. The service is written
  platform-neutral so either could be added later, but neither ships here.
- A native split-screen comparison view.
- Step alignment, scoring, or an AI evaluator.
- A universal harness leaderboard.
- Automatically executing the new variant.
- Safe same-checkout racing before worktree isolation.
