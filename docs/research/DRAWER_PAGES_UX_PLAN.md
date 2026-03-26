# Drawer Pages UX Plan

## Overview

Both `SettingsDrawer` (workflow-level sidebar panel) and `PropertiesDrawer` (per-prompt slide-up overlay) currently render all properties in a single scrollable list. As the feature set grows — especially with the upcoming tool permissions work — this creates a dense, hard-to-scan layout.

This plan introduces **paged navigation** inside both drawers, grouping related properties into logical tabs. The two drawers share the same four-page structure so users can develop a consistent mental model regardless of which drawer they're editing.

---

## Page Structure

### Page 1 — "Harness"
*What AI tool is used, which model, and how it's invoked.*

| Field | SettingsDrawer | PropertiesDrawer |
|---|---|---|
| Harness | workflow default | per-prompt override (shows `Default (X)`) |
| Model | workflow default | per-prompt override |
| Agent | workflow default | per-prompt override |
| Skills | workflow default | per-prompt override |
| Additional Args | workflow default | per-prompt override (mode select + inline text input) |

This is the "what runs" page — everything that configures the harness invocation itself.

**Icon:** `codicon-tools` or `codicon-terminal`

---

### Page 2 — "Context"
*How sessions and prior outputs flow between prompts.*

| Field | SettingsDrawer | PropertiesDrawer |
|---|---|---|
| Resume Session | workflow default | per-prompt override |
| Session ID | paired with Resume Session | paired with Resume Session |
| Prior Context | workflow default | per-prompt override |
| Allow Dynamic Extension | workflow default | per-prompt override |

"Context" captures the idea that these settings govern what information is carried forward: session state and prior output injection. Dynamic extension fits here because it's about what the AI can see/do across the workflow rather than how it's invoked.

**Icon:** `codicon-history` or `codicon-git-merge`

---

### Page 3 — "Validation"
*Script-based end condition and retry logic.*

| Field | SettingsDrawer | PropertiesDrawer |
|---|---|---|
| End Condition enable toggle | global workflow default | per-prompt override |
| Script | | |
| Expected Return | | |
| Timeout (ms) | | |
| Max Retries | | |
| Retry Prompt | | |
| Resume Session on Retry | | |

The enable/disable toggle moves from a standalone checkbox at the bottom of the scroll to a prominent control at the top of this dedicated page. When disabled, the fields below are dimmed (same `disabled:opacity-50` pattern as today).

In SettingsDrawer, `null` end condition means "use global default" for individual prompts; `undefined` means "not set". The toggle label reads "Global End Condition" (unchanged).

**Icon:** `codicon-beaker` or `codicon-verified`

---

### Page 4 — "Permissions" *(future — placeholder page)*
*Per-workflow/prompt tool permission overrides.*

Per `PERMISSIONS_PER_WORKFLOW_PLAN.md`, this page implements the three-tier resolution: prompt → workflow → global VS Code settings.

| Field | SettingsDrawer | PropertiesDrawer |
|---|---|---|
| Permission Mode | `custom` / `allowAll` / `dangerouslyAllowAll` | same options + `Default (X)` |
| Allowed Tools | newline-separated textarea (only when `mode = custom`) | same, only when `mode = custom` |
| Denied Tools | newline-separated textarea (only when `mode = custom`) | same, only when `mode = custom` |

The entire page is greyed out (`pointer-events-none opacity-60`) in CLI-managed (watch) mode, consistent with the rest of SettingsDrawer's read-only behavior.

**SettingsDrawer:** Each field has a `SetAsDefaultButton` following the `isDifferentFromGlobal` pattern. Since `toolPermissions` is an object, comparison uses JSON stringify (same approach as `skills` and `priorContext`).

**PropertiesDrawer:** Default labels show the resolved value: `Default (allowAll)`, `Default (custom: read, glob, grep)`, etc.

**Icon:** `codicon-lock` or `codicon-shield`

---

## Navigation Design

### Tab Bar (bottom of body, above the footer strip)

A persistent tab bar sits **below the scrollable content area** but **above the footer**. Four tabs, always visible regardless of which page is active.

```
┌─────────────────────────────────────────────────────┐
│  Prompt Properties                              [×]  │  ← header
├─────────────────────────────────────────────────────┤
│                                                     │
│  [page content — scrollable]                        │
│                                                     │
├─────────────────────────────────────────────────────┤
│  [⚙ Harness] [↺ Context] [✓ Validation] [🔒 Perms] │  ← tab bar
└─────────────────────────────────────────────────────┘
```

