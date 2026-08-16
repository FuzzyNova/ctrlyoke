# Workflow Context Menu

> **Status:** Proposed
>
> **Priority:** P2 — one new affordance (Copy Run Directory Path) plus the
> gesture infrastructure that Duplicate/Fork will land on.
>
> **Related:** `WORKFLOW_VARIANTS_PLAN.md` (Duplicate / Fork are future items in
> this same menu), `MCP_RUN_PATH_FIELDS_PLAN.md` (same "where is this run?"
> question, MCP side), `RUN_EXPORT_PLAN.md`,
> `dev/implemented/USER_SCOPED_RUN_HISTORY_PLAN.md`

---

## Problem

Workflow actions are reachable only through visible controls, split across three
surfaces: the header's execution slots (displayed workflow only), a recent row's
`RowActionRail` (favourite, remove), and a running row's rail (pause,
cancel-pause, resume, stop). Anything that does not fit a rail has nowhere to go.

More concretely: run history moved out of the workspace in
`USER_SCOPED_RUN_HISTORY_PLAN.md`. A run now lives under
`<ctrlyokeStateHome>/projects/<slug>-<hash12>/.runs/<workflowKey>/run-<ts>/`.
That directory name is deliberately unguessable (§3.1 chose `hash12` for exactly
that property), and **no UI anywhere will tell you what it is**. §3.2 anticipated
users needing to map an opaque hash directory back to a project; this is the
forward direction, and today the only way to answer "where is this run?" is to
compute a SHA-256 by hand.

A right-click / long-press menu gives that a home, and gives Duplicate and Fork
(`WORKFLOW_VARIANTS_PLAN.md`) somewhere to land later.

---

## Product Decision

Add one context menu, opened by right-click or long-press, on:

1. each row of the workflow dropdown — recent rows (`WorkflowList.tsx`'s
   `RecentWorkflowRow`) and running rows (`RunningWorkflowItem.tsx`); and
2. the header's workflow split button (`WorkflowStatus.tsx`), targeting the
   currently displayed workflow.

Same menu, same hook, same item set. The target is whichever row was
right-clicked, or the displayed workflow for the header.

### Item set

| Item                           | Message                    | Notes                                           |
| ------------------------------ | -------------------------- | ----------------------------------------------- |
| Copy Run Directory Path        | none (clipboard)           | New. See below                                  |
| — divider —                    |                            |                                                 |
| Add to / Remove from Favorites | `TOGGLE_WORKFLOW_FAVORITE` | Address-only today; free                        |
| Delete                         | `REMOVE_WORKFLOW_HISTORY`  | Address-only; honours `confirmDeleteOperations` |

**No execution items.** Not Run, not Re-run, not Continue, not Resume, not
Pause/Stop. See the decision record below — this is the plan's main finding and
it should not be quietly re-litigated.

Be honest about the resulting size: this is a three-item menu. Its value is the
Copy item, which has no alternative, plus the gesture wiring that
`WORKFLOW_VARIANTS_PLAN.md` needs. It is not a productivity feature for
execution.

---

## Decision record: why no execution items

The original request was a Re-run item so a favourited workflow could be started
from its row without opening it. Three findings, checked against current code,
say that cannot be delivered as imagined and is not worth delivering in the form
that _is_ possible.

### 1. There are no clicks to save

From an open dropdown: today is left-click row → click Run in the header (two
clicks). Via the menu: right-click row → click Re-run (two clicks). The menu
relocates the second click, it does not remove it. What it would genuinely save
is the _return trip_ — not having to come back once the view loads.

### 2. "Run it without opening it" is not architecturally available

`seedAndExecuteAtRun` calls `switchClientToPreparedExecution(instance, clientId)`
and `getPtyProcessManager()?.setPendingController(instance.id, clientId)` —
starting a run **makes the requesting client that run's view and PTY
controller**. Even with navigate-then-run sequencing built, the user lands on the
run they started. This is not a gap to route around; it is how execution binds
output to a client.

The supported way to start a run without taking over a view is the CLI
(`ctrlyoke run`), which is a separate runner with its own lock.

### 3. Every execution message needs something a row menu does not have

Two buckets, no third:

