# Screen reader says nothing when a step ends with "No turn started"

- **Found:** 2026-11-09 by bug-hunt final step (pass 28), claude-cli
- **Area:** `src/ui/webview-react/utils/outputAnnouncements.ts`
- **Severity:** low

## Symptom

With screen reader announcements on (the default, `ui.accessibility.outputAnnouncements`),
a step that starts is announced as "Step N, <name>, started." When that step
then ends as `noTurnStarted` (the harness handled the input itself, e.g. a TUI
command such as `/config`, so no AI turn began), nothing is announced. The
step's badge changes to "No turn started" on screen. A screen reader user only
hears the next step start, or the workflow change, and never learns that this
step ended without doing any work.

`docs/guide/accessibility.md` (#announcements) promises that a step starting
and finishing is announced. `noTurnStarted` was added in ~0ade66c and ~737d3f4,
after the announcer was written, and the announcer was never updated for it.

## Steps to Reproduce

1. Open the dashboard with announcements on (default).
2. Run an interactive step whose prompt is a harness TUI command that starts
   no AI turn (e.g. `/config` on claude-cli), so the step settles as
   `noTurnStarted`.
3. The screen reader announces "Step 1 … started." and then nothing for that
   step.

Unit-level reproduction: in
`src/ui/webview-react/test/utils/outputAnnouncements.test.ts`, observe a
snapshot with step 0 `RUNNING`, then one with step 0 `NO_TURN_STARTED`. The
second `observe` returns `[]`.

## Root Cause

`STEP_STATUS_PHRASES` in `src/ui/webview-react/utils/outputAnnouncements.ts`
(line 79) maps only `RUNNING`, `COMPLETED`, `FAILED` and `CANCELLED`. In
`describeStepChanges`, `announce` returns early when the new status has no
phrase (line 238), so a transition to `STEP_STATUS.NO_TURN_STARTED` is
dropped. The same applies to the final step's status.

## Suggested Fix

Add `[STEP_STATUS.NO_TURN_STARTED]` to `STEP_STATUS_PHRASES` with a phrase
built from the shared label (`PROMPT_TERMINAL_STATUS_LABELS` in
`src/types/DashboardConstants.ts` gives "No turn started"). For example,
"Step 1, Plan, ended: no turn started." The phrase must read naturally after
the step label. Add a test for a queue step and one for the final step. Update
the announcements table in `docs/guide/accessibility.md` to list this outcome.
Leave `SKIPPED` alone unless you confirm a skipped step is announced as
started first.
