# Workflow Scheduling Plan

> **Status:** Not yet implemented — design exploration. This doc resolves the UX
> question raised in the brief, but its main job is to surface the decision that
> actually gates the feature: **what process is alive to fire a schedule?**
> Nothing here is built yet.

## TL;DR

- The interesting decision is **not** the UX — it's the **execution substrate**.
  A schedule is worthless if nothing is running when the fire time arrives, and
  ctrlyoke has **no always-on process today** (see "The real problem" below).
- The **"Wait until time/date" step** idea is a fine _general_ step primitive but
  the **wrong mechanism for scheduling** — it needs a live process for the whole
  wait, doesn't survive restarts, crowds the workflow, and can't express
  recurrence. Keep it out of scope for scheduling; consider it separately.
- Recommended shape: **schedule is a per-workflow property**, authored from a
  compact drawer on the workflow row (the brief's option A), surfaced back as a
  **"Scheduled" section** in the same dropdown (management), _not_ a whole
  separate page — at least not first. A dedicated page only earns its keep once
  users routinely juggle many schedules.
- Ship in phases by substrate: **Phase 1 = extension-host timer** (fires while
  the dashboard/VS Code is open — honest, cheap, immediately useful for
  "kick this off in 5 hours while I'm at lunch"). **Phase 2 = OS-scheduler
  delegation** via `ctrlyoke run` (the only option that fires with the app
  closed — real "set and forget").

---

## The real problem: what fires the trigger?

Everything else is downstream of this. A scheduling UI that can't reliably run a
workflow at 5pm tomorrow is a toy. Today ctrlyoke has three runtime hosts and
**none is a guaranteed always-on daemon**:

| Host | Alive when… | Executes workflows? |
| --- | --- | --- |
| **Extension host** (`WorkflowOrchestrator`) | VS Code is open with the extension active | Yes — this is the primary executor |
| **Hosted server** (`CtrlYokeHostedServer`) | The extension boots it (it's handed the extension's `WorkflowOrchestrator`) | No independent engine — it's a **front-end transport over the extension host**, so it dies with VS Code too |
| **CLI** (`ctrlyoke run`) | Only for the duration of one invocation | Yes — independent one-shot executor |

Consequence: the hosted server does **not** give us an always-on scheduler for
free (it rides on the extension host). The only thing that can fire a workflow
while VS Code is closed is **something the OS keeps alive**. That leaves a small
set of real options:

### Substrate options

1. **Extension-host timer (in-process scan).** On activation, load schedules and
   arm `setTimeout`/an interval scan; fire by starting the workflow through the
   existing orchestrator path. **Fires only while VS Code is open.**
   - Pros: no new process, no packaging, reuses the entire execution path,
     trivial to build, great for near-term "start in N hours / at a time today"
     while the machine stays on.
   - Cons: closed editor = missed run. Needs explicit **missed-run/catch-up**
     semantics on next activation (see below).
2. **OS-scheduler delegation.** ctrlyoke becomes a schedule _author_: it writes a
   Windows **Task Scheduler** task / **cron** entry / **launchd** plist that runs
   `ctrlyoke run <file> --harness … [flags]` at the scheduled time. The OS owns
   the clock.
   - Pros: the **only** option that fires with the app closed; survives reboots;
     zero ctrlyoke process required at fire time.
   - Cons: cross-platform generators (three backends); CLI must be installed and
     resolvable; **harness auth must be non-interactive** (see constraints);
     workspace/cwd + working-file resolution must be baked into the command;
     partially outside ctrlyoke's observability (a run started by cron won't show
     live in a closed dashboard — it reconciles from history/queue on next open).
3. **`ctrlyoke daemon` (new long-running process).** A lightweight Node process
   that owns the schedule store and fires `run`, installed as an autostart entry.
   - Pros: cross-platform single codebase; full ctrlyoke observability.
   - Cons: we'd be **reinventing cron**; install/keep-alive/update story; the
     autostart entry is itself an OS-integration problem, so we pay option 2's
     cost _plus_ a daemon. **Not recommended** unless a strong always-on
     multi-workflow story emerges later.

**Recommendation:** Phase 1 = option 1 (extension-host timer). Phase 2 = option 2
(OS delegation) for true set-and-forget. Skip option 3.

> Design the schedule **data model once** (Phase 1) so Phase 2 is "add a firing
> backend," not "re-model schedules." The store and next-run math are
> substrate-independent.

---

## Why not the "Wait until time/date" step

The brief floats extending `STEP_TYPES` (`prompt` / `script` → add `function`,
with a "Wait until 5pm" function as step 1). As a scheduling mechanism this is
the weakest option, and the brief already senses it:

- **Requires a live process for the entire wait.** A "wait 5 hours" step means
  the orchestrator (or a PTY) must stay alive burning that whole window —
  strictly worse than a timer that arms and sleeps, and it evaporates on restart.
