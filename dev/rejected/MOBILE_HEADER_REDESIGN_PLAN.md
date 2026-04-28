# Mobile Header Redesign

## Problem

The current mobile header has two rows and ~10 interactive elements, which looks cluttered:

- **Row 1 left:** `[New+▼]` `[Save]` `[Undo|Redo▼]` `[⚙ GlobalSettings]`
- **Row 1 right:** `[▶]` `[⏸]` `[⏹]`
- **Row 2 (mobile-only, full-width):** `[≡ Steps]` `[WorkflowStatus▼]` `[⚙ Workflow Props]`

The second row exists solely to accommodate the workflow status picker and the panel toggles.
The goal is a single-row header + a standard bottom navigation bar that reserves the header
for workflow identity and execution controls only.

**Desktop invariant:** desktop layout and behavior must not change. All layout movement in
this plan is mobile-only. Desktop keeps the existing header grid, standalone Save button,
global settings button, and execution controls.

---

## Proposed Layout

### Top header (single row)

Mobile only:

```
[ +▼ ] [ ↩▼ ] ──────── [ WorkflowStatus▼ ] ──────── [ ctx₁ ] [ ctx₂ ]
```

Where `ctx₁` / `ctx₂` are context-sensitive execution controls (see §Execution Controls).

### Bottom navigation bar (new)

```
[ ≡  Steps ]     [ ⚙  Settings ]     [ ⊟  Workflow ]
```

Ordering mirrors slide-in direction: Steps slides in from the **left**, Settings slides up
from the **bottom**, Workflow Properties slides in from the **right**.

---

## Changes

### 1. New `MobileBottomNav` component

**File:** `src/ui/webview-react/components/layout/MobileBottomNav.tsx`

A bottom bar rendered only on mobile (`isMobile` from `useIsMobile`). It is a normal
flex sibling inside the same root `div` as the header and main content area in `App.tsx`.
It is **not** `position: fixed`; keeping it in the flex column lets the main content resize
predictably.

The existing `.safe-area-spacer` remains the single source of truth for the iOS home
indicator clearance. Do **not** add `pb-safe` or inline
`paddingBottom: env(safe-area-inset-bottom)` to the nav, or the bottom gap will be doubled.

**Buttons:**

| Position | Icon     | Codicon                  | Action                   | Active state         |
| -------- | -------- | ------------------------ | ------------------------ | -------------------- |
| Left     | Steps    | `codicon-list-unordered` | `onToggleMobilePrompts`  | `mobilePromptsOpen`  |
| Center   | Settings | `codicon-settings-gear`  | `onToggleGlobalSettings` | `globalSettingsOpen` |
| Right    | Workflow | `codicon-settings`       | `onToggleMobileSettings` | `mobileSettingsOpen` |