**Needs the requesting client's viewed address.**
`WorkflowOrchestrator.assertViewedRunAddress()` guards `seedAndExecuteAtRun`,
`continueAtRun`, `setStartPositionAtRun`, and `appendAndContinueAtRun`, throwing
`"<action> no longer targets this client's viewed run"`; `executeDraftAtAddress`
performs the same check inline. All four also require
`expectedDefinitionRevision`/`expectedDescriptorRevision`, which the client holds
only for the address it displays.

**Needs a live in-memory instance.** `pauseAtRun`, `cancelPauseAtRun`,
`resumeAtRun`, and `stopAtRun` all resolve through
`getExecutionInstanceAtRun`, which throws `"The requested run is no longer
executing"` when no instance matches. So `RESUME_RUN` works _only_ for a run
already executing or paused in this host — exactly the rows that already carry
rail buttons in `RunningWorkflowItem`.

> An earlier revision of this plan claimed Resume was free on any row and would
> newly reach `STOPPED`/`ERROR` runs. **That was wrong.** Those runs have no live
> instance; resuming them goes through the header's `resume` slot, which falls
> back to `CONTINUE_RUN` — the viewed-address-asserted path. `Header.handleSlotAction`
> encodes exactly this: `RESUME_RUN` when `executionRunAddress` exists, else
> `postViewedRunAction(CONTINUE_RUN)`.

So there is no case where a menu item extends reach beyond what the header and
the running rail already provide.

### 4. Secondary: blast radius on an unseen target

Not decisive on its own — the header's Run is also a single unconfirmed click —
but it points the same way. The header acts on a workflow whose steps, harness,
model, and worktree setting are on screen. A row menu acts on one the user
cannot see, and Re-run is not idempotent: it seeds a new `RunRef`, forks
history, spends tokens, and may write to the repo. On mobile, long-press into a
small menu item is a plausible mis-tap.

### If this is ever revisited

The only deliverable version is navigate-then-run, and it must be described as
"open and run in one gesture," never "run in the background":

1. The item calls `navigateToWorkflowAddress(vscode, target)`, which returns a
   `requestId` from `uiStore.requestRunViewLoad`.
2. Store `pendingTargetedRunAction: { requestId, action }` in `uiStore`.
3. In `useMessageHandler`'s `RUN_VIEW_LOADED` branch, once the snapshot for that
   exact `requestId` is _applied_ (revisions known), fire the execution message
   and clear.
4. Clear without firing on every terminal outcome: `rollbackRunViewLoad`,
   `useRunViewLoadWatchdog` give-up, `WORKFLOW_ACTION_FAILED`.

Three constraints, all existing scar tissue: never re-issue the execution
message (`standalone-shim.js` drops outbound messages while disconnected, on
purpose, because queuing once replayed a pre-outage Re-run click and launched a
run with no user action — the navigation is already reissued and retired by the
watchdog, so the execution rides on that outcome); bind to the exact `requestId`
rather than the address, so a backend-initiated view change cannot trigger a
run; and keep at most one pending action, replaced rather than queued.

---

## Copy Run Directory Path

Copies the **run directory**, not the working file — that is what gets pasted
into a debugging session, and it is what an investigating agent needs (the
working file, `events.jsonl`, and `manifest.json` are all inside it). No submenu.

### Public, not developer-only

Ship it to everyone. The user-scoped move created this need and left no other
answer for it: the run directory is under a hashed project path that nothing in
the UI names. The non-developer version of the need is identical — "I hit a bug
on step 4, here's the run" is what `src/templates/agents/ctrlyoke-tech-support.agent.md`
exists for, and it needs a path. Cost is one menu item; risk is a read-only
clipboard write.

The one argument for hiding it — `USER_SCOPED_RUN_HISTORY_PLAN.md` §3.2 calling
the user state tree private data, mode `0700`/`0600` — is about filesystem
permissions, not about hiding a location from the person who owns it.

**Do not gate on `IS_DEV_MODE`.** It is build-time and extension-side; reaching
it from the webview means a new plumbed setting, which is more machinery than
the item.

### Hosted-mode caveat

In hosted browser mode the path names a location on the **server's** filesystem,
which may not be the viewer's machine. Copy it anyway — the usual viewer is the
same person — but say so in the item's `title`.

### Resolving the path

