# Drawer Pages UX Plan

## Overview

Both `SettingsDrawer` (workflow-level sidebar panel) and `PropertiesDrawer` (per-prompt slide-up overlay) currently render all properties in a single scrollable list. As the feature set grows — especially with the upcoming tool permissions work — this creates a dense, hard-to-scan layout.

This plan introduces **paged navigation** inside both drawers, grouping related properties into logical tabs. The two drawers share the same six-page structure so users can develop a consistent mental model regardless of which drawer they're editing.

---

## Page Structure

### Page 1 — "Harness"

_What AI tool is used, which model, and how it's invoked._

| Field           | SettingsDrawer   | PropertiesDrawer                                      |
| --------------- | ---------------- | ----------------------------------------------------- |
| Harness         | workflow default | per-prompt override (shows `Default (X)`)             |
| Model           | workflow default | per-prompt override                                   |
| Agent           | workflow default | per-prompt override                                   |
| Skills          | workflow default | per-prompt override                                   |
| Additional Args | workflow default | per-prompt override (mode select + inline text input) |

This is the "what runs" page — everything that configures the harness invocation itself.

**Icon:** `HarnessIcon` component (harness-specific SVG, e.g. Claude logo, Copilot logo). When no harness is selected or using the workflow default, show the currently active harness icon. See `src/ui/webview-react/components/shared/HarnessIcon.tsx`.

---

### Page 2 — "Context"

_How sessions and prior outputs flow between prompts._

| Field          | SettingsDrawer             | PropertiesDrawer           |
| -------------- | -------------------------- | -------------------------- |
| Resume Session | workflow default           | per-prompt override        |
| Session ID     | paired with Resume Session | paired with Resume Session |
| Prior Context  | workflow default           | per-prompt override        |

"Context" captures the idea that these settings govern what information is carried forward: session state and prior output injection.

> **Note:** `allowDynamicExtension` was previously grouped here. It is replaced by `mcpServers` and moved to the dedicated **MCP** page (Page 4).

**Icon:** `codicon-book`

---

### Page 3 — "Validation"

_Script-based end condition and retry logic._

| Field                       | SettingsDrawer          | PropertiesDrawer    |
| --------------------------- | ----------------------- | ------------------- |
| End Condition enable toggle | global workflow default | per-prompt override |
| Script                      |                         |                     |
| Expected Return             |                         |                     |
| Timeout (ms)                |                         |                     |
| Max Retries                 |                         |                     |
| Retry Prompt                |                         |                     |
| Resume Session on Retry     |                         |                     |

The enable/disable toggle moves from a standalone checkbox at the bottom of the scroll to a prominent control at the top of this dedicated page. When disabled, the fields below are dimmed (same `disabled:opacity-50` pattern as today).

In SettingsDrawer, `null` end condition means "use global default" for individual prompts; `undefined` means "not set". The toggle label reads "Global End Condition" (unchanged).

**Icon:** `codicon-coverage`

---

### Page 4 — "MCP"

_MCP server injection per prompt/workflow. Replaces `allowDynamicExtension`._

Per `MCP_SERVERS_PROPERTY_PLAN.md`, `allowDynamicExtension: boolean` is replaced by `mcpServers: (string | McpServerConfig)[] | null`. The "flightpath" string shorthand is the direct equivalent of the old `allowDynamicExtension: true`.

| Field      | SettingsDrawer                                               | PropertiesDrawer                                  |
| ---------- | ------------------------------------------------------------ | ------------------------------------------------- |
| mcpServers | array editor — `"flightpath"` toggle + user-defined MCP list | same, with `Default (X)` when inheriting workflow |

**UI pattern:**

- A **"FlightPath Queue Tools"** toggle at the top (enabled = `"flightpath"` is in the array). This replaces the old `Allow Dynamic Extension` toggle with a clearer label.
- Below the toggle, a list of user-defined `McpServerConfig` entries (id, command, args, env, autoApprove). An "Add MCP Server" button appends a new entry. Each entry has a remove button and an expand/collapse control for the args/env fields.
- The page is greyed out in CLI-managed (watch) mode, consistent with other pages.

**SettingsDrawer:** `SetAsDefaultButton` for the entire `mcpServers` array (JSON stringify comparison, same approach as `skills` and `priorContext`).

**PropertiesDrawer:** Default label shows the resolved summary: `Default (flightpath)`, `Default (none)`, `Default (flightpath + 2 servers)`, etc.

**Ordering note:** The smart default behavior — `["flightpath"]` applied on the last prompt only when `enableDynamicQueue` setting is `true` — is enforced in `WorkflowExecutor`, not in the UI. The MCP page shows the explicit per-prompt/workflow value, which may be `undefined` (use smart default).

