---
applyTo: "src/ui/webview-react/components/**"
exclude: "src/ui/webview-react/components/workspace-viewer/**"
---

<purpose>
Most components are thin renderers over Zustand selectors and message senders. Keep cross-component state in stores/hooks and keep components focused on layout, event wiring, and display logic.
</purpose>

<patterns>
- `PromptEditor` persists only the "new prompt" draft to VS Code state. Existing-step edits are workflow-local and must continue to flow through `editorStore.pendingEdits`.
- Prompt properties use a tri-state model: `undefined` = inherit, `null` = explicitly disabled, value = override. Keep footer quick pickers, `PropertiesDrawer`, and workflow properties UIs aligned with that semantics.
- History search/navigation is intentionally multi-step: the modal stores a pending navigation, requests `LOAD_WORKFLOW`, then output navigation runs after workflow/history data is restored. Preserve that handshake when changing search flows.
- `OutputSection` is the orchestration layer for output rendering, minimap navigation, terminal tabs, and virtualization settings. Heavy row/diff/scroll logic belongs in hooks/utils, while `components/output/*` stays mostly presentational.
- Shared dropdowns/portals/modals exist to solve z-index and overflow issues inside resizable panels and fullscreen drawers. Reuse them instead of creating local popover implementations.
- For responsive layouts with multiple visual tiers (e.g. `Header.tsx`'s narrow/medium/wide grid arrangement): if a tier-specific slot holds a *stateful* component (own dropdown-open state, `ResizeObserver`, document-level listeners, mount-time postMessage), don't mount one copy per tier and hide the inactive ones with Tailwind `hidden`/responsive classes — that runs N simultaneous live instances (N× the listeners/observers/postMessages) even though only one is ever visible, and was the root cause of a hard-to-reproduce iOS Safari row-misalignment bug in `WorkflowStatus`. Instead, gate the mount itself with a `useMediaQuery` boolean matching the same Tailwind breakpoint (see `Header.tsx`'s `isMediumLayout`/`isWideLayout`) so exactly one instance mounts; keep the surrounding wrapper divs' visibility purely CSS-driven so sibling layout doesn't flash on resize.
- For touchable dropdown/list rows that also contain sibling action buttons (favorite/delete/pause/etc.), do not make the entire row a focusable `div role="button"` with nested real buttons. On mobile Safari/Firefox that pseudo-button focus/hover state can produce sticky per-row layout drift. Use a non-focusable row container, a native primary `<button>` for the main row action, and sibling native buttons for secondary actions. If the row has fixed trailing metadata, prefer explicit grid tracks with the name in `minmax(0,1fr)` over flex negotiation so touch hover/focus cannot let the name column expand and push metadata sideways. Inside vertically scrollable dropdown containers, do not rely on row auto width or `w-full` for column alignment: WebKit can resolve touched/hovered rows against the full scrollport while untouched rows use the content width minus the scrollbar gutter, shifting trailing columns by the gutter width. Lock those rows to a measured `calc(100% - gutter)` width when this pattern appears.
</patterns>

<styling>
- Use semantic Tailwind token classes from `styles/globals.css`; raw VS Code CSS vars should stay in token-definition or low-level theme code.
- Browser-hosted and VS Code panel UIs share the same bundle, so host-specific behavior must go through the existing standalone/vscode helpers.
</styling>