The webview cannot compute it: `WorkflowPaths` is extension-side, and after the
user-scope move the runs root depends on `projectStateRoot()` and the frozen
`storage.runHistoryLocation`. The extension must send it.

**The path must track the _address_, not the lineage.** This is the one trap
here. A lineage's recent-list entry describes its _primary_ (latest) address, but
the header can be displaying an older run — view run 2 of a lineage whose latest
is run 5, right-click the header, and a lineage-keyed lookup hands back run 5's
directory. Silently wrong, and wrong in the exact debugging scenario the item
exists for.

So `runDirectory` goes on the messages that establish an address, not on a
per-lineage lookup:

| Target             | Source                                                                             |
| ------------------ | ---------------------------------------------------------------------------------- |
| Recent row         | new `runDirectory` on `RecentWorkflowsMessage` / `RecentWorkflow`                  |
| Running row        | same field, via the `lineage` already threaded onto `UnifiedWorkflowRow`           |
| Header (displayed) | new `runDirectory` on `RunViewLoadedMessage` **and** `WorkflowViewIdentityMessage` |

Rules that make this correct rather than merely populated:

- **Both address-setting messages carry it, and `uiStore` stores it beside
  `displayedViewAddress`, written by the same store actions.** `RUN_VIEW_LOADED`
  and `WORKFLOW_VIEW_IDENTITY` are the two messages that move the client's
  displayed address — the latter fires on cheap definition writes, including the
  first write to a brand-new workflow and a draft→run promotion, and routes
  through `uiStore.setDisplayedViewIdentity(address, definitionRevision,
descriptorRevision)`. Extend that action (and the `RUN_VIEW_LOADED` reducer)
  with the directory so address and directory can only ever be written together.
  If only the snapshot carried it, the header would go stale exactly when a draft
  becomes a run.
- **Running rows reuse the recent entry, not `WorkflowSummary`.**
  `UnifiedWorkflowRow`'s `running` variant already carries `lineage?: RecentWorkflow`
  and already reads `runNav` off it, so no change to `WorkflowSummary` — a core
  shared contract with many producers — is needed. Caveat worth knowing: this
  resolves the lineage's primary address, which for an executing lineage is the
  executing run. Disable the item when `lineage` is absent (a workflow started
  this session may not be in the recent list yet).
- `WorkflowSerializer.getRecentWorkflows` already resolves the primary address to
  a `filePath` via `WorkflowPaths.runFilePath`/`draftFilePath` in order to read
  the row, so the sibling directory (`WorkflowPaths.runDir`/`draftDir`) is a
  one-line addition beside it.

**Do not build a `RESOLVE_WORKFLOW_PATH` request/response.** A request/response
pair over the hosted socket needs the reissue-and-retire treatment
`useRunViewLoadWatchdog` exists for, because the shim drops outbound messages
while disconnected. Disproportionate for a copy button, and the eager fields have
no such failure mode — recent-list staleness is bounded by the
`GET_RECENT_WORKFLOWS` the dropdown posts on every open, and the displayed
directory is refreshed by the same messages that set the address.

`MCP_RUN_PATH_FIELDS_PLAN.md` adds the equivalent field to the MCP server's
responses; both should mean the same thing (the directory containing
`workflow.ctrlyoke.json`, `manifest.json`, and `events.jsonl`).

Copy through `writeClipboardText` (`utils/stepClipboard.ts`), which already falls
back to `execCommand` where the async clipboard API is unavailable; confirm with
`uiStore.showToast`.

### Related, separate: the MCP server emits a broken path today

Out of scope here, but found while writing this and worth its own fix.
`mcp-server.ts` already returns a working-file path in three places —
`handleQueueStatus` (`metadata.workingFile`), `handleQueueAppend`, and
`handleGlobalStatus` — all as `path.relative(this.workspaceRoot, filePath)`.
Since the user-scope move, `runFilePath` resolves outside the workspace, so that
field now emits `../../../Users/<user>/.ctrlyoke/projects/<slug>-<hash12>/.runs/…`.
An agent reading it as workspace-relative (the obvious reading, and what it was
before the move) looks in the wrong place, and `workspace` storage mode still
produces a short path from the same field. `assertContained` does not catch it —
it validates against `runsRoot`, not the workspace.

