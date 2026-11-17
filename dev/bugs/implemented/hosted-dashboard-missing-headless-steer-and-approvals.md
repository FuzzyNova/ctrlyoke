# Hosted dashboard never shows headless steer targets or approval cards

- **Found:** 2026-11-17 by Claude (review of the headless session control plan; reported independently by Nathan from a phone)
- **Area:** `src/server/CtrlYokeHostedServer.ts`, `src/core/orchestration/RunViewPublisher.ts`
- **Resolution:** fixed in this commit

## Symptom

In the browser (hosted/remote/mobile) dashboard, **Send Steer Message** and **Interrupt Turn**
stayed disabled with "No live harness session for this workflow" while headless steps ran,
and `headlessApprovals: ask` requests never showed an approval card. The request waited for
its whole timeout and was then denied with "nobody answered this approval request". The VS
Code panel worked.

Even in the panel, reloading or reopening the dashboard mid-step lost the steer target until
the next channel opened. A browser reload also lost pending approval cards.

## Steps to Reproduce

1. Enable the hosted server and open the dashboard in a browser.
2. Run a headless Claude step with `toolPermissions: { mode: custom, headlessApprovals: ask }`
   that runs a long command.
3. Open the Run menu: Send Steer Message is disabled. When the step asks for an unlisted tool,
   no card appears.

## Root Cause

`DashboardBroadcastHub` calls `updateHeadlessControlTarget?.()` and
`updateHeadlessApprovalRequest?.()` on each client. `DashboardApplication` (the panel)
inherits both from `PostMessageDashboardSink`, but `CtrlYokeHostedServer` forwards sink
methods one by one and never got these two. The optional call skipped the browser silently.
Because the panel reported delivery, the approval service waited instead of denying at once.

Separately, an open control target was only published when its channel opened or closed.
Pending approvals were replayed only from `WorkflowOrchestrator.replayWorkflowStateTo`, but
a browser reconnect with a preferred view address goes through
`RunViewPublisher.loadRunViewForClient`, which replayed neither.

## Fix

- `CtrlYokeHostedServer` forwards both methods. Approval delivery reports `true` only while a
  browser socket is open.
- `CliTransportCoordinator` records the open target (`getOpenHeadlessControlTarget`), and
  `WorkflowInstance.replayOpenHeadlessControlTargets` re-announces it. `RunViewPublisher`
  replays open targets and pending approvals after the live output buffer; the unaddressed
  `replayWorkflowStateTo` branch does the same.
- A parity test in `CtrlYokeHostedServer.test.ts` fails if any `update*`/`notify*` method of
  `PostMessageDashboardSink` is missing from the hosted server.
