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

**Orchestration note (2026-08-24):** the original draft ran Phase 1 (trim) and Phase 2
(reclassify) as two separate full passes over every file. Merged them into one pass per file
group instead — the trim question ("does this fire more than once per user-meaningful event?")
and the reclassify question ("would a user watching the Debug Console want to see what survives?")
are answered by looking at the same call site once, so a second full traversal of the same ~113
backend files bought nothing but doubled read cost. Phase 4 (confirm the shape changed) is no
longer a queued session either — it's cheap enough (`npm run generate:log-inventory` + a read of
the diff) that the orchestrator does it directly during the review pass instead of spending a
session on it.

### Phase 1+2 — Trim and reclassify, per file group

For every `Log.*`/`WebviewLog.*` call site in the group: does it fire more than once per
user-meaningful event (per-render, per-poll, per-byte)? → demote to TRACE, or delete if redundant
with a nearby line. Otherwise, still at DEBUG: would a user watching the Debug Console while their
workflow runs want to see this? → promote to INFO; otherwise leave at DEBUG. Spot-check WARN/ERROR
while in each file: is an expected/recoverable path logged at ERROR (over-alarming), or a real
failure under-reported at WARN?

`dev/backlog/LOG_INVENTORY.md` only prints its top 40 backend files (`MAX_ROWS` in
`scripts/generate-log-inventory.mjs`) — the remaining ~73 files/252 call sites are a long tail not
listed there. Each group below is defined by directory/instruction-file scope, not just the named
files, so grep the group's own scope (e.g. `Log\.(trace|debug|info|warn|error)\(` under
`src/core/harness/shared/`) to catch tail files the table doesn't show.

**Group 1 decisions (2026-08-24):** Copilot integration status and recurring CLI runner-lock
discovery messages are TRACE because they repeat during polling/heartbeat handling. Per-workflow
pause/cancel/resume requests and CLI queue-extension notifications are INFO because they are
user-observable workflow events. A failure to scan the runner-discovery root is WARN because it
can prevent an otherwise active CLI session from being discovered.

**Group 2 decisions (2026-08-24):** In `WorkflowInstance.ts`, continuation mode selection,
resume waits, deferred execution after cancellation, prompt-count growth, and per-step harness
switches are INFO because they explain user-visible run behavior. Session-activity attribution
buffering remains TRACE because it can repeat within one activity burst. The generic runtime
transition line remains DEBUG; Gap #1 will add the step-level lifecycle INFO records later.
Redundant ephemeral "send/add prompt" and pre-delete diagnostics were removed. A missing history
file for a promoted run is ERROR because it disables timeline and manifest persistence for that
run rather than merely taking a degraded fallback.

Groups, sized to ~100-150 call sites each and aligned to `.github/instructions/*.instructions.md`
scopes so each session reads one coherent set of conventions:

1. `src/core/WorkflowOrchestrator.ts` (108) — solo, largest single file.
2. `src/core/WorkflowInstance.ts` (104) — solo, largest single file; also the file Gap #1 extends.
3. Core misc + orchestration: `src/core/PromptQueue.ts`, `WorkflowExecutor.ts`,
   `EndConditionEvaluator.ts`, `WorkingFileManager.ts`, `WorkflowStateMachine.ts`, other
   `src/core/*.ts`, plus `src/core/orchestration/**` (`OutputHistoryManager.ts`,
   `PromptFileLoader.ts`, etc.).
4. Harness plumbing: `src/core/harness/shared/**` (`INotificationMonitor.ts`,
   `CliExecutionRunner.ts`, `CliInteractiveStartupCoordinator.ts`, `CliTransportCoordinator.ts`,
   `HeadlessLogTail.ts`, `SettingsJsonMcpTracker.ts`) plus `CliIntegration.ts`,
   `CliLogMonitor.ts`, `PtyProcessManager.ts`.
5. Harness CLI providers: everything under `src/core/harness/{copilot,claude,codex,opencode,qwen,antigravity}/**`
   (providers, log parsers, permission mappers).
6. Utils + extension + dev: `src/utils/**`, `src/extension.ts`, `src/dev/**`.
7. UI + server: `src/ui/**` excl. `src/ui/webview-react/**` (`WebviewMessageRouter.ts`,
   `WorkflowSerializer.ts`, `PromptEditorSupportService.ts`, `WebviewSettingsSync.ts`,
   `WorkflowStepHandlers.ts`) plus `src/server/**` (`CtrlYokeHostedServer.ts`).
8. Webview: all of `src/ui/webview-react/**` (hooks, components, store, utils, root files). Also
   fold in the wording quirk noted above — `useMessageHandler.ts`'s `[WORKFLOW_DISMISSED]` line
   reads like an error when `loadedWorkflows` is legitimately still empty; reword it while in that
   file.

### Phase 3 — Fill the gaps

- Gap #1: wire `Log.info` into `WorkflowInstance.ts`'s `onAttemptTransition`/`onRuntimeTransition`
  handlers for step-level `WorkflowStateMachine` transitions (see Gap #1 above for exact
  transitions/wording). Run after group 2 lands (same file).
- Gap #2: bring `WebviewLog.info` into use for the same class of run-lifecycle events on the panel
  side, so a user reading the Debug Console gets one coherent story instead of two disconnected
  DEBUG streams from webview + extension host. Run after group 8 lands (touches
  `useMessageHandler.ts` and related webview files).

## Picking this up

Both docs are living/backlog — update them as decisions get made, same as
`dev/backlog/TESTING_GAPS.md` tracks coverage. Re-run `npm run generate:log-inventory` after each
group lands to keep `LOG_INVENTORY.md` current; the orchestrator confirms the overall shape change
(DEBUG shrinks, INFO grows, webview `info=0` stops reading zero) once all groups and gaps are in.