The fix is to emit an absolute path and add `runDirectory`, not to add a new MCP
tool or expand `ctrlyoke_global_status`. It reads as a gap in
`USER_SCOPED_RUN_HISTORY_PLAN.md`'s ledger row 7 (documentation/messaging audit).

---

## Shape of the implementation

### One hook, one target descriptor

Add `hooks/useWorkflowContextMenu.tsx`, following `useStepContextMenu.tsx` /
`useOutputContextMenu.tsx` exactly: local `StepContextMenuState | null`, an
`openContextMenu(x, y, target)` callback, and a returned
`workflowContextMenuPortal` node rendered by the caller. Reuse
`StepContextMenu` — do not add a second menu component.

The hook takes one resolved descriptor rather than a union of row types, so
neither the rows nor the header decide what the menu contains:

```typescript
interface WorkflowContextMenuTarget {
  address: WorkflowViewAddress;
  workflowName: string;
  isFavorite?: boolean;
  /** Absent → Copy renders disabled. */
  runDirectory?: string;
  /** Executing right now — disables Delete. */
  isExecuting: boolean;
}
```

Note what is absent: no execution state, no step counts, no revisions. With no
execution items, the menu needs none of it. If an execution item is ever added
back, this descriptor is where the argument restarts.

### Exactly one hook instance, owned by `WorkflowStatus`

**Do not call `useWorkflowContextMenu` inside a row component.** The rows render
inside `VirtualizedDropdownList`; a hook per row means one menu state, one
portal, and one document-level `pointerdown`/`keydown` listener pair per visible
row, all but one of them idle. It also makes "close the previous menu when
opening another" accidental rather than guaranteed.

`WorkflowStatus` already owns the dropdown, the delete-confirm modal, and the
`recentWorkflows` lookup, so it owns the menu too:

- `WorkflowStatus` calls the hook once and renders
  `workflowContextMenuPortal` beside its existing `<DeleteConfirmModal>`.
- It passes `onOpenContextMenu: (x, y, target) => void` down to `WorkflowList`,
  which threads it to `RecentWorkflowRow` and `RunningWorkflowItem` alongside the
  callbacks they already receive.
- Each row builds its own `WorkflowContextMenuTarget` — that is the only
  row-kind-specific logic, and it is three fields:
  - recent row: `isFavorite` from the entry, `runDirectory` from the entry,
    `isExecuting` via `isWorkflowActive(workflow.executionState)`;
  - running row: `isFavorite`/`runDirectory` from `row.lineage`, `isExecuting`
    true by construction.
- The header's split button calls the same `openContextMenu` with a target built
  from `displayedViewAddress`, `displayName`, the displayed `runDirectory` from
  `uiStore`, and the displayed lineage's `isFavorite` from `recentWorkflows`.

One menu, one portal, one listener pair, regardless of list length.

### Wiring the gesture

Attach `onContextMenu` (with `preventDefault`) plus `useLongPress` to:

- the outer row `div` in `RecentWorkflowRow` and `RunningWorkflowItem` — that
  container is already non-focusable, which is the arrangement
  `webview-react-components.instructions.md` requires; do not move the handler
  onto the primary `<button>`;
- the `workflow-split-button` container in `WorkflowStatus.tsx`.

`Header.tsx`'s run slot (`onContextMenu` + `useLongPress(openRunDryRunMenu)`) is
the working precedent for pairing both gestures on one control. `useLongPress`
already cancels on a 10px move, so long-press does not fight the dropdown's
scrollers.

### One interaction bug to fix while wiring this

`WorkflowStatus`'s outside-click handler closes the dropdown on any document
`mousedown` outside `containerRef` that is not inside `.fp-dropdown-popup`.
`StepContextMenu` portals to `document.body`, and its
`onPointerDown={stopPropagation}` does **not** stop the separate `mousedown`
event — so clicking a menu item would close the dropdown out from under the row
that opened it. Right-clicking the row itself is fine (the row is inside
`containerRef`); only the portaled menu is affected.

Fix by giving `StepContextMenu`'s root a stable marker class and adding it to
that `closest()` test. Delete should then call `closeDropdown()` itself;
Favorite and Copy should leave the list open.

### Delete

