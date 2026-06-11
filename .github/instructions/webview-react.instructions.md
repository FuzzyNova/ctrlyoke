---
applyTo: "src/ui/webview-react/**"
---

<purpose>
React dashboard shared by the VS Code webview and the hosted browser client. The extension remains the source of truth for workflow/runtime state; local Zustand stores hold view state, drafts, and transient UI behavior. See the sibling `webview-react-*.instructions.md` files for store, hook, component, and workspace-viewer specifics.
</purpose>

<bootSequence>
- `main.tsx` must keep `./wdyr` as the first import and rehydrate persisted stores before rendering. Moving React mount ahead of rehydrate causes first-paint layout/state drift.
- `BootstrapApp.tsx` is the handshake guard. In the VS Code panel it sends `READY` and captured theme vars before lazy-importing `App`; in standalone mode it must skip that because the hosted server already owns bootstrap/theme caching.
- `types/messages.ts` is a re-export layer over `src/types/DashboardConstants.ts` and `src/types/WebviewMessageTypes.ts`. Do not create webview-only copies of message names or payload shapes.
</bootSequence>

<stateModel>
- `workflowStore` = extension-fed execution state, output timeline, history snapshots, undo metadata.
- `uiStore` = persisted layout/modal/view state.
- `editorStore` = prompt/script draft state and pending prompt-editor inserts.
- `settingsStore` = global settings plus workflow-level overrides and effective-value helpers.
- `terminalStore` = terminal session metadata only; actual xterm instances live in `terminalRegistry.ts`.
</stateModel>

<conventions>
- Use the Vite aliases (`@`, `@components`, `@hooks`, `@store`, `@utils`, `@types`, `@root/types`, `@root/utils`) instead of long relative imports.
- Normalize UI-facing workspace paths to forward-slash, workspace-relative keys. The hosted workspace viewer and navigation helpers rely on stable normalized paths even on Windows.
- Prefer semantic Tailwind token classes from `styles/globals.css` (`bg-editor-bg`, `text-foreground`, etc.) over raw `var(--vscode-...)` in component markup.
- Guard host-specific behavior with the existing standalone helpers instead of branching on ad-hoc URL/window checks.
- `App.tsx` should stay focused on layout composition, panel geometry, and top-level modal/overlay wiring. Business state belongs in stores/hooks, with panel refs only synchronizing visual layout.
</conventions>
