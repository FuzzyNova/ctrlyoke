# Mobile Layout Redesign Plan

## Goal

Replace the current 4-panel vertical stack on mobile with a layout that mirrors the desktop
philosophy: a persistent center area (output + editor) flanked by two on-demand drawers
(prompts left, workflow properties right), triggered by icon buttons in the header.

---

## Decisions

| Question                                 | Decision                                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompts sidebar width                    | 72 px                                                                                                                                                         |
| Default prompts open mode                | `sidebar`                                                                                                                                                     |
| Tap outside prompts overlay (fullwidth)  | Returns to sidebar mode                                                                                                                                       |
| Tap outside settings overlay             | Closes overlay                                                                                                                                                |
| Both output + editor collapsed on mobile | Keep existing behavior — users can collapse both panels, matching VS Code's collapsible-panels pattern                                                        |
| Context % stat in sidebar chip           | `Math.round((contextWindowUsed / contextWindowSize) * 100)` — single-source this helper (currently duplicated in `CliOutput.tsx` and `PromptItemDetails.tsx`) |

---

## Architecture

### What changes on mobile

| Panel                   | Old                         | New                                                                      |
| ----------------------- | --------------------------- | ------------------------------------------------------------------------ |
| PromptsPanel            | 4th panel in vertical stack | Left sidebar (72 px) **or** full-width overlay, toggled by header button |
| WorkflowPropertiesPanel | 1st panel in vertical stack | Full-width overlay drawer, toggled by header button                      |
| Output + Editor         | 2nd + 3rd panels            | Same react-resizable-panels vertical Group — always the center content   |

### Why drawers instead of panels

- `WorkflowPropertiesPanel` needs full-width overlay behavior — trying to animate a react-resizable-panel to/from zero is fragile. A `position:absolute inset-0` div with a CSS slide transition is correct and simple.
- `PromptsPanel` sidebar mode needs to push the center content right — a flex sibling div achieves this without a panel library. Full-width mode uses the same overlay approach as WorkflowProperties.

---

## New State (uiStore.ts)

Add to `UiState` (transient — **not persisted**):

```typescript
// Mobile drawer/sidebar state
mobilePromptsOpen: boolean; // prompts panel visible
mobilePromptsMode: "sidebar" | "fullwidth"; // how prompts are shown when open
mobileSettingsOpen: boolean; // settings overlay visible
```

Add to `UiActions`:

```typescript
toggleMobilePrompts: () => void;
setMobilePromptsMode: (mode: 'sidebar' | 'fullwidth') => void;
toggleMobileSettings: () => void;
closeMobilePrompts: () => void;
closeMobileSettings: () => void;
```

The existing `promptsCollapsed` and `settingsCollapsed` fields are **not used on mobile** after
this change — they continue to drive the desktop layout.

---

## Header.tsx Changes

The current narrow-mode second row shows only `WorkflowStatus`. New layout:

```
[codicon-list-unordered]  [WorkflowStatus — flex-1, centered]  [codicon-settings]
```

### Implementation

- Add `useIsMobile()` directly inside `Header` (already available in the codebase).
- Add two optional props: `onToggleMobilePrompts?: () => void` and `onToggleMobileSettings?: () => void`.
- Render the two icon buttons **only when `isMobile`** is true, flanking `WorkflowStatus`.
- Highlight the button when the corresponding panel is open (read `mobilePromptsOpen` /
  `mobileSettingsOpen` from uiStore for active state styling).
- Reuse the existing `control-button` button style.

```tsx
{
  isMobile && (
    <button
      className={cn("control-button", mobilePromptsOpen && "active")}
      onClick={onToggleMobilePrompts}
      title="Prompts"
      aria-label="Toggle prompts panel"
    >
      <i className="codicon codicon-list-unordered" />
    </button>
  );
}
<WorkflowStatus className="flex-1 sm:max-w-[500px]" />;
{
  isMobile && (
    <button
      className={cn("control-button", mobileSettingsOpen && "active")}
      onClick={onToggleMobileSettings}
      title="Workflow Properties"
      aria-label="Toggle workflow properties"
    >
      <i className="codicon codicon-settings" />
    </button>
  );
}
```

---

## Mobile Layout (App.tsx)

Rewrite the `if (isMobile) { ... }` block:

