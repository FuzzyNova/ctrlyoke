---
applyTo: "src/ui/webview-react/hooks/**"
---

<purpose>
Hooks are the integration layer between the React tree and the runtime: extension message routing, reconnect handling, responsive layout, virtualization, and context menus.
</purpose>

<messageFlow>
- `useMessageHandler.ts` is the single inbound message router. Add new extension messages there (or `terminalMessageHandlers.ts` for terminal-only traffic) instead of scattering `window.addEventListener("message")`.
- Handler code intentionally uses store `getState()` so messages can mutate state outside React render timing. Do not refactor that into component-local callbacks unless the message is truly UI-local.
- `applyWorkflowChange()` is the guarded workflow-switch reset: it clears history view and workflow-local edit caches but preserves the user's in-progress new-step draft.
</messageFlow>

<reconnect>
- Retained VS Code panels and fresh page loads use different READY paths. `BootstrapApp.tsx` and `reconnectWatchdog.ts` coordinate them; "simplifying" those flags tends to reintroduce lost-startup-message or raw-HTML reload bugs.
- In standalone mode the hosted server already performs READY/theme bootstrap. Sending READY too early from the browser can drop `SESSION_RESTORED`/startup messages and poison cached theme vars.
- `useVsCodeApi()` must tolerate the API object being replaced after reconnect. Always resolve through the helper instead of pinning the first object yourself.
- **`standalone-shim.js` DROPS any outbound message posted while the socket is down — it does not queue it.** That is deliberate (queuing once replayed a pre-outage "Re-run" click into a freshly restarted extension host and launched a run with no user action), and only the READY handshake is exempt. The consequence for every request/response pair the client owns: a request tapped inside one of the reconnect gaps a mobile browser produces never reaches the extension, so *nothing* will ever answer it — a one-shot timeout is not a recovery strategy, because the retry can land in the same dead window. Reissue on an interval (cheap no-op while down, lands the instant the socket returns) and bound the total attempts so the request is eventually retired. `useRunViewLoadWatchdog` is the worked example, and the state it guards shows why retiring matters: an outstanding `pendingRunViewRequestId` suppresses every *requestless* `RUN_VIEW_LOADED`, so a lost request silently stops all server-initiated view updates (other clients' definition mutations, draft→run promotions, rewind invalidations), and for a cross-lineage switch the pointer-event-swallowing `WorkflowSwitchOverlay` sits on top of that — the dashboard reads as frozen. Correspondingly, a backend handler for such a request must answer on **every** path including the ones that decline to work (`LOAD_RUN_VIEW`'s missing-orchestrator early return used to just `return`).
- **Every terminal outcome of an *optimistic* navigation must roll it back, not merely retire it.** `requestRunViewLoad` moves `displayedViewAddress` (and the run summaries, execution ref, revisions, and history framing that go with it) before the snapshot exists, so a request that ends in failure — watchdog give-up or a `WORKFLOW_ACTION_FAILED` from the backend — leaves the client addressed to a workflow whose content was never applied: the header names one workflow, the panels render another, and Run/Resume/Stop plus the run selector all target the wrong lineage. `uiStore.rollbackRunViewLoad` restores the snapshot `requestRunViewLoad` captured and drops `appliedViewAddress` (so a click on the workflow just returned to is a real reload rather than the no-op `navigateToWorkflowAddress`'s displayed==applied short-circuit would make it). The toast is what tells the user it failed; the state itself must always land somewhere coherent.
</reconnect>

<specializedHooks>
- Output hooks (`useOutput*`) are a pipeline: row projection/modeling -> virtualization/scroll seek -> find/navigation/minimap -> export/undo helpers. Keep heavy output math in hooks/utilities, not JSX render paths.
- **The virtualizer's `estimateSize` must stay O(1) per row.** TanStack rebuilds its whole measurements array whenever any single row reports a size, calling `estimateSize` for every index from the lowest changed one to `count` — so on a 6,000-row workflow one measured row costs thousands of estimates, at least once per commit. `estimateOutputRowHeight` is not cheap (a Bash row re-sanitizes its event's full output to size a preview of a few hundred chars: ~190ms for one 4,800-row pass on a desktop, seconds on a phone), so it memoizes on the row object and `buildOutputRows` publishes rows already warm. Anything else added to that path needs the same treatment — the symptom is 600-2500ms React commits for a pane holding under a dozen rows, which reads as scroll jank rather than as an estimation cost.
- Layout hooks and drawer-tab override hooks exist to keep `App.tsx` and editor components from duplicating breakpoint-specific logic. Extend those helpers rather than adding more inline branching.
</specializedHooks>