- **No recurrence.** "Every weekday at 9am" can't be a single leading step.
- **Crowds the workflow.** Scheduling is metadata _about_ a workflow, not a step
  _of_ it. Baking it into the queue muddies step semantics, history, retries, and
  `priorContext` indices.
- **Restart-fragility.** A scheduled run must survive an editor restart; an
  in-queue wait does not.

A `function` step type (or a general **"wait/delay"** step) may still be worth
building for _in-workflow_ pacing (e.g. "wait 30s for a deploy to settle between
steps") — but track that in its own backlog item, not as the scheduler. Most of
that space (notify, email, wait-for-condition) is already reachable via `script`
steps, which is the DRY answer for arbitrary side effects.

---

## UX: author on the row, manage in a section

A schedule is a property _of a workflow_, and the workflow-status dropdown is
already the per-workflow action surface (favorite ★, delete 🗑 in
`RecentWorkflows.tsx`). So:

### Authoring (the brief's option A — recommended)

Add a **schedule affordance** to each workflow row (both `RunningWorkflowItem`
and the `RecentWorkflows` rows), beside the favorite/delete buttons:

- A **clock/schedule icon** button. **Lit/filled** when the workflow has an
  active schedule (mirrors the favorite-star lit/empty pattern already in
  `RecentWorkflows.tsx`), with the **next run time** as its `title`.
- Clicking opens a compact **schedule editor** — a small popover/drawer anchored
  to the row (not a full accordion that reflows the whole list) containing:
  - **Frequency**: Once · Daily · Weekly (weekday multiselect) · Monthly · Custom
    (cron string, advanced).
  - **Start date/time** (and, for recurrence, an optional end/until).
  - **Enabled** toggle (keep the schedule but pause firing).
  - A read-only **"Next run: …"** line computed live.
  - Save / Remove.

Prefer a **popover over the row's own accordion**: the dropdown is already dense
and width-locked (`syncWorkflowRowWidthLock` in `WorkflowStatus.tsx`), and an
inline accordion that pushes siblings down fights that layout. A popover keyed to
the row avoids reflow.

### Management (lightweight, in the same dropdown)

Add a **"Scheduled" section** to the dropdown, structured exactly like the
existing **"Running Workflows"** section (`showRunningWorkflowsSection` in
`WorkflowStatus.tsx`): a header + a list of scheduled workflows with their
next-run time and an enable/disable toggle. This reuses the section/filter
machinery already present and gives an at-a-glance "what's scheduled" without a
new page. A `schedule`-state filter can slot into the existing
`MultiCheckboxDropdown` filter row.

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

### Where the schedule lives

Favorites (`isFavorite`) currently live on the **working file**
(`.ctrlyoke/.queue/<name>.ctrlyoke.json`, see `WorkflowSerializer.handleToggleFavorite`).
A schedule is different in kind: it must be **resolvable without the working file
existing** (e.g. an OS-scheduled cron run recreates the working copy from the
**source prompt file**). So:

- **Source of truth = the source prompt file** (`*.ctrlyoke.yaml/json`,
  `*.prompt.md`) — a top-level `schedule` block, schema-validated in
  `schemas/workflow-schema.json`. This makes schedules **portable, diffable, and
  committable**, and available to `ctrlyoke run` directly.
- The working file may **cache** next-run/last-run for cheap dashboard display,
  but the definition is authored on the source file.

### Shape (sketch — validate against schema conventions before building)

```jsonc
"schedule": {
  "enabled": true,
  "trigger": {
    // exactly one of:
    "at": "2026-07-15T17:00:00",     // one-shot local datetime
    "cron": "0 9 * * 1-5",           // recurring (5-field), OR
    "rrule": "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9"
  },
  "timezone": "America/New_York",    // REQUIRED for recurrence — see below
  "until": "2026-12-31T00:00:00",    // optional end for recurrence
  "onMissed": "runOnce",             // runOnce | skip  (catch-up policy)
  "onOverlap": "skip"                // skip | queue | replace
}
```

Pick **one** recurrence grammar and stick to it (don't ship both `cron` and
`rrule`). Cron is terser and everyone half-knows it; RRULE handles "last weekday
of month" style rules cron can't. For a coding-workflow tool, **cron (5-field)
plus a one-shot `at`** is the pragmatic default; expose the cron string only
behind "Custom," driving it from the friendly Daily/Weekly/Monthly pickers.

### Semantics to pin down (these are the sharp edges)

- **Timezone / DST.** Store an IANA tz, not a raw offset, or "9am" drifts across
  DST. Next-run math must be tz-aware. Do **not** compute in UTC-only.
- **Missed runs (`onMissed`).** Phase-1 (extension timer) _will_ miss runs while
  closed. On activation, for each schedule whose fire time passed while we were
  down: `runOnce` (fire a single catch-up now) or `skip` (wait for next
  occurrence). Never fire N backlogged occurrences in a burst.
- **Overlap (`onOverlap`).** If the target workflow is already running when the
  schedule fires: `skip` (default, safest for AI runs), `queue` (run after), or
  `replace` (stop + restart). AI runs are expensive and stateful — default to
  `skip`, make anything else explicit.
- **Next-run reconciliation.** Both the extension timer and any OS-fired run must
  update `lastRunAt`/`nextRunAt` in a single source so the UI and the firing
  backend never disagree.

---

## Harness auth constraint (blocks Phase 2 for some harnesses)

A scheduled run is **unattended**: it must start with **no interactive prompt**.
`ctrlyoke run` already drives CLI harnesses, but any harness that needs an
interactive login/approval at start (device-code auth, first-run trust prompts,
per-run permission confirmation) **cannot be scheduled unattended** until it has a
non-interactive path. Before Phase 2:

- Audit each CLI harness for a non-interactive/pre-authed run mode and
  a non-interactive permission mode (there is already a `PERMISSION_MODES`
  concept in the CLI).
- In the schedule editor, **disable/annotate** harnesses that can't run
  unattended, with a clear reason — don't let users schedule a run that will
  silently hang on an auth prompt at 3am.

---

## Phasing

**Phase 0 — Model + validation (no firing).**
Schema `schedule` block, TypeScript types (`CtrlYokeTypes`), schema round-trip in
`PromptFileParser`, next-run computation util (tz-aware), unit tests. Nothing
fires yet; you can author and persist a schedule.

**Phase 1 — Extension-host timer + UI.**
Arm timers on activation; fire via the existing orchestrator start path;
missed-run catch-up on activation; row schedule icon + editor popover; "Scheduled"
dropdown section; message types + serializer handlers to get/set schedules;
Zustand store wiring. Ships real value for machine-stays-on scheduling.

**Phase 2 — OS-scheduler delegation.**
Per-OS generators (Task Scheduler / cron / launchd) that emit a `ctrlyoke run`
command; install/remove on schedule save/delete; harness non-interactive audit;
reconcile OS-fired runs back into history/dashboard. This is the true
set-and-forget milestone.

**Phase 3 (optional) — Dedicated scheduling page** with agenda/calendar view and
scheduled-run history, _if_ usage warrants it.

---

## Cross-layer touch points (keep synchronized)

Per the project's "keep shared contracts synchronized" rule, a schedule change
ripples across:

- `schemas/workflow-schema.json` — `schedule` definition (source of truth).
- `src/types/CtrlYokeTypes.ts` — `Schedule` type on the prompt/working file
  contracts; `src/types/DashboardConstants.ts` — any new state/constant.
- `src/core/orchestration/PromptFileLoader.ts` / `PromptFileParser` — parse +
  validate the block; a tz-aware **next-run util** (new, in `src/utils/`).
- `src/ui/WorkflowSerializer.ts` — get/set-schedule handlers (mirror the
  favorite/`handleToggleFavorite` pattern) + include `schedule`/`nextRunAt` in
  `handleGetRecentWorkflows` payload.
- `src/types/WebviewMessageTypes.ts` + `DashboardConstants` `MESSAGE_TYPES` —
  `GET_SCHEDULE` / `SET_SCHEDULE` / `CLEAR_SCHEDULE` message pair.
- `src/ui/webview-react/store/uiStore.ts` — extend `RecentWorkflow`
  (`schedule?`, `nextRunAt?`) and store actions.
- `src/ui/webview-react/components/workflow/` — `RecentWorkflows.tsx` +
  `RunningWorkflowItem.tsx` (row icon), a new `ScheduleEditor` popover, and the
  "Scheduled" section in `WorkflowStatus.tsx`.
- `src/cli.ts` — ensure `run` accepts everything an OS-fired command needs
  (explicit workspace/cwd, harness, permission mode) for Phase 2.
- Tests: core/orchestration + next-run util in `src/test/**`; UI in
  `src/ui/webview-react/test/**`.

---

## Open questions

1. **Substrate ambition:** is "fires while VS Code is open" (Phase 1) acceptable
   as a first release, or is set-and-forget (Phase 2) table-stakes for the first
   ship? This decides whether Phase 1 ships alone.
2. **Recurrence grammar:** cron-5 + one-shot `at` (recommended), or RRULE?
3. **Timezone UX:** infer machine tz silently, or make it an explicit field?
4. **Does a scheduled run reuse the last working file or always re-derive from the
   source prompt file?** (Affects Phase 2's `ctrlyoke run` target and history.)
5. **Multi-repo / hosted:** if the hosted server is someone's always-on box, is a
   "server-hosted scheduler" a real Phase-2 alternative to OS delegation, or out
   of scope? (It would make the hosted server a genuine executor, which it isn't
   today.)