`codicon-settings` is used for Workflow Properties because it resembles property toggles
(VS Code's convention); `codicon-settings-gear` is reserved for Global Settings.

Each button shows its icon + a small text label below (`text-[10px]`), matching standard
mobile tab-bar conventions:

```tsx
<button
  className={`flex flex-col items-center justify-center flex-1 py-2 gap-0.5 text-xs
  ${active ? "text-btn-fg" : "text-description-fg hover:text-foreground"}`}
>
  <i className={`codicon ${icon} text-base`} />
  <span className="text-[10px] leading-none">{label}</span>
</button>
```

The bar has a top border (`border-t border-panel-border`) and `bg-sidebar-bg` to match the
header background.

**Props:**

```typescript
interface MobileBottomNavProps {
  onToggleMobilePrompts: () => void;
  onToggleGlobalSettings: () => void;
  onToggleMobileSettings: () => void;
}
```

Reads `mobilePromptsOpen`, `mobileSettingsOpen`, and `globalSettingsOpen` from `useUiStore`
internally. Toggle actions are passed in from `App.tsx` so `App.tsx` remains the owner of
mobile panel exclusivity and close-animation state.

**Placement in `App.tsx` (mobile branch):**

```tsx
<div className="h-dvh w-full flex flex-col bg-editor-bg text-foreground border-l border-r relative">
  <Header />                     {/* single-row, no panel toggle buttons */}
  <div className="flex-1 relative overflow-hidden flex flex-col">
    {/* ... center panels + overlays ... */}
  </div>
  <StartupOverlay />
  {terminalKeyboardInset > 0 && <div style={{ height: terminalKeyboardInset }} />}
  {!keyboardVisible && (
    <MobileBottomNav            {/* NEW — sits above safe-area spacer */}
      onToggleMobilePrompts={handleToggleMobilePrompts}
      onToggleGlobalSettings={handleToggleGlobalSettings}
      onToggleMobileSettings={handleToggleMobileSettings}
    />
  )}
  <div className="safe-area-spacer" aria-hidden="true" />
</div>
```

The bottom nav must stay below the terminal-keyboard-inset spacer so it doesn't get pushed
up by the virtual keyboard when a terminal is focused. The existing keyboard inset logic
only fires for xterm — the nav itself has no inputs, so this ordering is correct.

**Mobile panel exclusivity and bounds:**

- `Steps`, `Settings`, and `Workflow` are mutually exclusive mobile destinations. Opening
  one closes the other two; tapping the currently-open destination closes it.
- Implement the three bottom-nav handlers in `App.tsx` (`handleToggleMobilePrompts`,
  `handleToggleGlobalSettings`, `handleToggleMobileSettings`) so exclusivity is centralized.
  Reuse the existing local close-animation paths for the panel being closed by its own
  toggle; do not change the animation definitions.
- `Steps` keeps its existing special behavior:
  - sidebar mode is scoped to the output panel and pushes output content right;
  - full-width mode is still absolute inside the output panel only;
  - neither mode covers the prompt editor.
- `Workflow` properties remains scoped to the main content area and must not cover the
  top header, bottom nav, or safe-area spacer.
- `Settings` (`GlobalSettingsDrawer`) remains scoped to the main content area and must not
  cover the top header, bottom nav, or safe-area spacer.
- `StartupOverlay` behavior is unchanged.

---

### 2. Slim the `Header` to a single row on mobile

Remove the mobile-only second row entirely. The `header-center` div currently uses
`order-last col-span-2` on mobile to force a second row — remove that pattern.

**Mobile header grid:** use a single-row grid such as `grid-cols-[auto_minmax(0,1fr)_auto]`
below `sm`:

```
[ Left: +▼  ↩▼ ]   [ Center: WorkflowStatus flex-1 ]   [ Right: ctx₁ ctx₂ ]
```

Keep the existing desktop grid (`sm:grid-cols-[1fr_auto_1fr]`) and desktop centering
behavior unchanged.

Remove from `Header.tsx` (mobile path only):

- The `[≡ Steps]` toggle button (moves to `MobileBottomNav`)
- The `[⚙ Workflow Props]` toggle button (moves to `MobileBottomNav`)
- The `[⚙ GlobalSettings]` button from `header-left` on mobile (moves to `MobileBottomNav`)
- The standalone `[Save]` button on mobile only (moves to the `WorkflowControls` dropdown)

Keep the `[Save]` and `[⚙ GlobalSettings]` buttons in `header-left` on **desktop** with
no visual or behavioral changes.

`Header` no longer receives `onToggleMobilePrompts` / `onToggleMobileSettings` props — these
route through `MobileBottomNav` instead. Remove those props from the `Header` interface and
all call sites in `App.tsx`.

---

### 3. Context-sensitive execution controls

Instead of always rendering `[▶][⏸][⏹]` (3 buttons), show only what is actionable:

| State                 | Buttons shown              |
| --------------------- | -------------------------- |
| no file               | `[▶ disabled]`             |
| `idle` with file      | `[▶ run]`                  |
| `running`             | `[⏸]` `[⏹]`                |
| `paused` / `stopped`  | `[↺ restart]` `[▶ resume]` |
| `completed` / `error` | `[↺ restart]`              |
| `cancelling`          | `[⏹ dim]`                  |
| CLI-managed           | `[⏹ stop-cli]`             |

This saves one button-width on the right side of the header, giving `WorkflowStatus` more
room to render the workflow name without truncating aggressively.

The logic is already partially expressed via `canRun`, `canPause`, `canResume`, `canStop`,
`isRerun` — this change just conditionally renders rather than rendering all three with
disabled states. Add explicit `isError` handling so errored workflows can be restarted.
If the current implementation cannot rerun from `error`, treat that as a bug and fix it
as part of this change.

This context-sensitive rendering is mobile-only for this pass. Desktop keeps the existing
three execution buttons to preserve layout and behavior.

---

### 4. Save is mobile-only in `WorkflowControls` dropdown

Desktop keeps the standalone Save button in `Header.tsx`. On mobile, remove that standalone
Save button and add Save to the `WorkflowControls` dropdown.

To avoid duplicating save logic, keep `canSave` / `handleSave` in `Header.tsx` and pass them
to `WorkflowControls`:

```typescript
interface WorkflowControlsProps {
  className?: string;
  includeSaveOption?: boolean;
  canSave?: boolean;
  onSave?: () => void;
}
```

Use `<WorkflowControls includeSaveOption={isMobile} canSave={canSave} onSave={handleSave} />`.
Render the existing standalone Save button only when `!isMobile`.

Add a visual divider and Save entry to the `dropdownOptions` array in `WorkflowControls.tsx`
only when `includeSaveOption` is true:

```tsx
const dropdownOptions: SplitButtonOption[] = [
  {
    label: "New From Template...",
    value: "from-template",
    icon: <i className="custom-icon icon-from-template" />,
    onClick: handleFromTemplate,
  },
  {
    label: "Load from File...",
    value: "load-file",
    icon: <i className="custom-icon icon-load-from-file" />,
    onClick: handleLoadFile,
  },
  {
    label: "Queue from File...",
    value: "queue-file",
    icon: <i className="custom-icon icon-queue-from-file" />,
    onClick: handleQueueFile,
    disabled: !hasQueue,
  },
  ...(includeSaveOption
    ? [
        { divider: true },
        {
          label: "Save",
          value: "save",
          icon: <i className="codicon codicon-save" />,
          onClick: onSave ?? (() => {}),
          disabled: !canSave || !onSave,
        },
      ]
    : []),
];
```

`SplitButton` already supports `divider?: boolean`. Use the existing field rather than
adding a second `separator` spelling. Tighten `SplitButtonOption` into a discriminated
union so divider rows do not require `label`, `value`, or `onClick` fields.

`SaveWorkflowDialog` can remain mounted from `Header.tsx`; there is still one owner for the
save request flow.

---

### 5. Keyboard visibility — hide bottom nav when virtual keyboard is open

On iOS Safari, `h-dvh` is fixed to the layout viewport and does **not** shrink when the
virtual keyboard opens. The keyboard overlaps the bottom of the layout. Two distinct cases
require handling:

**Terminal keyboard** (`terminalKeyboardInset > 0`):
The existing inset spacer grows by the keyboard height, compressing `flex-1` to keep the
xterm canvas visible above the keyboard. With the bottom nav in the flex column, it steals
an additional ~56 px from the already-scarce visible area. On an iPhone mini (~390 px
keyboard), this is significant.

**PromptEditor keyboard** (CodeMirror handles its own scrolling, `terminalKeyboardInset = 0`):
The inset spacer is absent. The bottom nav sits physically under the keyboard (no visual
intrusion) but permanently reduces `flex-1` by ~56 px even when the keyboard is closed,
giving CodeMirror less room to work with.

**Solution: generalize viewport tracking to produce `keyboardVisible`**

In `App.tsx`, extend the existing `visualViewport` effect to also set a `keyboardVisible`
boolean (any keyboard, not just terminal):

```tsx
const [keyboardVisible, setKeyboardVisible] = useState(false);
const [terminalKeyboardInset, setTerminalKeyboardInset] = useState(0);

useEffect(() => {
  const vv = window.visualViewport;
  if (!vv) return;

  const handleViewportChange = () => {
    const inset = Math.max(0, window.innerHeight - vv.offsetTop - vv.height);
    // Any keyboard — used to hide the bottom nav
    setKeyboardVisible(inset > 50); // 50 px threshold avoids iOS rubber-band noise

    // Terminal-specific inset — only when xterm textarea has focus
    const isTerminalFocused =
      (document.activeElement as Element | null)?.classList.contains(
        "xterm-helper-textarea"
      ) ?? false;
    setTerminalKeyboardInset(isTerminalFocused ? inset : 0);
  };

  vv.addEventListener("resize", handleViewportChange);
  vv.addEventListener("scroll", handleViewportChange);
  return () => {
    vv.removeEventListener("resize", handleViewportChange);
    vv.removeEventListener("scroll", handleViewportChange);
  };
}, []);
```

Then conditionally render the bottom nav:

```tsx
{
  !keyboardVisible && (
    <MobileBottomNav
      onToggleMobilePrompts={handleToggleMobilePrompts}
      onToggleGlobalSettings={handleToggleGlobalSettings}
      onToggleMobileSettings={handleToggleMobileSettings}
    />
  );
}
```

**Result per case:**

| Case                  | Bottom nav | `flex-1` available                                  | Terminal inset spacer |
| --------------------- | ---------- | --------------------------------------------------- | --------------------- |
| No keyboard           | visible    | dvh − header − nav − safe-area                      | 0                     |
| PromptEditor keyboard | hidden     | dvh − header − safe-area (+56 px recovered)         | 0                     |
| Terminal keyboard     | hidden     | dvh − header − safe-area − inset (+56 px recovered) | keyboard height       |

When the keyboard is open the user is actively typing — they have no need for the nav —
so hiding it is zero-cost UX and maximum-benefit layout.

---

### 6. Undo/Redo: keep existing UndoRedoControl split button

The existing `UndoRedoControl` already has a dropdown for history. No changes needed —
it already collapses Undo + History into a split button. The Redo button currently sits
alongside it. On mobile, consider hiding the standalone Redo button and moving Redo as
the first entry in the UndoRedoControl dropdown (below a separator before history entries).
This saves one more button-width in the header left section.

This is a separate, optional improvement; it can be deferred.

---

## Files Changed

| File                                       | Change                                                                                                                                                                                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/layout/MobileBottomNav.tsx`    | **New** — bottom nav component                                                                                                                                                                                             |
| `components/layout/Header.tsx`             | Mobile only: remove panel toggles, standalone save button, and global-settings button; pass save props to `WorkflowControls`; context-sensitive mobile exec controls; collapse mobile header to one row. Desktop unchanged |
| `components/workflow/WorkflowControls.tsx` | Add optional mobile Save dropdown entry using existing save props and `divider` support                                                                                                                                    |
| `components/shared/SplitButton.tsx`        | Tighten `SplitButtonOption` into a discriminated union for divider rows                                                                                                                                                    |
| `App.tsx`                                  | Render `MobileBottomNav` (hidden when `keyboardVisible`); generalize `visualViewport` effect to produce `keyboardVisible`; remove panel-toggle props from `<Header>`                                                       |
| `components/layout/index.ts`               | Export `MobileBottomNav`                                                                                                                                                                                                   |

---

## Acceptance Criteria

- Desktop header layout, Save button, Global Settings button, and execution button behavior
  are unchanged.
- Mobile header is one row.
- Mobile bottom nav is visible only when the virtual keyboard is not open.
- Mobile bottom nav sits above `.safe-area-spacer` and does not add its own safe-area padding.
- Mobile `Steps`, `Settings`, and `Workflow` panels are mutually exclusive.
- Mobile `Steps` still never covers the prompt editor.
- Mobile `Settings` and `Workflow` overlays cover only the main content area, not the top
  header, bottom nav, or safe-area spacer.
- Workflows can be restarted from `error`.
- Save remains standalone on desktop and is available from the workflow dropdown on mobile.
- `npm run test:ui` and `npm run compile` pass.

---

## Non-Goals / Out of Scope

- Desktop layout is unchanged
- No changes to panel slide animations beyond the exclusivity and bounds rules above
- `UndoRedoControl` Redo-into-dropdown improvement is deferred
- No changes to the `WorkflowStatus` component itself
- No changes to GlobalSettingsDrawer or WorkflowStepsPanel / WorkflowPropertiesPanel internals