**Icon:** `codicon-mcp`

---

### Page 5 — "Hooks" _(future — placeholder page)_

_User-defined scripts wired to CLI hook events._

Per `HOOKS_EXPOSURE_PLAN.md`, this page lets users attach their own commands to logical hook events (`stop`, `sessionStart`, `preToolUse`, `postToolUse`). FlightPath's own completion-detection hooks are always registered automatically and are not shown here — this page is exclusively for user additions.

| Field     | SettingsDrawer                                               | PropertiesDrawer                                                  |
| --------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| Hook list | workflow-level default hooks (array of `{ event, command }`) | per-prompt additions (merged with, not replacing, workflow-level) |

**UI pattern:** A simple list where each entry shows the event name (as a dropdown or badge) and the command string. An "Add Hook" button appends a new entry. Each entry has a remove button.

The page is greyed out in CLI-managed (watch) mode, consistent with other pages.

**SettingsDrawer:** `SetAsDefaultButton` per entry (or for the entire list — TBD based on how `hooks` array diff works). Since the `hooks` property is an array, comparison uses JSON stringify analogous to `skills`.

**PropertiesDrawer:** Prompt-level hooks are **additive** — they append to workflow-level hooks rather than replacing them. The page should make this clear (e.g., "These hooks run in addition to workflow-level hooks."). No `Default (X)` label needed since it's an additive list.

**Icon:** `codicon-symbol-event`

---

### Page 6 — "Permissions" _(future — placeholder page)_

_Per-workflow/prompt tool permission overrides._

Per `PERMISSIONS_PER_WORKFLOW_PLAN.md`, this page implements the three-tier resolution: prompt → workflow → global VS Code settings.

| Field           | SettingsDrawer                                         | PropertiesDrawer                |
| --------------- | ------------------------------------------------------ | ------------------------------- |
| Permission Mode | `custom` / `allowAll` / `dangerouslyAllowAll`          | same options + `Default (X)`    |
| Allowed Tools   | newline-separated textarea (only when `mode = custom`) | same, only when `mode = custom` |
| Denied Tools    | newline-separated textarea (only when `mode = custom`) | same, only when `mode = custom` |

The entire page is greyed out (`pointer-events-none opacity-60`) in CLI-managed (watch) mode, consistent with the rest of SettingsDrawer's read-only behavior.

**SettingsDrawer:** Each field has a `SetAsDefaultButton` following the `isDifferentFromGlobal` pattern. Since `toolPermissions` is an object, comparison uses JSON stringify (same approach as `skills` and `priorContext`).

**PropertiesDrawer:** Default labels show the resolved value: `Default (allowAll)`, `Default (custom: read, glob, grep)`, etc.

**Icon:** `codicon-workspace-trusted`

---

## Navigation Design

### Tab Bar (bottom of body, above the footer strip)

A persistent tab bar sits **below the scrollable content area** but **above the footer**. Six tabs, always visible regardless of which page is active.

```
┌──────────────────────────────────────────────────────────────────────┐
│  Prompt Properties                                               [×]  │  ← header
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  [page content — scrollable]                                         │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│  [🪄 Harness] [📖 Context] [✓ Validation] [MCP] [⚡ Hooks] [🔒 Perms] │  ← tab bar (codicons)
└──────────────────────────────────────────────────────────────────────┘
```

