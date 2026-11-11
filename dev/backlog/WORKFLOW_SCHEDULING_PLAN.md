# Workflow Scheduling Plan

> **Status:** Not yet implemented — design accepted in principle. The execution
> substrate is **decided** (see below): schedules fire only while a long-lived
> ctrlyoke host is running, and that is an accepted limitation, not a problem to
> engineer around. Nothing here is built yet.

> **2026-10-10 audit:** Still not started (no `schedule` anywhere in schemas or types). The
> design predated the run-storage rewrite, so the data model and firing semantics were corrected:
> per-workflow metadata now lives on the lineage descriptor `.runs/<workflowKey>/workflow.json`
> (`WorkflowLineageDescriptor`, written only by `WorkflowLineageRepository`; `isFavorite` lives
> there), not on a `.ctrlyoke/.queue/` working file; a re-run allocates a new `run-<timestamp>/`
> (`SEED_NEW_RUN`) rather than restarting a shared working file; `RecentWorkflows.tsx` is now
> `WorkflowList.tsx`; the standalone `ctrlyoke server` has shipped. Added the synced-state-home
> double-fire hazard and fixed the Phase 1 "missed-run catch-up" contradiction.

> Last reviewed against code: 2026-10-26. Still not started (no `schedule`/`WorkflowScheduler`
> in `src/`). Updated in place: the lineage enumeration now lives in
> `RecentWorkflowCatalog` (`src/core/orchestration/`, called by `handleGetRecentWorkflows`);
> the fire path is the orchestrator's `seedAndExecuteAtRun` / `executeDraftAtAddress`
> (the `SEED_NEW_RUN` / `EXECUTE_DRAFT` handlers in `src/ui/WorkflowStepHandlers.ts` are thin
> wrappers); bookkeeping writes go through `updateDescriptorMetadata`; and descriptor
> compatibility is spelled out against the persisted-schema rules.

> **2026-11-11:** The dropdown rows were restructured to two full-width lines
> (name + state badge, then metadata + run selector + actions), which settles where
> the schedule button goes: a third slot in the row's action rail on line 2. The
> plan also adds a context-menu entry. See "UX" below.

> **2026-11-11 (orchestrator staging):** Pinned the open implementation details so the
> work could be staged. See "Implementation decisions (pinned for staging)" and
> "Staging" at the end. In short: a hand-written 5-field cron evaluator in local time
> (no new dependency); timers capped below `setTimeout`'s 2³¹−1 ms limit; a
> `hostId` on the schedule settles the synced-home double-fire; the
> unattended-harness guard is an editor annotation in v1, not a runtime fail-fast.

## TL;DR

- **Substrate decided (per product owner):** a schedule fires **only while a
  ctrlyoke host with a live `WorkflowOrchestrator` is running** — i.e. VS Code
  is open (with or without the hosted server), or the standalone
  `ctrlyoke server`. **No OS scheduler, no background daemon, no "runs while the
  app is closed."** "You can schedule a workflow, but ctrlyoke has to be running"
  is an accepted, clearly-communicated constraint. This is a reasonable call —
  see "Why this is the right call." Power users who need runs while everything is
  closed use the existing escape hatch: **point cron / CI at `ctrlyoke run`.**
- **The scheduler is owned inside `WorkflowOrchestrator`** (one service, not
  per-host wiring). Bound to the orchestrator's lifetime, it works in the
  extension and in the standalone server (`NodeHostServices.createNodeHostedServer`
  constructs its own `WorkflowOrchestrator`) **for free** — and
  it correctly does **not** activate for the transient one-shot `ctrlyoke run`
  (which never constructs a `WorkflowOrchestrator`).
- **Storage:** the `schedule` block lives on the **lineage descriptor**
  (`<runsRoot>/<workflowKey>/workflow.json`, like `isFavorite`), so the scheduler loads
  it from the same `WorkflowLineageRepository.listLineageKeys` + `readDescriptor`
  enumeration the recent-workflows list already uses (`RecentWorkflowCatalog`) — no
  separate discovery pass.
- **Grammar:** 5-field cron for recurrence + a one-shot `at`. RRULE and the
  "Wait until time/date" step idea are both **scrapped**.
