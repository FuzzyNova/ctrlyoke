# Debug Logging Cleanup Plan

Companion to `dev/backlog/LOG_INVENTORY.md` (the generated census of every `Log.*`/`WebviewLog.*`
call site — re-run `npm run generate:log-inventory` after each triage pass to see the shape
change). This doc is where the actual decisions and phased plan live.

## Why this exists

Users see everything at INFO-and-above in VS Code's Debug Console by default, and can opt up to
TRACE via VS Code's log level setting (`src/utils/Log.ts` — `fromVSCodeLogLevel`; dev builds
always run at TRACE, see `IS_DEV_MODE` in `Log.initialize()`). So the INFO/DEBUG/TRACE split is a
real, user-facing decision about what a non-dev sees by default, not just internal hygiene.

Right now that split doesn't hold a consistent meaning. Sampling a live session log
(`.ctrlyoke/logs/ctrlyoke-1787605290037.log`, 1048 lines: 854 DEBUG / 123 TRACE / 70 INFO) shows
DEBUG carrying both real state changes worth surfacing to a user ("Queue state → completed") and
pure internal/high-frequency chatter that never matters outside active development. Only 16 of
1073 backend call sites use TRACE at all (`dev/backlog/LOG_INVENTORY.md`), which is a strong
signal that a lot of what's tagged DEBUG today is actually TRACE-shaped and just never got moved.

## Target level semantics