```tsx
if (isMobile) {
  return (
    <div className="h-screen w-full flex flex-col bg-editor-bg text-foreground">
      <Header
        onToggleMobilePrompts={toggleMobilePrompts}
        onToggleMobileSettings={toggleMobileSettings}
      />

      {/* Main area — relative container for absolute overlays */}
      <div className="flex-1 relative overflow-hidden flex">

        {/* Sidebar prompts — flex sibling, takes 72px, pushes center right */}
        {mobilePromptsOpen && mobilePromptsMode === 'sidebar' && (
          <div className="w-[72px] flex-shrink-0 h-full border-r border-panel-border bg-sidebar-bg overflow-y-auto">
            <MobilePromptsSidebar />
          </div>
        )}

        {/* Center content: output + editor vertical split */}
        <div className="flex-1 flex flex-col min-w-0">
          <Group orientation="vertical" className="flex-1" id="mobile-center-layout">
            <Panel
              ref={mobile.mobileOutputRef}
              defaultSize={lastMobileSizes.output}
              collapsible
              collapsedSize="30px"
              minSize={PANEL_MIN_SIZE_CENTER}
              id="mobile-output-panel"
              onResize={...}
            >
              <OutputSection />
            </Panel>
            <Separator className={SEPARATOR_HORIZONTAL} />
            <Panel
              ref={mobile.mobileEditorRef}
              defaultSize={lastMobileSizes.editor}
              collapsible
              collapsedSize="30px"
              minSize={PANEL_MIN_SIZE_CENTER}
              id="mobile-editor-panel"
              onResize={...}
            >
              <EditorSection />
            </Panel>
          </Group>
        </div>

        {/* Full-width prompts overlay */}
        {mobilePromptsOpen && mobilePromptsMode === 'fullwidth' && (
          <>
            {/* Backdrop — tap outside returns to sidebar mode */}
            <div
              className="absolute inset-0 z-20"
              onClick={() => setMobilePromptsMode('sidebar')}
            />
            <div className="absolute inset-0 z-30 bg-editor-bg flex flex-col">
              <PromptsPanel
                onRequestSidebar={() => setMobilePromptsMode('sidebar')}
                onRequestClose={closeMobilePrompts}
              />
            </div>
          </>
        )}

        {/* Settings overlay drawer */}
        {mobileSettingsOpen && (
          <>
            {/* Backdrop — tap outside closes */}
            <div
              className="absolute inset-0 z-30"
              onClick={closeMobileSettings}
            />
            <div className="absolute inset-0 z-40 bg-editor-bg flex flex-col">
              <WorkflowPropertiesPanel onRequestClose={closeMobileSettings} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

Both output and editor retain their individual collapse buttons (inside `OutputSection` /
`EditorSection` panel bars). When both are collapsed, VS Code–style double-bar behavior is
preserved — no special case needed because the `Group` handles it.

---

## useMobileLayout.ts Simplification

The hook currently manages refs and layout logic for 4 panels. After this change, mobile only
needs 2 center panels:

**Keep:**

- `mobileOutputRef` + `mobileEditorRef`
- `mobileCenterGroupRef` (rename from `mobileGroupRef` if needed)
- Mount-time default sizing for output + editor

**Remove:**

- All refs and logic for `mobilePromptsRef` and `mobileSettingsRef`
- The multi-panel `setLayout` edge-case logic that handled "settings + prompts collapsed,
  editor open" etc.

---

## New Component: MobilePromptsSidebar.tsx

**Location:** `src/ui/webview-react/components/layout/MobilePromptsSidebar.tsx`

A vertically scrollable list of compact prompt chips. Each chip (64 px tall, 72 px wide):

```
┌────────────────────────┐
│  [StatusIcon]          │   ← 24px icon, centered
│  [SetStartPos button]  │   ← only when canChangeStartPosition
│  [ctx: 42%]            │   ← context% if available, small text
└────────────────────────┘
     1                       ← slot number
