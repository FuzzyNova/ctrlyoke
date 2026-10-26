# Replayed step outputs rebuild every output row once per message, freezing the dashboard for minutes

- **Found:** 2026-10-25 by Claude (session log review, user report of an unresponsive Pause button)
- **Area:** `src/core/OutputCaptureBuffer.ts`, `src/ui/webview-react/hooks/useOutputRowsModel.ts`, `src/ui/webview-react/hooks/useMessageHandler.ts`
- **Resolution:** fixed in this commit (suggested fixes 1, 3 and 4; Pause feedback lands in the following commit). Fixes 2, 5 and 6 remain possible further optimizations.

## Symptom

Switching the panel to a large workflow that is still running (`bug drain`: 26 steps,
2,256 output messages, 4,729 rows) left the dashboard unresponsive for about two
minutes. The user clicked Pause five times because the button never changed state.

The first click did register. The engine went to `pausing` within 2 ms, but the
dashboard only applied that state **108 s later**:

```
04:52:39.075  [panel] run pause requested
04:52:39.077  [inst:ad6e0530] Runtime transition pause: running -> pausing (step 23/26)
04:53:09.252  [panel] run pause requested        (2nd click)
04:53:33.859  [panel] run pause requested        (3rd)
04:53:51.355  [panel] run pause requested        (4th)
04:54:21.474  [panel] run pause requested        (5th)
04:54:26.900  [panel] [workflowStore.setExecutionState] running -> pausing
```

Between 04:52:27, when the run view finished loading, and 04:54:28, the dashboard logged
`buildOutputRows` back to back about 60 times. Each one took 1.7–4.0 s and reported the
same `"messages":2256`, so nothing visible changed between rebuilds. No `uiStore` write
was applied for that whole window either. Every inbound message was waiting behind the
rebuilds. `[PanelMemory]` grew 356 MB over the same window.

The same pattern appears at other times in `ctrlyoke-1792861731571.log` (for example, 46
slow rebuilds in the 17:56 minute and 44 in the 20:13 minute).

## Steps to Reproduce

1. Run a workflow long enough to have a couple of thousand output messages (20+ completed
   steps with tool-heavy output).
2. While it is still running, switch the panel to another workflow and then back to it.
3. Click Pause right after the output appears.
4. The output pane rebuilds continuously for tens of seconds to minutes. The Pause button
   keeps showing Pause, and the dashboard shows `pausing` only after the rebuilds stop.

## Root Cause

1. `OutputCaptureBuffer.replayTo` (#sym:src/core/OutputCaptureBuffer.ts:replayTo:555-710)
   restores a running workflow by sending **one `CLI_OUTPUT` message per completed
   attempt**: 23 steps + 2 final-step passes + status messages + the streaming buffer, about
   26 messages per replay. In this log the replay ran twice, because the old time-based
   run-view watchdog reissued the load (`reissue 1/4`; that reissue was removed in
   ~45a330a), so the panel got about 52 messages.
2. Each message arrives as its own `MessageEvent`, so React renders after each one. Every
   replayed output replaces an entry the snapshot already delivered. The message count
   stays at 2,256, but the entry identities change, so the `buildOutputRows` memo in
   #selection:src/ui/webview-react/hooks/useOutputRowsModel.ts:216-298 recomputes the
   whole row model each time. That takes 2–4 s at this size.
3. About 52 messages × about 2 s each ≈ 104 s, which matches the 108 s delay before
   `EXECUTION_STATE_CHANGED` (`pausing`) reached the store.

The cost of each rebuild also grows with the whole run. `buildOutputRows` has no
incremental path, so one changed entry rebuilds all 4,729 rows.

`workflowStore` is not passed to `watchStoreWrites` (`src/ui/webview-react/main.tsx`),
which is why the log shows no store writes behind the rebuilds.

## Suggested Fix

In order of payoff:

1. **Replay as one batch.** Have `replayTo` collect the completed outputs into a single
   message, or bracket the replay with begin/end markers. Then have the webview apply the
   batch in one store write, so a replay costs one rebuild instead of about 26.
2. **Make a replay with no changes cost nothing.** When a replayed output matches the
   entry the snapshot already delivered, keep the existing reference
   (`preserveReferences`), so the memo dependencies do not change at all.
3. **Coalesce inbound store writes.** Queue the high-volume handlers (`CLI_OUTPUT`,
   activity, streaming) and apply them once per animation frame, so a burst of messages
   triggers one render. A backlog then cannot hold back lifecycle messages such as
   `EXECUTION_STATE_CHANGED`.
4. **Give Pause immediate feedback.** Show a pending state on click, cleared by the next
   execution-state message, so the user can see that the request was sent even when the
   dashboard is slow.
5. Longer term: an incremental `buildOutputRows` that rebuilds only the targets whose
   entries changed.
6. Add `workflowStore` to `watchStoreWrites` (with the burst threshold tuned for
   streaming) so the next rebuild storm names the key that keeps changing.
