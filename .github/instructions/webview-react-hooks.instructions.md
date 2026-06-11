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
</reconnect>

<specializedHooks>
- Output hooks (`useOutput*`) are a pipeline: row projection/modeling -> virtualization/scroll seek -> find/navigation/minimap -> export/undo helpers. Keep heavy output math in hooks/utilities, not JSX render paths.
- Layout hooks and drawer-tab override hooks exist to keep `App.tsx` and editor components from duplicating breakpoint-specific logic. Extend those helpers rather than adding more inline branching.
</specializedHooks>
