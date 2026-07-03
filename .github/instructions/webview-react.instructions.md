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
- Reuse the shared select/dropdown primitives instead of re-implementing them: `CustomSelect`/`HarnessDropdown`/`SkillsSelect`/`MultiCheckboxDropdown`/`PriorContextSelect` for the selects themselves; the `.fp-select-trigger` class (closed-state box) and `.fp-dropdown-row`/`.fp-dropdown-row-selected` classes (HC hover/selection outline) for trigger and row chrome; `DropdownHiddenToggle` + `useHideableOptions` for the per-item hide feature; and `DropdownPortal` + `useDropdownPortalPosition` + `useClickOutside` for popup positioning. Recurring control shapes belong in `@layer components` in `globals.css`, not copy-pasted utility strings.
- Guard host-specific behavior with the existing standalone helpers instead of branching on ad-hoc URL/window checks.
- `App.tsx` should stay focused on layout composition, panel geometry, and top-level modal/overlay wiring. Business state belongs in stores/hooks, with panel refs only synchronizing visual layout.
</conventions>

<hostBoundaryGotchas>
- The dashboard runs in a **sandboxed, cross-origin iframe**. Events that occur outside it never reach us — including the `mouseup`/`pointerup` that ends a drag which *started* inside the panel — and there is no VS Code API to receive host-level mouse events (and pointer-capture doesn't bridge the boundary). So for any drag-style interaction, never assume you'll get the matching release: disarm the gesture on the next in-iframe signal instead — `keydown`, `blur` (focus leaving the panel), or pointer re-entry. `mouseleave` is NOT a safe teardown trigger because it also fires mid-drag when the pointer is legitimately dragged past an edge. Canonical handling: `CodeMirrorEditor.tsx` `destroyOrphanedMouseSelection` (wired to **window-level, capture-phase** `keydown`/`blur` listeners) tears down CodeMirror's orphaned `MouseSelection`, which otherwise re-pins the caret to position 0 ("stuck cursor") on every later transaction.
- When you need a DOM handler to win over CodeMirror's own key handling, attach it at the **window/document level in the capture phase**, not via `EditorView.domEventHandlers`. CodeMirror runs keydown handlers in a chain where the keymap handles bound keys (arrows, Enter, etc.) first and breaks the chain (`return true` → `preventDefault`), so an extension-level `keydown` handler never fires for exactly those keys. Capture-phase window listeners run before CodeMirror's `handleEvent` (registered in the bubble phase) sees the key at all.
- **Editor auto-expand:** `CodeMirrorEditor.tsx` emits an `fp-editor-overflow-change` CustomEvent (`{ signedOverflow, cause: 'doc' | 'geometry' }`); `App.tsx` consumes it (stable `overflowHandlerRef` pattern, listener registered once) to grow the editor panel up to 60% of the output+editor height and shrink back on delete/submit. Only `doc`-cause events expand — `geometry`-cause events merely update the re-entry guards so a manual panel-drag-smaller isn't immediately undone. Gated by the `ui.autoExpandEditorWhenTyping` ctrlyoke setting (a config-service setting, not a VS Code `package.json` setting).
- **iOS Safari keyboard viewport:** Safari/WebKit does not honor `interactive-widget=resizes-content`; it can both shrink/pan the VisualViewport and leave `h-dvh` sizing based on a different viewport, creating a double-compensation gap above the keyboard. Keep the `App.tsx` iOS-only visual-viewport root pinning scoped to focused editable elements so Chrome/Firefox keep the normal `interactive-widget` path.
- **Dev-reload reconnect** is fragile when both the browser client and the VS Code panel are open: a full `compile` + window reload far exceeds the standalone client's reconnect patience, and a fresh-page reload watchdog can race `acquireVsCodeApi()` (callable once per webview lifetime → React crashes to raw HTML if re-called). The guards are `freshPageReadySent` in `reconnectWatchdog.ts` and `window.__fpExpectServerRestart()` in `standalone-shim.js`; change reload/reconnect timing on both sides together.
</hostBoundaryGotchas>