Reuse `WorkflowStatus`'s existing `handleRemoveWorkflow`, which already branches
on `globalSettings.confirmDeleteOperations` and drives the shared
`DeleteConfirmModal`. Rows must not grow a second confirmation path. Disable
Delete while the target lineage is executing.

---

## UX

- Order as in the table: clipboard, divider, favourite, delete.
- Disabled items stay visible with an explanatory `disabledTitle`; the menu's
  shape must not change row to row.
- The Favorite item's label reflects current state ("Add to Favorites" /
  "Remove from Favorites"), mirroring the rail button's `title`.
- Long-press is the mobile equivalent; the dropdown already sets `select-none`
  and `-webkit-touch-callout:none`, so no text-selection or iOS callout
  interference is expected.

---

## Implementation Phases

### Phase 1 — Menu and Copy Run Directory Path

Ordered so each step is independently verifiable; the path plumbing lands before
the UI that consumes it.

- [ ] Add `runDirectory` to `RecentWorkflowsMessage` / `RecentWorkflow`,
      populated from `WorkflowPaths.runDir`/`draftDir` beside the `filePath`
      `WorkflowSerializer.getRecentWorkflows` already resolves.
- [ ] Add `runDirectory` to `RunViewLoadedMessage` and
      `WorkflowViewIdentityMessage`; store it in `uiStore` beside
      `displayedViewAddress`, written by the same reducers that set the address.
- [ ] Add `useWorkflowContextMenu.tsx` over `StepContextMenu`; instantiate it
      once in `WorkflowStatus` and thread `onOpenContextMenu` through
      `WorkflowList` to both row kinds.
- [ ] Wire `onContextMenu` (with `preventDefault`) + `useLongPress` on both row
      containers and the `workflow-split-button` container.
- [ ] Give `StepContextMenu`'s root a marker class and add it to
      `WorkflowStatus`'s outside-click `closest()` test; make Delete close the
      dropdown, Favorite and Copy leave it open.
- [ ] Extension-side tests (`src/test/**`): `runDirectory` correct for a run
      primary address and for a draft-only lineage; present on both
      address-setting messages.
- [ ] React tests (`src/ui/webview-react/test/**`): item set and enablement per
      target kind; Copy uses the **displayed** run's directory when the header
      shows a non-latest run (the regression this plan's field placement
      exists to prevent); Copy disabled when `runDirectory` is absent; Favorite
      and Delete post the same messages as the rail buttons; Delete disabled
      while executing; exactly one menu portal exists with a long recent list;
      the dropdown survives a menu click.

### Phase 2 — Variants (deferred to `WORKFLOW_VARIANTS_PLAN.md`)

- [ ] **Duplicate Workflow…** and **Fork as New Workflow…** join this menu once
      that plan's shared clone service exists. This plan adds no cloning code.

---

## Acceptance Criteria

- Right-click and long-press open the same menu on recent rows, running rows,
  and the header split button.
- The menu always targets the row that was right-clicked, never the displayed
  workflow, except on the header where the displayed workflow _is_ the target.
- Copy Run Directory Path yields a directory that exists on the extension host
  for drafts, promoted runs, and running workflows alike.
- From the header it copies the directory of the run **currently displayed**,
  not the lineage's latest run, and stays correct across a draft→run promotion.
- The item is disabled, never silently wrong, when no directory is known.
- One context-menu portal and one document listener pair exist regardless of how
  many rows the dropdown holds.
- Favorite and Delete post exactly the messages the rail buttons post, and
  Delete honours `confirmDeleteOperations`.
- No menu item posts a run-lifecycle message at all.
- Interacting with the menu does not close the workflow dropdown unless the
  chosen action warrants it.

## Non-goals

- Any execution item: Run, Re-run, Restart, Continue, Resume, Pause, Stop.
- A keyboard-invoked context menu (Shift+F10 / Menu key) — worth doing, but it
  belongs with `ACCESSIBILITY_AND_TESTABILITY_PLAN.md`.
- Duplicate, Fork, or any cloning behaviour.
- Reveal-in-OS / open-in-editor variants of Copy.
- A path submenu (working file · run directory · `events.jsonl`).
- Multi-select or bulk actions across rows.
- Fixing the MCP server's relative-path regression — split out into
  `MCP_RUN_PATH_FIELDS_PLAN.md`. The two are independent and can land in either
  order; they only need to agree on what "run directory" means.
