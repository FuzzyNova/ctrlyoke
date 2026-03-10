# Footer Quick Pickers — Implementation Plan

## Goal

Add four quick-access inline pickers to `EditorFooter` for **Harness**, **Model**, **Agent**, and **Skills** — each opening a small upward-popping panel directly above its trigger button. The full `PropertiesDrawer` remains unchanged (it still shows all properties). These pickers give one-click access to the four most commonly changed per-prompt overrides without opening the drawer.

## Final Layout

```
Wide:
[⚙ Properties ⌃] [Claude Code ⌃] [sonnet ⌃]   1,234 tokens   [Sr. Eng ⌃] [handoff, pickup ⌃] [Queue] [Run ▷]

Narrow (icon-only):
[⚙] [◈] [🤖]   1,234 tokens   [👤] [🔧] [+] [▷]
```

### Three width tiers (via two `useElementNarrow` thresholds)

| Tier | Footer width | Picker button content |
|------|-------------|----------------------|
| Wide | ≥ 560 px | `[icon] [selected-value-text] [chevron]` |
| Medium | 380–560 px | `[icon] [chevron]` (no value text, no label) |
| Narrow | < 380 px | `[icon]` only (existing narrow behaviour) |

The selected-value text is the most expensive to show, so it hides at 560px.
All other text (static labels like "Queue") already hides at the existing 380px threshold.

---

## Architecture

### New files

| File | Purpose |
|------|---------|
| `components/editor/FooterQuickPicker.tsx` | Generic reusable button + upward popup shell |
| `components/editor/HarnessQuickPicker.tsx` | Harness-specific picker using `HarnessDropdown` internals |
| `components/editor/ModelQuickPicker.tsx` | Model-specific picker using `CustomSelect` internals |
| `components/editor/AgentQuickPicker.tsx` | Agent-specific picker using `CustomSelect` internals |
| `components/editor/SkillsQuickPicker.tsx` | Skills-specific picker (thin wrapper around existing `SkillsSelect`) |

### Modified files

| File | Change |
|------|--------|
| `EditorFooter.tsx` | Add four pickers between Properties button and token count (left side) and between token count and Queue button (right side); add second narrow threshold |
| `uiStore.ts` | Add `footerOpenPicker: "harness" \| "model" \| "agent" \| "skills" \| null` + `setFooterOpenPicker()` action |

No changes to `PropertiesDrawer.tsx`, `SettingsDrawer.tsx`, or any stores beyond `uiStore`.

---

## Component Design

### `FooterQuickPicker` (generic shell)

```tsx
interface FooterQuickPickerProps {
  /** Icon-only mode (narrow) */
  isNarrow: boolean;
  /** Show value label (wide) */
  showLabel: boolean;
  /** Codicon class name for the button icon, e.g. "codicon-server" */
  icon: string;
  /** Text shown next to icon in wide mode — the current resolved value */
  valueLabel: string;
  /** Whether the value is an override (not default) — used for active styling */
  isOverride: boolean;
  /** Whether this picker's popup is currently open */
  isOpen: boolean;
  /** Toggle open/close */
  onToggle: () => void;
  /** Close this picker */
  onClose: () => void;
  /** Popup content */
  children: React.ReactNode;
  /** Accessible label for the trigger button */
  title: string;
  /** Optional min-width for the popup panel (default: 200px) */
  popupMinWidth?: string;
}
```

Responsibilities:
- Renders the trigger button with correct styling (active state when `isOverride`)
- Renders an upward-opening popup panel (`position: absolute; bottom: 100%; left: 0`)
- Handles click-outside close via `mousedown` listener (same pattern as `SkillsSelect`)
- `z-[200]` on popup to clear editor content and the PropertiesDrawer toggle

### Individual pickers

Each picker is a thin wrapper around `FooterQuickPicker` that:
1. Reads the current value and resolved effective value from `editorStore` + `settingsStore`
2. Derives `valueLabel` (what to show in wide mode) and `isOverride` (whether to highlight)
3. Renders the appropriate selection UI as `children`
4. Calls `setProperty(...)` on change

#### Harness

- **Icon**: `codicon-server` (or `codicon-circuit-board`)
- **Value label** (wide): `HARNESS_DISPLAY_NAMES[properties.harness]` or `"Default"`
- **Override indicator**: `properties.harness !== undefined`
- **Popup content**: Reuse `HarnessDropdown` (same props as in `PropertiesDrawer`)
- **Popup width**: 220px min

#### Model

- **Icon**: `codicon-hubot`
- **Value label** (wide): the model's display label or `"Default"`
- **Override indicator**: `properties.model !== undefined`
- **Popup content**: Reuse `CustomSelect` with same model options as `PropertiesDrawer`
- **Popup width**: 220px min

#### Agent

- **Icon**: `codicon-person`
- **Value label** (wide): agent `name` property or `"Default"` or `"None"`
- **Override indicator**: `properties.agent !== undefined`
- **Popup content**: Reuse `CustomSelect` with same agent options as `PropertiesDrawer`
- **Popup width**: 220px min

#### Skills

- **Icon**: `codicon-tools`
- **Value label** (wide):
  - `undefined` → `"Default"`
  - `null` → `"None"`
  - `[]` → `"None selected"`
  - 1–2 skills → `"handoff, pickup"`
  - 3+ skills → `"handoff +2"`
