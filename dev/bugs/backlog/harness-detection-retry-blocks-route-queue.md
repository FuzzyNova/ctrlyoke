# Harness detection retry blocks the shared dashboard route queue

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude, code review of 1a02f8d4f)
- **Area:** `src/ui/DashboardMessageRouter.ts`, `src/core/WorkflowOrchestrator.ts`
- **Severity:** medium

## Symptom

Clicking **Retry** in the harness dropdown or **Check again** in the "No CLI coding agent"
panel freezes the whole dashboard (panel and every hosted tab) until the retry finishes.
Clicks, history loads, settings saves and run-start messages all wait. The session log
shows a `[RouteTiming] slow route type=retryHarnessDetection ... runMs=<seconds>` line
followed by `waitMs` victims.

## Steps to Reproduce

1. Use a login shell with a slow profile (nvm, oh-my-zsh, conda; 1–3 s is common), or a
   machine where one or more harness `--version` probes are slow (Windows `.cmd` shims,
   antivirus).
2. Open the dashboard and click **Retry** in the harness dropdown.
3. While the retry is pending, click anything else in the dashboard (open a run, switch
   tabs, open settings). Nothing responds until the retry returns.

## Root Cause

Since 1a02f8d4f, `WorkflowOrchestrator.retryHarnessDetection()`
(`src/core/WorkflowOrchestrator.ts:5177`) first awaits `refreshProcessSearchPath()`,
which spawns an interactive login shell with a 10 s timeout
(`src/utils/SearchPathRefresh.ts`, `SEARCH_PATH_READ_TIMEOUT_MS`), then re-runs
`initialize()` on all six harness integrations, each of which runs a `--version` probe
with up to `CLI_VERSION_CHECK_TIMEOUT_MS` (30 s,
`src/core/harness/shared/interfaces/IHarnessAdapter.ts:40`). Worst case is ~40 s, and the
webview hook itself budgets 45 s (`HARNESS_DETECTION_RETRY_TIMEOUT_MS`).

The `RETRY_HARNESS_DETECTION` handler (`src/ui/DashboardMessageRouter.ts:2850`) awaits
that whole call, but the message type is not in `OFF_QUEUE_MESSAGE_TYPES`
(`src/ui/DashboardMessageRouter.ts:226`), so it runs inside the single serialized
`routeQueue` that every message from every client shares. This is the same class of bug
as `dev/bugs/implemented/secret-registry-request-blocks-route-queue-with-powershell-spawns.md`
and `completion-requests-block-route-queue-and-cannot-be-superseded.md`.

## Suggested Fix

Add `MESSAGE_TYPES.RETRY_HARNESS_DETECTION` to `OFF_QUEUE_MESSAGE_TYPES`. The handler only
updates `process.env.PATH` and the detector integrations' status (already broadcast via
`onDidChangeStatus`), and replies with a request-ID-tagged result that the off-queue path
suppresses if the client disconnected. Also make concurrent retries coalesce in
`WorkflowOrchestrator.retryHarnessDetection()` (share one in-flight promise), since
leaving the queue removes the serialization that used to prevent two clients' retries from
re-initializing the same integrations at once. Add a `DashboardMessageRouter` test that a
queued message is routed while a retry is still pending.
