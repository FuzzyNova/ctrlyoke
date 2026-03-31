# More Footer Quick Pickers Plan

Add **PermissionsQuickPicker** and **ContextQuickPicker** to the `EditorFooter`, giving users fast access to permission mode and context settings without opening `PropertiesDrawer`.

---

## Background

The footer already hosts four quick pickers (Harness, Model, Agent, Skills) via the `FooterQuickPicker` shell + a portal popup. Each one:

- Reads from `useEditorStore().properties` and resolves through `workflowProperties` / `globalSettings`
- Uses `useUiStore().footerOpenPicker` to ensure only one popup is open at a time
- Shows a **grayed resolved value** when on Default; a **colored override value** when overriding the workflow
- Is a self-contained component registered in `EditorFooter` and exported from `editor/index.ts`

---

## Picker 1: PermissionsQuickPicker

### Design

Straightforward — same pattern as `AgentQuickPicker`.

**Trigger icon:** `codicon-shield` (or `codicon-lock`); colored (`text-focus-border`) when overriding, `opacity-40` when default.

**`isOverride`:** `properties.toolPermissions !== undefined`

**`valueLabel`** (shown in wide mode next to icon):

| State | Label |
|---|---|
| Default | Resolved permission mode name (grayed) |
| Override = null (NONE) | "None" (colored) |
| Override with mode set | Mode label, e.g. "Allow All" (colored) |

**Popup:** A single `CustomSelect` with options:
```
Default (resolved-label)    ← buildPermissionsDefaultLabel(workflowProperties.toolPermissions)
Dangerously Allow All
Allow All
Custom
None
```
- Uses the existing `PERMISSION_MODE_OPTIONS` array from `shared/permissionUtils`
- `onChange` mirrors the PropertiesDrawer logic: `"default"` → `setProperty("toolPermissions", undefined)`, otherwise spreads current override and sets `mode`
- Close picker after selection (`setFooterOpenPicker(null)`)

**Note:** The popup shows all modes even when the harness doesn't support them (e.g., Custom list for Copilot Chat). Quick pick is mode-only; full tool lists stay in the Permissions page of PropertiesDrawer. Optionally show a short note ("Allowed/Denied tool lists available in Properties") when the harness doesn't support mode-only.

**`popupMinWidth`:** `"220px"`

---

## Picker 2: ContextQuickPicker

### Architecture Decision: Combined (not separate)

Keep Resume Session and Prior Context in **one** "Context" picker for these reasons:
- The footer is already 6 items wide (Properties + 4 pickers + this adds 2 more); one combined picker saves space
- The PropertiesDrawer already groups them together on the "Context" tab — the mental model carries over
- The footer indicator can cleanly summarize both with a short composite label

### Design

**Trigger icon:** `codicon-history`; colored when any context property is overriding, `opacity-40` when both are default.

**`isOverride`:** `properties.resumeSession !== undefined || properties.priorContext !== undefined`

**`valueLabel`** (in wide mode, `max-w-[80px] truncate`):

Build from two components, combining as needed:

*Resume part:*
- Source: `properties.resumeSession` if overriding, otherwise resolved `workflowProperties.resumeSession ?? globalSettings.resumeSession`
- Active (override or resolved = true): `"resume"` (or `"final"` if sessionId = FINAL_PROMPT sentinel)
- Not resuming: `""` (omit — no useful information to show)

*Prior context part:*
- Source: `properties.priorContext` if overriding, otherwise resolved `workflowProperties.priorContext ?? globalSettings.priorContext`
- Active (override or resolved ≠ undefined/none): `"+ctx"`
- Inactive: `""` (omit)

*Combined label:*
- Both active: `"resume +ctx"`
- Resume only: `"resume"` (or `"final"`)
- Prior context only: `"+ctx"`
- Neither: `"none"` (grayed out in default state)

**Popup layout** (using inline flex-col, no drawer chrome):

```
┌──────────────────────────────────┐
│  RESUME SESSION                  │  ← section label (10px uppercase)
│  [CustomSelect: Default/Yes/No/  │
│   Final Prompt Session]          │
│  [Session ID input]              │  ← same show/hide logic as PropertiesDrawer
│                                  │
│  ─────────────────────────────── │  ← <hr> divider
│                                  │
│  PRIOR CONTEXT                   │  ← section label
│  [PriorContextSelect inline]     │
└──────────────────────────────────┘
```

The popup should **not** close automatically after selection (user may want to change both settings).  Include a small "×" close button in the top-right corner, or rely on click-outside behavior (already handled by `FooterQuickPicker`).

**Session ID input rules** (identical to PropertiesDrawer):
- Visible always; grayed out (`opacity-50 pointer-events-none`) when not applicable
- Active when `properties.resumeSession === true && properties.sessionId !== SESSION_ID_SENTINELS.FINAL_PROMPT`
- Placeholder: `"Session ID (e.g. 1)"` 

**`popupMinWidth`:** `"260px"`

---

## Implementation Steps