- **Timezone:** interpret times in the **host machine's local timezone**; no
  timezone field in v1 (an explicit field can follow post-release).
- **A fire = the Run / re-run action:** the scheduler starts a **new run** of the
  lineage through the same backend path the header's controls use —
  `EXECUTE_DRAFT` for a lineage that only has a draft, otherwise `SEED_NEW_RUN`
  (re-run), which allocates a fresh `run-<timestamp>/` from the latest run's
  definition and starts from step 0.
- **Execution policy:** scheduled runs use the existing global controls:
  `queue.maxSteps`, `queue.maxWorkflowExecutionTimeSec`,
  `execution.maxPromptTimeoutSec`, and `execution.scriptTimeoutSec`, including
  their existing `-1` semantics where allowed. Scheduling adds no per-schedule
  or workflow-authored limits hierarchy.
- **UX:** schedule is a per-workflow property, authored from a compact popover
  opened by a **clock button in the row's action rail** (line 2:
  `[run selector][schedule][star][trash]`) or a **"Schedule…" context-menu
  entry** (the brief's option A). It is surfaced back as a **"Scheduled" section**
  in the same dropdown for management, _not_ a whole separate page, at least not
  first.

---

## Execution substrate (decided)

A schedule needs a live process to fire it. ctrlyoke's runtime hosts:

| Host                                                                           | Alive when…                            | Owns a `WorkflowOrchestrator`?                                          | Fires schedules?                                                           |
| ------------------------------------------------------------------------------ | -------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Extension host**                                                             | VS Code open with the extension active | Yes                                                                     | **Yes**                                                                    |
| **Hosted server** (`CtrlYokeHostedServer`)                                     | The extension boots it                 | No — it's a front-end transport handed the **extension's** orchestrator | Yes, but only because the extension host is already running (same process) |
| **Standalone `ctrlyoke server`** (`dev/implemented/STANDALONE_SERVER_PLAN.md`) | The user runs `ctrlyoke server`        | Yes — `createNodeHostedServer` composes its own                         | **Yes**                                                                    |
| **CLI** (`ctrlyoke run`)                                                       | One invocation only                    | No — uses `WorkflowInstance`/`IntegrationFactory` directly              | **No** (by design — one-shot, not a scheduling host)                       |

The decisive simplification: **the hosted server is not a separate substrate** —
it rides on the extension's orchestrator, so "VS Code open" and "hosted server
running" are the _same_ host. That collapses the whole question to a single rule:

> **The scheduler lives wherever a `WorkflowOrchestrator` lives.** Own it inside
> (or alongside) the orchestrator, and both long-lived hosts inherit it with
> zero per-host code — matching the project's DRY / single-source principle.
> `ctrlyoke run` is excluded automatically because it never builds an
> orchestrator.

### Why this is the right call

The product owner already keeps VS Code open all day to host the server, and any
user running ctrlyoke for remote/agentic coding does the same. For that audience,
"fires while ctrlyoke is running" covers the real use cases (kick off in N hours,
run nightly while the machine and editor stay on) without dragging in:

- three OS-specific scheduler backends (Task Scheduler / cron / launchd),
- a non-interactive-harness-auth audit for unattended runs at 3am,
- a `ctrlyoke daemon` that reinvents cron plus its own autostart/keep-alive story.

All of that is **explicitly out of scope and rejected** — recorded here so a
future reader knows it was considered, not overlooked. The one obligation this
choice creates is on the **UX**: the limitation must be legible (the schedule
editor should say, in plain words, that runs only happen while ctrlyoke/VS Code
or the server is running), and missed runs should be surfaced rather than
silently dropped (see "Missed runs").

> Because the scheduler is orchestrator-bound, the (already shipped) standalone
> server gets scheduling with no scheduling-specific work — it already
> reuses `WorkflowOrchestrator` unchanged. There is no "Phase 2 firing backend"
> to build; there is one firing backend, and it is portable.

---

## Rejected: a "Wait until time/date" step

The brief floated a `function` step type whose first step waits until a time.
**Scrapped as a scheduling mechanism** — scheduling is metadata _about_ a workflow,
not a step _of_ it. An in-queue wait needs a live process burning the whole window,
can't express recurrence, doesn't survive a restart, and crowds step
semantics/history/`priorContext` indices. (A general in-workflow "wait/delay"
between steps could still be its own future backlog item, but most of that space —
notify, wait-for-condition — is already reachable via `script` steps.)

---

## UX: author on the row, manage in a section

A schedule is a property _of a workflow_, and the workflow-status dropdown is
already the per-workflow action surface (favorite ★, delete 🗑 in
`WorkflowList.tsx`). So:

### Authoring (the brief's option A — recommended)

Every dropdown row is two full-width lines (`WorkflowRowLayout` +
`WorkflowRowTrailing`, `.workflow-row` in `globals.css`):

```
[harness] [workflow name ......................] [state badge]
[harness] [steps · tokens · time · worktree/terminal] [run selector][schedule][star][trash]
```

The run selector and the action rail (`RowActionRail`) sit at the end of the
**second** line, so they never take width from the name. The schedule button goes
in that rail, **between the run selector and the star**:

- **Recent rows** (`RecentWorkflowRow` in `WorkflowList.tsx`):
  `[schedule][star][trash]`.
- **Running rows** (`RunningWorkflowItem.tsx`): `[schedule][pause|continue][stop]`.
  The schedule slot is the first rail slot on both row kinds, so the clock lines
  up across the pinned running region and the recent list beneath it. A
  running lineage can still have its schedule viewed and edited; only the fire is
  skipped (see "Overlapping runs").
- **Run-panel rows** (`RunSummaryRow.tsx`) get **no** schedule button. Those rows
  are runs, and a schedule belongs to the lineage. The context-menu entry below
  still reaches it from there, the same way favourites do.

Button behaviour:

- A **clock** codicon (`codicon-clock`, which exists in the bundled
  `@vscode/codicons`). It is **lit and always visible** when the lineage has an
  enabled schedule, and hover-revealed otherwise. This is the favourite star's
  lit/empty pattern, and it uses the shared `ROW_ACTION_BUTTON_CLASS` box. A
  paused (`enabled: false`) schedule shows a dimmed clock, still always visible,
  so a kept-but-paused schedule doesn't vanish.
- `title` / `aria-label`: "Next run: <local time>" when scheduled,
  "Schedule workflow…" otherwise.
- **Width:** the rail is a fixed-width track (`WORKFLOW_ROW_TRACKS.actions`,
  currently two 20px buttons + gap = 44). It grows to three buttons
  (3 × 20 + 2 × 4 = **68**), and `WORKFLOW_ROW_TRAILING_WIDTH` follows. The rail
  lives on the metadata line, so this costs the metadata truncation point, not the
  name. `WORKFLOW_DROPDOWN_COMPACT_WIDTH` only budgets the first line and doesn't
  move. Update the second-line budget test in `workflowRowWidths.test.ts`.
  Running rows reserve the same slot even when unscheduled. A rail that is
  content-sized per row kind would offset the run selector between the two
  regions.
- Touch: hover-revealed buttons are invisible on touch, so the context-menu
  entry (reached by long-press, `useLongPress`) is the touch path to an
  unscheduled lineage. That is the same arrangement favourites have today.
- Clicking opens a compact **schedule editor** — a small popover/drawer anchored
  to the row (not a full accordion that reflows the whole list) containing:
  - **Frequency**: Once · Daily · Weekly (weekday multiselect) · Monthly · Custom
    (cron string, advanced).
  - **Start date/time** (and, for recurrence, an optional end/until).
  - **Enabled** toggle (keep the schedule but pause firing).
  - A read-only **"Next run: …"** line computed live.
  - Save / Remove.

Prefer a **popover over the row's own accordion**: the dropdown is already dense
and width-locked (`syncWorkflowRowWidthLock` in `WorkflowSwitcher.tsx`), and an
inline accordion that pushes siblings down fights that layout. A popover keyed to
the row avoids reflow.

### Context-menu entry

Add a lineage-scoped item to `useWorkflowContextMenu.tsx`, in the group with
**Add to / Remove from Favorites**, directly above it:

- Label **"Schedule…"** when the lineage has no schedule, and **"Edit Schedule…"**
  when it has one. Icon `codicon-clock`. `title` gives the next run time when one
  exists.
- It appears on **every** surface the menu opens from: list rows, running rows,
  the header, and run-panel rows. A schedule is lineage-scoped like `isFavorite`,
  which the menu already offers on run-panel rows for the same reason.
- It is never disabled. A running or unstarted lineage can be scheduled, and a
  draft-only lineage fires through `executeDraftAtAddress`.
- `onClick` closes the dropdown menu and opens the same `ScheduleEditor` popover
  the row button opens, anchored to the menu's `opener` element. Fall back to the
  row when the menu opened at pointer coordinates.
- Plumbing: add `schedule?` (or a `hasSchedule`/`nextRunAt` pair) to
  `WorkflowContextMenuTarget`, filled from the `RecentWorkflow` entry by the same
  three builders that fill `isFavorite` today: `RecentWorkflowRow`,
  `RunningWorkflowItem`'s `lineage`, and `RunSummaryRow` (via `RunPanel`). Also
  add an `onEditSchedule(target, opener)` option beside `onToggleFavorite` /
  `onDuplicate`.

### Management (lightweight, in the same dropdown)

Add a **"Scheduled" section** to the dropdown, structured exactly like the
existing **"Running workflows"** section (`WorkflowList.tsx`, fed by
`runningSectionWorkflows` in `WorkflowSwitcher.tsx`): a header + a list of scheduled
workflows with their next-run time and an enable/disable toggle. This reuses the
section/filter machinery already present and gives an at-a-glance "what's
scheduled" without a new page. A `schedule`-state filter can slot into the
existing `MultiCheckboxDropdown` filter row in `WorkflowSwitcher.tsx`.

### Dedicated page — later, only if needed

A standalone scheduling page (the brief's option B) buys a calendar/agenda view,
schedule-run history, and bulk edit. That's real value **once users run many
schedules**, but it's a lot of surface to build and maintain for v1. Defer it;
the "Scheduled" section covers the 1–5-schedule common case. Revisit if usage
shows heavy scheduling.

**Net UX recommendation:** option A for authoring + a "Scheduled" dropdown
section for management. Not option B first. Not option C at all (for scheduling).

---

## Data model

### Where the schedule lives — the lineage descriptor (like favorites)

Store `schedule` on the **lineage descriptor**
(`<runsRoot>/<workflowKey>/workflow.json`, type `WorkflowLineageDescriptor` in
`CtrlYokeTypes.ts`), exactly like `isFavorite` already is — see
`WorkflowLibraryHandlers.handleToggleFavorite`, which goes through
`WorkflowLineageRepository.updateDescriptor`, the descriptor's only writer. It
must not go on a run's `workflow.ctrlyoke.json`: that file is one run's
immutable-ish working copy, and a schedule spans runs. This is the right home
because:

- Every lineage has a descriptor from creation, including draft-only lineages
  (`draft/workflow.ctrlyoke.json`), so anything in the recent-workflows list can
  carry a schedule.
- **The scheduler bootstraps off work the host already does.**
  `RecentWorkflowCatalog.list` (behind `WorkflowLibraryHandlers.handleGetRecentWorkflows`)
  enumerates `lineageRepository.listLineageKeys()` and reads each descriptor. The
  scheduler uses the same repository pass once at startup: **any descriptor whose
  `schedule` is present and `enabled` gets armed.** No separate discovery glob. That
  full pass takes seconds on a project with thousands of lineages, so after startup
  the scheduler re-reads only the lineage whose schedule was just set or cleared,
  never the whole list per tick.
- The descriptor carries `schemaVersion` (`PERSISTED_STORES.LINEAGE_DESCRIPTOR`, read
  through `migrateToCurrent` in `PersistedSchemaGuard`), so an optional `schedule`
  field is additive: no version bump. `updateDescriptor`/`updateDescriptorMetadata`
  spread the existing descriptor, so a `0.2.x` host that rewrites the descriptor keeps
  the field (it just never fires it).

`nextRunAt`/`lastRunAt` live on the same descriptor so the dashboard can show
them without recomputation. The scheduler writes them with
`updateDescriptorMetadata`, which leaves `revision` alone; `updateDescriptor` bumps it,
and that would invalidate every open client's `expectedDescriptorRevision` on each fire.

> **Synced state home — double-fire hazard.** In the default user mode the runs
> root lives under the ctrlyoke state home, which may sit in OneDrive/Dropbox.
> A synced descriptor means two machines with the same project open would _both_
> arm and fire the schedule. Running one project on two synced machines at once is
> already unsupported (see `copilot-instructions.md`), but a schedule makes
> it happen without the user doing anything. v1 should record the arming machine
> (e.g. a host id on the schedule) and fire only there, or at minimum document the
> hazard in the editor.

> **Survive-VS-Code-close is out of scope by design** (the built-in scheduler
> only fires while a ctrlyoke host is running — see "Execution substrate").
> Power users who need runs while everything is closed should point **cron / a CI
> job / any real scheduler at `ctrlyoke run <file>`** — that path already works
> and is the sanctioned answer, not a gap. The built-in scheduler is for
> developers who keep VS Code open or a `ctrlyoke server` running and accept that
> its features are only available while it is.

### Shape (sketch — validate against schema conventions before building)

**Grammar decided: 5-field cron for recurrence + a one-shot `at`** (RRULE
rejected — cron is terser and familiar, and "last weekday of month" edge cases
aren't worth the RRULE dependency for a coding tool).

```jsonc
"schedule": {
  "enabled": true,
  "trigger": {
    // exactly one of:
    "at": "2026-07-15T17:00:00",     // one-shot local datetime, OR
    "cron": "0 9 * * 1-5"            // recurring (5-field)
  },
  "until": "2026-12-31T00:00:00"     // optional end for recurrence
}
```

The `cron` string is the advanced/"Custom" escape hatch; the friendly
Daily/Weekly/Monthly pickers in the editor generate it, so most users never type
cron directly.

**No `onMissed` / `onOverlap` fields in v1 (decided).** Both are fixed behaviors,
not user options (see "Missed runs" and "Overlapping runs" below): a missed
occurrence is **always skipped**, and an overlapping fire is **always skipped**.
They can become configurable later if a real need appears; for now the schema
stays minimal.

**No `timezone` field in v1 (decided).** Times are interpreted in the **host
machine's local timezone** — the machine ctrlyoke is running on. An explicit
per-schedule timezone can be added post-release if users ask; it slots in as an
optional field with the machine zone as the default, so no migration.

### Semantics to pin down (these are the sharp edges)

- **Timezone / DST.** Compute next-run in the **host machine's local timezone**
  (v1 has no timezone field — see data model). Use local-time date math, not a
  fixed UTC offset, so a "9am" schedule stays 9am across a DST change rather than
  drifting an hour.
- **How a fire actually runs.** Firing is exactly the dashboard **Run / re-run**
  action, just triggered by the timer instead of a click: the scheduler calls the
  backend handler behind `Header.tsx`'s `handleSlotAction` — `SEED_NEW_RUN`
  ("rerun") for a lineage with a prior run, `EXECUTE_DRAFT` for a draft-only
  lineage. Each fire therefore allocates a **new `run-<timestamp>/`** under the
  same lineage (new `RunRef`, `nextRunId` incremented), so run identity and history
  grouping match a manual re-run. Call the orchestrator methods those handlers wrap
  (`WorkflowOrchestrator.seedAndExecuteAtRun` / `executeDraftAtAddress`, reached today
  through `WorkflowStepHandlers.handleSeedNewRun` / `handleExecuteDraft`) rather than
  posting a webview message. Read the current definition and descriptor revisions
  just before firing and pass them as the expected revisions. `clientId` defaults to
  the panel's; decide whether a scheduled fire should get its own ID so the
  revision-reconciliation ledger doesn't attribute it to the panel.
  The UI-side `canStartRun` gate in `handleSeedNewRun` doesn't apply, so the scheduler
  needs its own start check (the overlap rule below).
- **Missed runs — always skip (v1).** A "missed" run is one whose scheduled time
  passed while no ctrlyoke host was running (VS Code closed, machine asleep). v1
  **does not run these** — no catch-up, ever. Opening VS Code after several days
  must **not** kick off every schedule whose time elapsed; the scheduler simply
  re-arms each schedule for its _next future_ occurrence. (This is intentionally
  the opposite of a cron-style catch-up; a catch-up policy could be added later,
  off by default.) A schedule with a one-shot `at` in the past is just inert.
  Optionally surface a quiet "last occurrence missed while offline" hint on the
  row so the skip is visible rather than mysterious — but never auto-run.
- **Overlapping runs — always skip (v1).** "Overlap" is when the scheduled time
  arrives but _this same workflow is still running_ — e.g. a daily 9am run that
  occasionally takes >24h, or the user manually started it and it's mid-run at
  9am. v1 **skips the new fire** rather than launching a second concurrent copy
  (AI runs are expensive and stateful, so double-running is the wrong default).
  Alternatives — queue-after or stop-and-restart — are deferred, not in v1.
- **Next-run reconciliation.** The scheduler is the single writer of
  `lastRunAt`/`nextRunAt`; the UI reads them. One source, so the timer and the
  dashboard never disagree.

---

## Harness auth constraint (still applies — the run is unattended)

A scheduled run starts with **no user present**, even though ctrlyoke itself is
running. So the start path must not block on an interactive prompt. A harness that
needs an interactive login/approval at start (device-code auth, first-run trust
prompt, per-run permission confirmation) will **hang the scheduled run**.

- The scheduler should start workflows through the same in-process orchestrator
  path the dashboard uses, honoring the workflow's own harness + permission mode
  (there is already a `PERMISSION_MODES` concept). A run that would prompt should
  fail fast / mark the run as blocked, not hang indefinitely.
- In the schedule editor, **annotate** harnesses/permission modes that can't run
  unattended so a user doesn't schedule something that will silently stall.

This is a smaller problem than under an OS-scheduler design (the host is already
authenticated and warm — this is just the dashboard's own start path fired by a
timer instead of a click), but it still needs a "won't prompt" guarantee.

---

## Phasing

**Phase 0 — Model + validation (no firing).**
`schedule` field on `WorkflowLineageDescriptor` (`CtrlYokeTypes`), validated
read/write round-trip in `WorkflowLineageRepository`, a tz-aware next-run
computation util, unit tests. Nothing
fires yet; you can author, validate, and persist a schedule.

**Phase 1 — Orchestrator-bound scheduler + UI.**
A `WorkflowScheduler` owned by / constructed alongside `WorkflowOrchestrator`:
loads schedules from the lineage descriptors the host **already enumerates**
(`WorkflowLineageRepository.listLineageKeys` + `readDescriptor`, the same pass
`RecentWorkflowCatalog` uses), arms a timer for each `enabled` one, fires via
the existing orchestrator new-run path (`seedAndExecuteAtRun` / `executeDraftAtAddress`), and on startup re-arms each schedule for
its next _future_ occurrence (missed runs are skipped, never caught up). Plus the UI: row schedule icon + editor popover, the
"Scheduled" dropdown section, message types + serializer handlers to get/set
schedules, and Zustand wiring. This is the whole feature for the extension host —
**and the standalone `ctrlyoke server` inherits it unchanged** because it
constructs the same orchestrator.

**Phase 2 (optional) — Dedicated scheduling page** with agenda/calendar view and
scheduled-run history, _if_ usage shows users juggling many schedules.

> Deliberately **not** phased by substrate. There is one firing mechanism (the
> orchestrator-bound timer) and it is portable across hosts by construction; there
> is no separate OS/daemon backend to build later.

---

## Cross-layer touch points (keep synchronized)

Per the project's "keep shared contracts synchronized" rule, a schedule change
ripples across:

- `src/types/CtrlYokeTypes.ts` — `Schedule` type, as an optional field on
  `WorkflowLineageDescriptor` (alongside `isFavorite`);
  `src/types/DashboardConstants.ts` — any new state/constant. The descriptor is
  not a workflow file, so `schemas/workflow-schema.json` is **not** touched;
  validate the block in `WorkflowLineageRepository`'s descriptor read path instead
  (ill-formed → ignore the schedule, keep the lineage).
- `src/core/orchestration/WorkflowLineageRepository.ts` — read/validate and
  write `schedule` via `updateDescriptor` and `nextRunAt`/`lastRunAt` via
  `updateDescriptorMetadata`; a tz-aware
  **next-run util** (new, in `src/utils/`).
- `src/core/WorkflowOrchestrator.ts` — **owns** the `WorkflowScheduler`
  (new, `src/core/` or `src/core/orchestration/`) so both the extension and the
  standalone server inherit it; wire startup schedule-load + next-occurrence
  re-arming into the orchestrator's init/dispose lifecycle, and have the scheduler
  fire through the **same new-run entrypoint the dashboard's Run/re-run controls
  hit** (`seedAndExecuteAtRun` / `executeDraftAtAddress`, behind the `SEED_NEW_RUN` /
  `EXECUTE_DRAFT` handlers). **Do not** wire
  the scheduler in `extension.ts` or the hosted/standalone servers individually —
  that would defeat the single-source point.
- `src/ui/WorkflowLibraryHandlers.ts` — get/set-schedule handlers (mirror the
  favorite/`handleToggleFavorite` pattern); include `schedule`/`nextRunAt` in the
  rows `RecentWorkflowCatalog` builds (`RecentWorkflowEntry`).
- `src/types/WebviewMessageTypes.ts` + `DashboardConstants` `MESSAGE_TYPES` —
  `GET_SCHEDULE` / `SET_SCHEDULE` / `CLEAR_SCHEDULE` message pair (works over
  both the VS Code webview and the hosted-server WebSocket transport unchanged).
- `src/ui/webview-react/store/uiStore.ts` — extend `RecentWorkflow`
  (`schedule?`, `nextRunAt?`) and store actions.
- `src/ui/webview-react/components/workflow/`: `WorkflowList.tsx` and
  `RunningWorkflowItem.tsx` get the clock button as the first `RowActionRail`
  slot. Add a new `ScheduleEditor` popover, and the "Scheduled" section in
  `WorkflowSwitcher.tsx`. The editor carries a plain-language note that runs only
  fire while ctrlyoke/VS Code (or the server) is running.
- `src/ui/webview-react/constants.ts`: widen `WORKFLOW_ROW_TRACKS.actions` from
  two buttons to three (44 → 68). Update `workflowRowWidths.test.ts` to match.
- `src/ui/webview-react/hooks/useWorkflowContextMenu.tsx`: the "Schedule… /
  Edit Schedule…" item, plus the `WorkflowContextMenuTarget` field and the
  `onEditSchedule` option (see "Context-menu entry").
- Tests: scheduler + next-run util in `src/test/**`; UI in
  `src/ui/webview-react/test/**`.

---

## Decisions & remaining defaults

All major questions are **decided** — the plan is ready to implement:

- Substrate: orchestrator-bound; fires only while a ctrlyoke host runs.
- Scheduler owned **inside `WorkflowOrchestrator`** (max reuse; standalone server
  inherits it for free).
- Wait-step idea: **scrapped.**
- Storage: on the **lineage descriptor** (`workflow.json`), loaded via the same
  repository pass as the recent-workflows list.
- Grammar: **cron-5 + one-shot `at`** (RRULE rejected).
- Timezone: **machine local time**, no timezone field in v1 (explicit field is a
  possible post-release add).
- Firing: equivalent to the dashboard **Run / re-run** — a new run of the
  lineage (`SEED_NEW_RUN` / `EXECUTE_DRAFT` path), starting from step 0.
- Missed runs (host was offline at the scheduled time): **always skipped** in v1,
  no catch-up — opening VS Code after days off never triggers a backlog. Not a
  user option.
- Overlapping runs (same workflow still running when the next fire is due):
  **always skipped** in v1 — never a second concurrent copy. Not a user option.
- Survive-close: out of scope; power users point **cron / CI at `ctrlyoke run`**.

No remaining blockers — the plan is fully specified for a v1 implementation.

---

## Implementation decisions (pinned for staging)

- **Shape (final for v1).** Add a `WorkflowSchedule` type to `CtrlYokeTypes.ts`:
  `{ enabled: boolean; trigger: { at: string } | { cron: string }; until?: string; hostId: string }`
  where `at`/`until` are local `YYYY-MM-DDTHH:mm[:ss]` strings with no offset. Add three
  optional fields to `WorkflowLineageDescriptor`: `schedule?`, `scheduleNextRunAt?` and
  `scheduleLastRunAt?` (epoch ms), plus `scheduleLastMissedAt?` for the "missed while
  offline" hint. Prefix them `schedule` so they don't collide with run-level names. No
  descriptor `schemaVersion` bump: the fields are optional and additive.
- **Validation.** A new pure validator (`src/utils/WorkflowSchedule.ts`) is used on the
  descriptor read path. An ill-formed `schedule` (bad cron, bad datetime, both or
  neither of `at`/`cron`) is dropped with a `Log.warn`, and the lineage stays. The same
  validator guards the set-schedule handler, which rejects bad input with an error.
- **Next-run computation: hand-written, no dependency.** No cron package is installed,
  and a 5-field evaluator is small. Put it in `src/utils/CronSchedule.ts`. Support
  `*`, lists, ranges, steps (`*/n`, `a-b/n`), month and weekday numbers (0 and 7 are
  both Sunday), and the standard Vixie rule: when both day-of-month and day-of-week are
  restricted, a date matches either. Names (`MON`, `JAN`) and macros (`@daily`) are not
  supported. Do all date math with local-time `Date` setters, never fixed offsets.
  DST: a wall-clock time that doesn't exist in spring fires at the first valid minute
  after it, and a time that occurs twice in autumn fires once (the first occurrence).
  `nextOccurrence(schedule, afterMs)` returns `null` once past `until`, or for a
  one-shot `at` in the past. Search for at most about 5 years, then return `null`.
- **Timer cap.** `setTimeout` overflows above 2³¹−1 ms (~24.8 days) and fires
  immediately. Arm each timer for `min(delay, 24h)` and recompute when it fires;
  don't fire unless the occurrence time has really arrived. This also corrects drift
  after sleep or a wall-clock change.
- **Double-fire across synced machines.** `hostId` is `os.hostname()`, captured when the
  schedule is saved. The scheduler arms only schedules whose `hostId` matches the
  current host. The editor shows "Scheduled on <host>" when it doesn't, and saving from
  this machine claims the schedule. Put the host lookup behind one helper so tests can
  inject it.
- **Scheduled-fire client ID.** Fires use their own `clientId` constant (e.g.
  `SCHEDULER_CLIENT_ID` in `DashboardConstants.ts`), not the panel's, so the
  revision-reconciliation ledger doesn't credit the panel with them.
- **Overlap check.** Before firing, skip when the lineage has a live runner (an active
  in-process instance for that `workflowKey`, or a non-reclaimable `runner.json`). Log
  the skip and advance `scheduleNextRunAt`.
- **Unattended harnesses (v1 scope).** The guard is an annotation only. The editor says
  runs are unattended and only fire while ctrlyoke is running, and it warns when the
  lineage's steps run in `interactive` mode or without a bypass/auto permission mode.
  A runtime "would prompt → fail fast" detection is **deferred** (no reliable signal
  exists today); record it as a follow-up, not v1 scope.
- **Scheduler refresh API.** `WorkflowScheduler.refresh(workflowKey)` re-reads one
  descriptor and re-arms it. Set/clear-schedule handlers call it after writing.
  `dispose()` clears every timer. The scheduler starts at the end of
  `WorkflowOrchestrator.initialize()`, and the orchestrator's dispose path tears it down.

## Staging

1. Phase 0: types, validator, cron/next-run util, descriptor read-path validation, unit tests.
2. `WorkflowScheduler`: owned by `WorkflowOrchestrator`, startup arming, missed/overlap
   skip, fire through `seedAndExecuteAtRun`/`executeDraftAtAddress`, bookkeeping via
   `updateDescriptorMetadata`, and tests with fake timers.
3. Backend and contract plumbing: `SET_SCHEDULE`/`CLEAR_SCHEDULE` messages and
   handlers, `RecentWorkflowEntry` fields, the `uiStore` `RecentWorkflow` fields and
   actions, and tests.
4. UI authoring: the `ScheduleEditor` popover, the row clock button (rail 44 → 68), the
   context-menu entry, and tests.
5. UI management: the "Scheduled" section and filter, public docs, `CHANGELOG.md`.