> **Icon rendering:** All tab icons use VS Code codicons (`<span class="codicon codicon-book" />`), **except** the Harness tab which renders the `HarnessIcon` component (the active harness's SVG logo) at 14px. This gives users an immediate visual cue about which harness is selected while keeping all other tabs uniform with codicons.

For SettingsDrawer, the existing footer (interactive/headless toggle, gitignore toggle, Settings... link) remains **below** the tab bar — it houses global toggles that apply regardless of which page is active.

```
┌──────────────────────────────────────────────────────────────────────┐
│ ▾ ⚙ Workflow Properties                                              │  ← collapsible header
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  [page content — scrollable]                                         │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│  [🪄 Harness] [📖 Context] [✓ Validation] [MCP] [⚡ Hooks] [🔒 Perms] │  ← tab bar (codicons)
├──────────────────────────────────────────────────────────────────────┤
│  [● Interactive] [◉ Gitignore] ... [Settings...]                     │  ← global footer
└──────────────────────────────────────────────────────────────────────┘
```

### Tab Icons Reference

| Page        | Icon                                 | Notes                                                        |
| ----------- | ------------------------------------ | ------------------------------------------------------------ |
| Harness     | `HarnessIcon` (harness-specific SVG) | 14px, uses active harness ID from the current drawer context |
| Context     | `codicon-book`                       |                                                              |
| Validation  | `codicon-coverage`                   |                                                              |
| MCP         | `codicon-mcp`                        |                                                              |
| Hooks       | `codicon-symbol-event`               | Future/placeholder                                           |
| Permissions | `codicon-workspace-trusted`          | Future/placeholder                                           |

### Tab Appearance

- Each tab: icon + short label, equal width
- Active tab: `text-foreground border-b-2 border-focus-border bg-transparent`
- Inactive tab: `text-description-fg hover:text-foreground`
- Hooks and Permissions tabs grayed out (but still visible/navigable) until their features are implemented — each shows a "Coming Soon" empty state on the page body
- Tab bar height: ~28px (matching existing header bars in the UI)
- **No emojis** — all icons are codicons or the `HarnessIcon` SVG component

### State Persistence

- Active page stored in component state (not persisted across drawer open/close)
- PropertiesDrawer: resets to page 1 (`Harness`) each time the drawer opens for a new prompt
- SettingsDrawer: may persist last-used page in `uiStore` (TBD — low priority)

---

## Differences Between the Two Drawers

| Concern               | SettingsDrawer                              | PropertiesDrawer                                                                 |
| --------------------- | ------------------------------------------- | -------------------------------------------------------------------------------- |
| Scope                 | Workflow-level                              | Per-prompt override                                                              |
| Default labels        | Not needed (values are the actual defaults) | Each field shows `Default (X)` indicating inherited value                        |
| Set as Default        | `SetAsDefaultButton` per field              | Not present                                                                      |
| Execution Mode toggle | In footer                                   | Not present                                                                      |
| Gitignore toggle      | In footer                                   | Not present                                                                      |
| Narrow layout         | `Row narrow={isBodyNarrow}` 2-col → 1-col   | Fixed 2-col grid today; same breakpoint logic can apply                          |
| Max dropdown height   | Unconstrained                               | `DRAWER_DROPDOWN_MAX_HEIGHT = "150px"` (drawer has fixed height)                 |
| End condition label   | "Global End Condition"                      | "Enable End Condition"                                                           |
| Harness tab icon      | Shows the workflow-level harness            | Shows the resolved harness for this prompt (prompt override or workflow default) |

---

## Implementation Notes

### Shared Tab Bar Component

Extract a `DrawerTabBar` component (e.g., `src/ui/webview-react/components/shared/DrawerTabBar.tsx`):

```tsx
interface DrawerTab {
  id: DrawerPage;
  label: string;
  /** codicon name (e.g. "book", "coverage", "mcp"). Omit for the Harness tab. */
  codicon?: string;
  disabled?: boolean; // for "coming soon" tabs
}

interface DrawerTabBarProps {
  tabs: DrawerTab[];
  activeTab: DrawerPage;
  onTabChange: (id: DrawerPage) => void;
  /** Active harness ID — used to render the HarnessIcon on the Harness tab */
  harnessId: HarnessId;
}
```

The Harness tab is a special case: instead of a codicon, it renders `<HarnessIcon harnessId={harnessId} size={14} />`. All other tabs use `<span className={`codicon codicon-${tab.codicon}`} />`.

Both drawers import this component. The tab definitions for the six pages can be a shared constant.

### Page IDs

Define as a const in a shared location (e.g., alongside `DROPDOWN_NAMESPACES` in `dropdownNamespaces.ts` or a new `drawerPages.ts`):

```typescript
export const DRAWER_PAGES = {
  HARNESS: "harness",
  CONTEXT: "context",
  VALIDATION: "validation",
  MCP: "mcp",
  HOOKS: "hooks",
  PERMISSIONS: "permissions",
} as const;
export type DrawerPage = (typeof DRAWER_PAGES)[keyof typeof DRAWER_PAGES];
```

### MCP Page and `mcpServers` Property

The MCP page replaces the `Allow Dynamic Extension` checkbox. The underlying data model change is described in `MCP_SERVERS_PROPERTY_PLAN.md`:

- `allowDynamicExtension: boolean` → `mcpServers: (string | McpServerConfig)[] | null`
- `"flightpath"` in the array = old `allowDynamicExtension: true`
- The MCP page UI must handle three states: `undefined` (smart default — show as inherited), `null`/`[]` (disabled), or an explicit array (show entries)

The React component for the MCP page will need to import `McpServerConfig` from the shared types once that type is added per `MCP_SERVERS_PROPERTY_PLAN.md` section 2.

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