### 1. Extend `footerOpenPicker` type in `uiStore.ts`

**File:** `src/ui/webview-react/store/uiStore.ts`

Change the union type in both the state interface and the `setFooterOpenPicker` action signature:

```ts
// Before:
footerOpenPicker: "harness" | "model" | "agent" | "skills" | null;

// After:
footerOpenPicker: "harness" | "model" | "agent" | "skills" | "permissions" | "context" | null;
```

Two locations to update: the `UiState` interface (line ~199) and the `UiActions` `setFooterOpenPicker` signature (line ~326).

### 2. Create `PermissionsQuickPicker.tsx`

**File:** `src/ui/webview-react/components/editor/PermissionsQuickPicker.tsx`

Imports needed:
- `useEditorStore`, `useSettingsStore`, `useUiStore`
- `FooterQuickPicker`
- `CustomSelect` from `../shared`
- `PERMISSION_MODE_OPTIONS`, `buildPermissionsDefaultLabel` from `../shared`
- `PERMISSION_MODES` from `../../../../types/DashboardConstants`
- `ToolPermissionsOverride`, `ToolPermissionMode` from `../../types/messages`

Key logic (mirrors PropertiesDrawer Permissions page onChange):
```ts
const isOverride = properties.toolPermissions !== undefined;

const resolvedModeLabel = (() => {
  const wf = workflowProperties.toolPermissions;
  if (wf === undefined || wf === null) return "None";
  return PERMISSION_MODE_OPTIONS.find(o => o.value === wf.mode)?.label ?? wf.mode ?? "None";
})();

const valueLabel = !isOverride
  ? resolvedModeLabel
  : properties.toolPermissions === null
    ? "None"
    : PERMISSION_MODE_OPTIONS.find(o => o.value === (properties.toolPermissions as ToolPermissionsOverride).mode)?.label
      ?? "Allow All";
```

### 3. Create `ContextQuickPicker.tsx`

**File:** `src/ui/webview-react/components/editor/ContextQuickPicker.tsx`

Imports needed:
- `useEditorStore`, `useSettingsStore`, `useUiStore`
- `FooterQuickPicker`
- `CustomSelect`, `PriorContextSelect`, `PRIOR_CONTEXT_KEYWORD_LABELS` from `../shared`
- `SESSION_ID_SENTINELS`, `PriorContext` from `../../types/messages`
- `getResumeSessionOptions` from `../../types/dropdownNamespaces`

Popup internals use `useState` for the session ID field editing.

Resume Session `onChange` handler is identical to the PropertiesDrawer version — copy it.

`valueLabel` builder:
```ts
// Determine effective resume state
const effectiveResume = properties.resumeSession !== undefined
  ? properties.resumeSession
  : (workflowProperties.resumeSession ?? globalSettings.resumeSession);
const effectiveIsFinal = (properties.resumeSession !== undefined
  ? properties.sessionId
  : workflowProperties.sessionId) === SESSION_ID_SENTINELS.FINAL_PROMPT;

// Determine effective prior context
const effectivePriorContext = properties.priorContext !== undefined
  ? properties.priorContext
  : (workflowProperties.priorContext ?? globalSettings.priorContext);
const hasPriorContext = effectivePriorContext !== undefined && effectivePriorContext !== "none";

const resumePart = effectiveResume
  ? (effectiveIsFinal ? "final" : "resume")
  : "";
const ctxPart = hasPriorContext ? "+ctx" : "";
const valueLabel = [resumePart, ctxPart].filter(Boolean).join(" ") || "none";
```

### 4. Update `EditorFooter.tsx`

Add the two new pickers after `SkillsQuickPicker`:

```tsx
<PermissionsQuickPicker isNarrow={isNarrow} showLabel={!isNarrow} disabled={isCLIManaged} />
<ContextQuickPicker     isNarrow={isNarrow} showLabel={!isNarrow} disabled={isCLIManaged} />
```

### 5. Export from `editor/index.ts`

```ts
export { PermissionsQuickPicker } from "./PermissionsQuickPicker";
export { ContextQuickPicker } from "./ContextQuickPicker";
```

---

## Open Questions / Notes

- **Footer density:** Adding two more pickers brings the left bar to 7 items (Properties button + 6 pickers). The footer uses `isNarrow` (threshold 768px) to collapse labels; at very narrow widths it becomes icon-only so this should be fine. If it feels crowded, consider raising the narrow threshold slightly.
- **Permissions "Custom" mode:** The quick picker only sets the *mode* to Custom — it does not expose the allowed/denied tool lists. Those remain in PropertiesDrawer Permissions tab. This is intentional and consistent with the principle that quick pickers handle the most common quick actions.
- **ContextQuickPicker popup closing:** Since users may want to tweak both Resume and Prior Context in one session, the popup does **not** auto-close after each interaction. Click-outside (already in `FooterQuickPicker`) closes it.
- **Prior Context inline mode:** `PriorContextSelect` already has an `inline` prop for embedding in popups — use `inline={true}` with `dropdownMaxHeight="250px"`.