- **Override indicator**: `properties.skills !== undefined`
- **Popup content**: Reuse `SkillsSelect` (extract from `PropertiesDrawer` to shared location — see below)
- **Popup width**: 240px min

---

## `SkillsSelect` Extraction

`SkillsSelect` is currently a private component inside `PropertiesDrawer.tsx`. It needs to be moved to a shared location so both `PropertiesDrawer` and `SkillsQuickPicker` can use it.

**Move to**: `components/shared/SkillsSelect.tsx`
**Export from**: `components/shared/index.ts`
**Update**: `PropertiesDrawer.tsx` to import from `../shared`

This is the only refactor needed to support reuse.

---

## `uiStore` Changes

```typescript
// Add to UiState interface:
footerOpenPicker: "harness" | "model" | "agent" | "skills" | null;

// Add action:
setFooterOpenPicker: (picker: "harness" | "model" | "agent" | "skills" | null) => void;
```

Each picker calls `setFooterOpenPicker("harness")` etc. on toggle, and `setFooterOpenPicker(null)` on close or outside click. Opening one picker automatically closes others because they all read `footerOpenPicker` for their `isOpen` prop.

This does **not** need localStorage persistence (it's transient interaction state).

---

## `EditorFooter` Layout Changes

### New props needed

None — the footer reads from `useEditorStore` and `useSettingsStore` directly for the picker data (consistent with the existing `useEditorStore()` call for `promptText`).

### Width thresholds

```typescript
const [footerRef, isNarrow] = useElementNarrow(380);    // existing: hide all text labels
const [, isWide] = useElementNarrow(560);               // new: hide value text in pickers
// Note: isWide is actually "is NOT wide" (true = below threshold)
const showPickerValues = !isWide;                       // show value text only when wide enough
```

### New layout structure

```tsx
{/* Left side */}
<div className="editor-footer-left flex items-center gap-1">
  {/* existing Properties button */}
  <HarnessQuickPicker isNarrow={isNarrow} showLabel={showPickerValues} />
  <ModelQuickPicker  isNarrow={isNarrow} showLabel={showPickerValues} />
</div>

{/* Center: Token count (unchanged) */}

{/* Right side */}
<div className="editor-actions flex items-center gap-1">
  <AgentQuickPicker  isNarrow={isNarrow} showLabel={showPickerValues} />
  <SkillsQuickPicker isNarrow={isNarrow} showLabel={showPickerValues} />
  {/* Queue / Run / Update / Delete / Cancel buttons (unchanged) */}
</div>
```

---

## Styling Conventions

Follow existing footer button pattern:

```tsx
// Default (no override):
"px-2 py-1 text-xs rounded flex items-center gap-1 transition-colors hover:bg-list-hover-bg text-foreground"

// Override active (value is set at prompt level, same as Properties button when open):
"px-2 py-1 text-xs rounded flex items-center gap-1 transition-colors bg-btn-secondary-bg text-btn-secondary-fg"

// Popup panel:
"absolute bottom-full left-0 mb-1 bg-dropdown-bg border border-dropdown-border rounded shadow-lg z-[200]"
```

A colored dot or subtle badge on the button icon could also indicate an active override in narrow mode — but keep it simple for first pass (just icon, no badge).

---

## Effective Value Labels

For display in wide mode, each picker should compute the **effective resolved value** (not just the raw property), following the three-tier property resolution: `prompt > workflow > global settings`.

```typescript
// Example for harness:
const effectiveHarness = properties.harness          // prompt level
  ?? workflowProperties.harness                       // workflow level
  ?? globalSettings.harness;                          // global settings

const harnessLabel = properties.harness
  ? HARNESS_DISPLAY_NAMES[properties.harness as HarnessId] ?? properties.harness
  : "Default";  // show "Default" when not overridden at prompt level
```

The label shows the **override value** (or "Default"), not the resolved fallback. This is intentional — the user needs to know what's set at the prompt level, not what the final computed value is. The tooltip on hover can show the resolved effective value for clarity.

---

## Implementation Order

1. **Move `SkillsSelect`** to `components/shared/SkillsSelect.tsx` and update imports
2. **Add `footerOpenPicker` to `uiStore`**
3. **Create `FooterQuickPicker`** (generic shell)
4. **Create four picker components** (Harness, Model, Agent, Skills)
5. **Update `EditorFooter`** to add pickers, second threshold, and new layout
6. **Manual testing** across wide/medium/narrow widths and with various property override states

---

## Edge Cases

| Case | Behaviour |
|------|-----------|
| No agents available | Agent picker still shows "Default" and "None" options only |
| No skills available | Skills picker shows "Default" and "None" options, skills section hidden |
| `isCLIManaged = true` | All four pickers disabled (grayed out, no click), same as action buttons |
| Properties drawer open | Pickers remain functional; both can be open simultaneously |
| Properties drawer closes a picker | No special interaction needed — they're independent |
| Model list not yet loaded | Model picker shows "Loading models…" disabled option (mirrors PropertiesDrawer behaviour) |
| Value text overflows | `max-w-[80px] truncate` on the value label span in wide mode |

---

## What This Does NOT Change

- `PropertiesDrawer.tsx` — no functional changes (only loses `SkillsSelect` to shared/)
- `PromptEditor.tsx` — no prop changes needed (footer reads from stores directly)
- `settingsStore`, `editorStore` — no changes
- The three-tier property resolution logic — pickers call the same `setProperty()` action