For SettingsDrawer, the existing footer (interactive/headless toggle, gitignore toggle, Settings... link) remains **below** the tab bar — it houses global toggles that apply regardless of which page is active.

```
┌─────────────────────────────────────────────────────┐
│ ▾ ⚙ Workflow Properties                             │  ← collapsible header
├─────────────────────────────────────────────────────┤
│                                                     │
│  [page content — scrollable]                        │
│                                                     │
├─────────────────────────────────────────────────────┤
│  [⚙ Harness] [↺ Context] [✓ Validation] [🔒 Perms] │  ← tab bar
├─────────────────────────────────────────────────────┤
│  [● Interactive] [◉ Gitignore] ... [Settings...]    │  ← global footer
└─────────────────────────────────────────────────────┘
```

### Tab Appearance

- Each tab: icon + short label, equal width
- Active tab: `text-foreground border-b-2 border-focus-border bg-transparent`
- Inactive tab: `text-description-fg hover:text-foreground`
- Permissions tab grayed out (but still visible/navigable) until the feature is implemented — shows a "Coming Soon" empty state on the page body
- Tab bar height: ~28px (matching existing header bars in the UI)

### State Persistence

- Active page stored in component state (not persisted across drawer open/close)
- PropertiesDrawer: resets to page 1 (`Harness`) each time the drawer opens for a new prompt
- SettingsDrawer: may persist last-used page in `uiStore` (TBD — low priority)

---

## Differences Between the Two Drawers

| Concern | SettingsDrawer | PropertiesDrawer |
|---|---|---|
| Scope | Workflow-level | Per-prompt override |
| Default labels | Not needed (values are the actual defaults) | Each field shows `Default (X)` indicating inherited value |
| Set as Default | `SetAsDefaultButton` per field | Not present |
| Execution Mode toggle | In footer | Not present |
| Gitignore toggle | In footer | Not present |
| Narrow layout | `Row narrow={isBodyNarrow}` 2-col → 1-col | Fixed 2-col grid today; same breakpoint logic can apply |
| Max dropdown height | Unconstrained | `DRAWER_DROPDOWN_MAX_HEIGHT = "150px"` (drawer has fixed height) |
| End condition label | "Global End Condition" | "Enable End Condition" |

---

## Implementation Notes

### Shared Tab Bar Component

Extract a `DrawerTabBar` component (e.g., `src/ui/webview-react/components/shared/DrawerTabBar.tsx`):

```tsx
interface DrawerTab {
  id: string;
  label: string;
  icon: string;       // codicon name
  disabled?: boolean; // for "coming soon" tabs
}

interface DrawerTabBarProps {
  tabs: DrawerTab[];
  activeTab: string;
  onTabChange: (id: string) => void;
}
```

Both drawers import this component. The tab definitions for the four pages can be a shared constant.

### Page IDs

Define as a const in a shared location (e.g., alongside `DROPDOWN_NAMESPACES` in `dropdownNamespaces.ts` or a new `drawerPages.ts`):

```typescript
export const DRAWER_PAGES = {
  HARNESS: "harness",
  CONTEXT: "context",
  VALIDATION: "validation",
  PERMISSIONS: "permissions",
} as const;
export type DrawerPage = (typeof DRAWER_PAGES)[keyof typeof DRAWER_PAGES];
```

### Conditional Rendering

Each drawer renders a `switch` (or equivalent) on `activePage` to show the correct content block. The page content can stay inline in the drawer file initially — no need to extract separate page components unless they get large.

### Scroll Position

Each page's content area should scroll independently. The simplest approach: a single `overflow-y-auto` div whose contents change with the page, which naturally resets scroll position on tab change.

---

## What Does NOT Change

- All existing field components, handlers, and state logic remain unchanged
- The three-tier precedence model (prompt → workflow → global) is unaffected
- The `isDifferentFromGlobal` / `SetAsDefaultButton` pattern in SettingsDrawer is preserved
- The `Default (X)` label resolution logic in PropertiesDrawer is preserved
- CLI-managed (watch mode) read-only overlay behavior is preserved
- `DRAWER_DROPDOWN_MAX_HEIGHT` constraint remains in PropertiesDrawer
- Footer quick toggles in SettingsDrawer remain in the footer (not moved to a page)