| Level     | Who sees it by default                                              | What belongs here                                                                                                                                                                                                                                                                                                    |
| --------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TRACE** | Opt-in only (dev builds always; prod via VS Code log level setting) | Anything that fires more than once per user-meaningful event: per-render, per-poll, per-viewport-resize, per-byte-of-CLI-output. Only useful when actively chasing a specific rendering/polling/parsing bug.                                                                                                         |
| **DEBUG** | Opt-in (one step up from INFO)                                      | Every `WorkflowStateMachine` transition (run-level _and_ step-level — see Gap #1), internal registry/instance bookkeeping, message-routing detail. The "how did we get here" layer for diagnosing an issue, but not noise per animation frame.                                                                       |
| **INFO**  | On by default                                                       | The play-by-play a user watching their run would want: workflow started/paused/resumed/stopped/completed/failed, each step started (with its resolved command/harness), step completed/failed/retried. Mirrors what the dashboard already shows visually — INFO should read like a text transcript of the dashboard. |
| **WARN**  | On by default                                                       | Recoverable anomalies, fallback paths taken, degraded-but-continuing behavior.                                                                                                                                                                                                                                       |
| **ERROR** | On by default                                                       | Unrecoverable or user-impacting failures.                                                                                                                                                                                                                                                                            |

This extends the split you described (INFO = user-facing play-by-play, DEBUG = every state
transition) with an explicit TRACE tier for the high-frequency stuff currently misfiled as DEBUG,
and states the same intent for `WebviewLog.ts` so both logging paths share one scheme instead of
drifting independently.

## Gap #1 — `WorkflowStateMachine` step-level transitions are never logged

`WorkflowStateMachine.ts` owns two separate transition streams:

- **Run-level** (`onDidTransition`, fired by `startExecution`/`pause`/`confirmPaused`/`cancelPause`/`resume`/`requestStop`/`confirmStopped`/`complete`/`fail`, lines 392-544)
- **Step-level** (`onDidAttemptTransition`, fired by `beginAttempt`/`scheduleRetry`/`completeAttempt`/`failAttempt`/`cancelAttempt`, lines 147-362)

`WorkflowInstance.ts` subscribes to both at construction (lines 585-588):

- `onRuntimeTransition` (`WorkflowInstance.ts:4878`) logs **every** run-level command uniformly
  via one `Log.debug` line — `Runtime transition ${command}: ${previous} -> ${current} (step i/n)`.
  It doesn't distinguish "headline" transitions (start/complete/fail/stop) from routine ones
  (pause/resume), and none of it is promoted to INFO today.
- `onAttemptTransition` (`WorkflowInstance.ts:4938`) has **zero** `Log.*` calls. It reads the
  transition and forwards straight to `dashboardSink` updates (step status, retry count). This is
  exactly the "new step started, command of the step" play-by-play — and it's currently invisible
  in the log file entirely.

Proposed fix (a future session — not applied in this one):

- Add `Log.info` in `onAttemptTransition` for `BEGIN` (step index, attempt index) and terminal
  outcomes `COMPLETE`/`FAIL` (with `failureReason` on fail). `BEGIN` needs the step's resolved
  command/harness for the "command of the step" detail the user wants — that isn't on
  `WorkflowAttemptTarget` today, so this needs a `PromptQueue` lookup by `stepIndex`, the same way
  `onQueueStateChanged` already reads `state.steps`.
- Leave `SCHEDULE_RETRY`/`CANCEL` at `Log.debug` for now (dashboard already shows retry-in-progress
  visually) — revisit if retries turn out to be a common thing users grep for.
- Split `onRuntimeTransition`: promote `startExecution`/`complete`/`fail`/`requestStop`/`confirmStopped`
  to `Log.info` with a short human phrasing ("Workflow started", "Workflow completed", "Workflow
  stopped"); leave `pause`/`confirmPaused`/`cancelPause`/`resume` at `Log.debug` — open question
  whether pause/resume (also dashboard-visible user actions) should be INFO too.

## Gap #2 — the webview never uses `WebviewLog.info`

Per `LOG_INVENTORY.md`: 0 of 102 `WebviewLog.*` calls are `.info` (74 debug, 12 warn, 16 error).
If INFO is meant to be the user-facing play-by-play and the dashboard is the primary user-facing
surface, the panel side should be using `WebviewLog.info` for the same class of events (a run
switched into view, a run started/stopped from a UI action) instead of folding everything into
debug or skipping logging altogether. Otherwise INFO only ever tells half the story — the
extension-host half — even though most of what a user does happens through the panel.

## Gap #3 — DEBUG carries TRACE-shaped chatter

Only 16 of 1073 backend call sites use `Log.trace`. The sampled session log shows DEBUG lines that
fire once per viewport resize — `[panel] [terminalRegistry.measureViewportContainer]`,
`[panel] [TerminalView] empty-pane viewport hint`, `[panel] [OutputSection] terminal pane` all fire
together, repeatedly, every time a pane resizes (4 occurrences in a ~150-line window of one
session). None of these matter for "what happened in my run" — they're rendering-diagnostic detail
and belong at TRACE.

For contrast, `[getWorkflowSummaries]` / `[GET_WORKFLOWS_LIST]` (also fire on every dropdown open)
are _already_ correctly at TRACE — proof the split is achievable, it just hasn't been applied
consistently.

## A quirk worth folding into the trim pass (not a bug)

`[panel] [WORKFLOW_DISMISSED] inst:X (was: name="(not found)" state=?) — loadedWorkflows before:
[(none)]` (`useMessageHandler.ts:2577-2579`) fires every time a freshly-built instance is dismissed
while loading a different run — `loadedWorkflows` legitimately hasn't been populated yet at that
point, so `[(none)]` is correct. Confirmed by re-sampling: the identical shape appears at least
twice more in the most recent session log, always immediately after `buildWorkflowInstance` /
`setViewedWorkflowId`, never as a genuine backend/webview desync. But `(was: name="(not found)")`
reads like an error to anyone scanning the log — worth a wording pass during the trim, not a
functional fix.

## Phased approach

### Phase 1 — Trim (no new logs)

Walk `dev/backlog/LOG_INVENTORY.md` file-by-file, biggest first. `WorkflowOrchestrator.ts` (108
call sites) and `WorkflowInstance.ts` (104) alone are ~20% of all backend call sites — highest
leverage, start there. For each site: does it fire more than once per user-meaningful event? If
yes, demote to TRACE or delete if redundant with a nearby line.

### Phase 2 — Reclassify what survives the trim

Re-walk the trimmed inventory. For everything still at DEBUG: would a user watching the Debug
Console while their workflow runs want to see this? If yes, promote to INFO; otherwise it stays
DEBUG. Spot-check the WARN/ERROR split too — 278 warns + 186 errors backend-side is a lot; sample
the top files (`CtrlYokeHostedServer.ts`: 8 warn/22 error, `WorkflowSerializer.ts`: 6 warn/12
error) for cases where an expected/recoverable path is logged at ERROR (over-alarming) or a real
failure is under-reported at WARN. Not a full audit in this phase — just enough sampling to tell
whether the split is trustworthy.

### Phase 3 — Fill the gaps

- Wire `Log.info` into `WorkflowStateMachine` step-level transitions (Gap #1).
- Bring `WebviewLog.info` into use for the same class of run-lifecycle events on the panel side
  (Gap #2), so a user reading the Debug Console gets one coherent story instead of two
  disconnected DEBUG streams from webview + extension host.

### Phase 4 — Confirm the shape changed

`npm run generate:log-inventory` again. DEBUG's total should have shrunk (moved to TRACE and
INFO), INFO should have grown, and the webview's `info=0` column should no longer read zero.

## Picking this up

Start from `dev/backlog/LOG_INVENTORY.md`, biggest files first. Both docs are living/backlog —
update them as decisions get made, same as `dev/backlog/TESTING_GAPS.md` tracks coverage. No
logging call sites were changed in the session that produced this plan; `scripts/generate-log-inventory.mjs`
and these two docs are the only new artifacts.