```

At the top: a toggle button (`codicon-arrow-both` or `codicon-layout-panel-left`) that switches
`mobilePromptsMode` to `'fullwidth'` to open the full panel view.

**Context % stat:** calls the shared `formatContextPct` utility (see below). Shows as `"42%"` in
`text-xs` below the status icon. Hidden if tokens not available.

**No drag-and-drop, no names, no text preview** — intentionally minimal.

**Data source:** reads from the same stores as PromptsPanel (workflowStore prompts,
executionState, retryStates).

---

## PromptsPanel.tsx Changes

Add two optional props for mobile fullwidth overlay mode:

```typescript
onRequestSidebar?: () => void;   // "collapse to sidebar" button
onRequestClose?: () => void;     // "close prompts" button
```

When these props are present, render two icon buttons in the panel header row:

- `codicon-layout-sidebar-left` → calls `onRequestSidebar`
- `codicon-close` → calls `onRequestClose`

Desktop renders without these props — **no behavior change on desktop.**

---

## WorkflowPropertiesPanel.tsx Changes

Add one optional prop:

```typescript
onRequestClose?: () => void;
```

When present (mobile overlay mode), render a `codicon-close` button in the panel header.
Desktop renders without this prop — **no behavior change on desktop.**

---

## Single-Source Context % Utility

The context percentage calculation is currently duplicated:

- `src/ui/webview-react/components/output/CliOutput.tsx:783-797`
- `src/ui/webview-react/components/prompts/PromptItemDetails.tsx:54-57`

Extract to a shared utility in `src/ui/webview-react/utils/tokenUtils.ts` (or add to
`tokenizer.ts` if it fits):

```typescript
/**
 * Returns the context window usage percentage (0-100), or undefined if data unavailable.
 */
export function calcContextPct(
  contextWindowUsed: number | undefined,
  contextWindowSize: number | undefined
): number | undefined {
  if (contextWindowUsed === undefined || !contextWindowSize) return undefined;
  return Math.round((contextWindowUsed / contextWindowSize) * 100);
}
```

Update both existing call sites to use `calcContextPct`. `MobilePromptsSidebar` uses it too.

---

## CSS Transitions (Slide-in animation)

Both overlays slide in with Tailwind transition classes. On mount the div is already at
`translate-x-0` / `translate-y-0` because React renders it only when the state is true — use
`animate-` classes or a `transition` + initial-class approach:

```tsx
// Settings slides from right
<div className="absolute inset-0 z-40 bg-editor-bg flex flex-col
                translate-x-0 transition-transform duration-200 ease-out">
```

For the enter animation, a small `useEffect` that removes an `translate-x-full` class on mount
is the simplest approach that doesn't require a library. Optional polish — can be deferred.

---

## Corner Cases / Implementation Notes

**1. Mobile → Desktop transition must close drawers**
When `isMobile` flips to `false`, `mobilePromptsOpen` and `mobileSettingsOpen` remain `true` in
uiStore. On the next mobile session the drawers would immediately reappear. Add a `useEffect` in
App.tsx:

```typescript
useEffect(() => {
  if (!isMobile) {
    closeMobilePrompts();
    closeMobileSettings();
  }
}, [isMobile]);
```

**2. `mobileWasAllCollapsed` ref must check only output + editor**
This ref gates Group remounting in App.tsx. Currently it's initialized as
`promptsCollapsed && outputCollapsed && editorCollapsed && settingsCollapsed`. After this change
it should only check `outputCollapsed && editorCollapsed` — prompts and settings are no longer
panels in the center Group.

**3. `getMobilePanelSnapshot` debug helper needs updating**
The function snapshots `mobilePromptsRef` and `mobileSettingsRef` which won't exist after the
refactor. Update it to read `mobilePromptsOpen` / `mobilePromptsMode` / `mobileSettingsOpen`
from `useUiStore.getState()` instead, alongside the output + editor refs.

**4. Focus trap (keyboard UX)**
The overlay divs don't trap keyboard focus — Tab can still reach elements behind them. Acceptable
for v1 (the backdrop div blocks pointer interaction). A proper focus trap (`focus-trap-react` or
manual `onKeyDown` Tab intercept) can be added as a follow-up if needed.

---

## Files Changed Summary

| File                                                 | Change                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| `store/uiStore.ts`                                   | Add `mobilePromptsOpen`, `mobilePromptsMode`, `mobileSettingsOpen` + 5 actions  |
| `components/layout/Header.tsx`                       | Add `useIsMobile()`, 2 optional props, 2 conditional icon buttons in narrow row |
| `App.tsx`                                            | Rewrite `isMobile` render block                                                 |
| `hooks/useMobileLayout.ts`                           | Remove prompts/settings refs + 4-panel edge-case logic; keep output+editor refs |
| `components/layout/PromptsPanel.tsx`                 | Add `onRequestSidebar` + `onRequestClose` optional props + header buttons       |
| `components/layout/WorkflowPropertiesPanel.tsx`      | Add `onRequestClose` optional prop + close button                               |
| **NEW** `components/layout/MobilePromptsSidebar.tsx` | Compact 72 px sidebar chip list                                                 |
| **NEW or updated** `utils/tokenUtils.ts`             | Add `calcContextPct` helper; update 2 existing call sites                       |
