# Dropdown Hide Feature Plan

## Overview

Add per-item hide/show functionality to select dropdowns in `SettingsDrawer.tsx` and
`PropertiesDrawer.tsx`, persisted to `localStorage` and **shared** between both panels.

---

## Affected Dropdowns (decided)

| Dropdown             | Namespace key          | Components                                                             |
| -------------------- | ---------------------- | ---------------------------------------------------------------------- |
| Harness              | `"harness"`            | `HarnessDropdown` (SettingsDrawer) + `CustomSelect` (PropertiesDrawer) |
| Model — Copilot CLI  | `"model:copilot-cli"`  | `CustomSelect` in both drawers                                         |
| Model — Copilot Chat | `"model:copilot-chat"` | `CustomSelect` in both drawers                                         |
| Model — Claude CLI   | `"model:claude-cli"`   | `CustomSelect` in both drawers                                         |
| Model — Codex CLI    | `"model:codex-cli"`    | `CustomSelect` in both drawers                                         |
| Agent                | `"agent"`              | `CustomSelect` in both drawers                                         |
| Skills               | `"skills"`             | `MultiCheckboxDropdown` in both drawers                                |

**Explicitly excluded** (short / static lists — no hide feature):

- Allow Dynamic Extension (Default / Yes / No)
- Resume Session (Default / Yes / No)

---

## Decisions

| #   | Question                    | Answer                                                                                                          |
| --- | --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1   | Scope                       | Only harness, model, agent, skills                                                                              |
| 2   | Model namespace             | Per-harness (`"model:copilot-cli"` etc.) — hiding a model in one harness has **zero effect** on other harnesses |
| 3   | Hide button position        | **Far right** on every row, including `HarnessDropdown` (status dot nudges slightly left to accommodate)        |
| 4   | Skills: hide a checked item | **Auto-uncheck** — no hidden-but-selected state allowed                                                         |
| 5   | Sync between drawers        | **Yes** — same namespace keys in `uiStore`, so SettingsDrawer + PropertiesDrawer always agree on what is hidden |

---

## State Storage

### Where

Add to **`uiStore`** (Zustand + `localStorage` persist middleware already in place).
Add `hiddenDropdownOptions` to `persistedFields`.

### Shape

```ts
// In UiState interface
hiddenDropdownOptions: Record<string, string[]>; // namespace → hidden value[]

// New actions
hideDropdownOption:         (namespace: string, value: string) => void;
unhideDropdownOption:       (namespace: string, value: string) => void;
clearHiddenDropdownOptions: (namespace: string) => void;
```

### Namespace Constants

Define in `src/ui/webview-react/types/dropdownNamespaces.ts` (single source of truth):

```ts
export const DROPDOWN_NAMESPACES = {
  HARNESS: "harness",
  MODEL_COPILOT_CLI: "model:copilot-cli",
  MODEL_COPILOT_CHAT: "model:copilot-chat",
  MODEL_CLAUDE_CLI: "model:claude-cli",
  MODEL_CODEX_CLI: "model:codex-cli",
  AGENT: "agent",
  SKILLS: "skills",
} as const;
```

The active model namespace is derived from the effective harness at render time:

```ts
const modelNamespace = `model:${effectiveHarness}` as const;
```

---

## Component Architecture

### Shared props interface (added to existing components)

```ts
interface HideableProps {
  /** Enables hide feature. When undefined the component renders exactly as before. */
  namespace?: string;
  /** Controlled — read from uiStore at the call site. */
  hiddenValues?: string[];
  /** Called when the user clicks the eye-closed (hide) button on a visible option. */
  onHideOption?: (value: string) => void;
  /** Called when the user clicks the eye (unhide) button on a hidden option. */
  onUnhideOption?: (value: string) => void;
  /**
   * Values that never get a hide button (sentinel / structural options).
   * Defaults to ["default", ""] if omitted.
   */
  nonHideableValues?: string[];
}
```

When `namespace` is **not** passed the components render exactly as before — zero regression.

### Files to change

| File                                                       | Change                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| `types/dropdownNamespaces.ts` _(new)_                      | Namespace constants                                                |
| `store/uiStore.ts`                                         | Add state + 3 actions + add to `persistedFields`                   |
| `components/shared/CustomSelect.tsx`                       | Add `HideableProps`; row hide button; hidden section; footer bar   |
| `components/shared/MultiCheckboxDropdown.tsx`              | Same; hide auto-unchecks checked values                            |
| `components/layout/SettingsDrawer.tsx` → `HarnessDropdown` | Add hide button far-right; wire to `uiStore`                       |
| `components/layout/SettingsDrawer.tsx` → `SettingsPanel`   | Wire model, agent, skills `CustomSelect` / `MultiCheckboxDropdown` |
| `components/editor/PropertiesDrawer.tsx`                   | Wire harness, model, agent, skills                                 |

---

## UX Behavior

### Normal visible row

```
[label text .........................] [eye-closed btn]
```

- `eye-closed` button sits at **far right**, appears **on row hover only**.
- The button is **not rendered at all** (not just invisible) on:
  - The currently-selected value (prevents stranding your selection)
  - Non-hideable sentinel values (`"default"`, `""`)
  - Options with `disabled: true` (e.g. "Loading models…")
- Clicking hide: immediately removes the item from the visible list; dropdown stays open.
- For `MultiCheckboxDropdown`: if the hidden value is currently checked, `onChange` is called
  with it removed **before** `onHideOption` fires — no hidden-checked state ever exists.

### Footer bar (bottom of open dropdown)

show hidden button is grayed out or disabled when there is nothing to hide. This serves two purposes, keeps the bottom black border of the dropdown with a button visible at all times so it doesn't just appear when they hide things (this gives better UX contrast to show where dropdown ends) and it reminds the users that it's possible to hide options

```
╔══════════════════════════════════╗
║   Show hidden (2)                ║  ← muted full-width button
╚══════════════════════════════════╝
```

Clicking toggles local `showHidden` state (component state, not persisted — resets each time the dropdown opens).

When `showHidden === true` the label becomes **"Hide hidden"**.

### Hidden items section (`showHidden === true`)

Appended below a thin separator after the normal list:

```
──────────────────────────────────
[eye]  hidden option A            ← opacity-50, text-description-fg, italic
[eye]  hidden option B
```

- `eye` (open) icon sits at **far left** of these rows (it is the primary action).
- Clicking the eye icon: calls `onUnhideOption(value)` → item moves back to the normal list.
- Clicking the row label/text: selects the option AND auto-unhides it (recovering from an
  accidentally hidden but needed value).
- For `MultiCheckboxDropdown`: clicking a hidden row's checkbox or label calls `onUnhideOption`
  **then** adds the value to `selectedValues`.

### HarnessDropdown row layout change

Before:

```
Copilot Chat       ● Available
Copilot CLI        ● checking
```

After

```
Copilot Chat       ● Available [eye-closed]
Copilot CLI        ● checking  [eye-closed]
```

---

## "Non-Hideable" Sentinel Values

Defaulted to `["default", ""]` if `nonHideableValues` is not explicitly passed.
Call sites may extend this list. The hide button is simply not rendered for these values.

---

## Implementation Steps

### Step 1 — Namespace constants file

Create `src/ui/webview-react/types/dropdownNamespaces.ts` with `DROPDOWN_NAMESPACES`.

### Step 2 — uiStore additions

In `store/uiStore.ts`:

- Add `hiddenDropdownOptions: Record<string, string[]>` to `UiState` with default `{}`.
- Add `hideDropdownOption`, `unhideDropdownOption`, `clearHiddenDropdownOptions` actions.
- Add `"hiddenDropdownOptions"` to `persistedFields`.

### Step 3 — CustomSelect

Add `HideableProps` to `CustomSelectProps`.

- Each option row: add far-right `eye-closed` icon button (hover-only; excluded on selected / non-hideable).
- Filter hidden values out of the normal rendered list.
- Footer bar toggle (`showHidden` local state).
- Hidden section with `eye` (open) icon + unhide/select-and-unhide behavior.

### Step 4 — MultiCheckboxDropdown

Same as Step 3 plus:

- On hide of a checked value: call `onChange(selectedValues.filter(v => v !== value))` before `onHideOption`.
- Hidden row interaction: unhide + check simultaneously.

### Step 5 — HarnessDropdown (inside SettingsDrawer)

Add `HideableProps`. Each harness row gets a far-right `eye-closed` button (hover-only, excluded on selected harness). Footer bar same pattern.

### Step 6 — SettingsDrawer wiring

```tsx
const { hiddenDropdownOptions, hideDropdownOption, unhideDropdownOption } = useUiStore();
const modelNamespace = `model:${effectiveHarness}`;

<HarnessDropdown
  namespace={DROPDOWN_NAMESPACES.HARNESS}
  hiddenValues={hiddenDropdownOptions[DROPDOWN_NAMESPACES.HARNESS] ?? []}
  onHideOption={(v) => hideDropdownOption(DROPDOWN_NAMESPACES.HARNESS, v)}
  onUnhideOption={(v) => unhideDropdownOption(DROPDOWN_NAMESPACES.HARNESS, v)}
  ...
/>

<CustomSelect  // model
  namespace={modelNamespace}
  hiddenValues={hiddenDropdownOptions[modelNamespace] ?? []}
  onHideOption={(v) => hideDropdownOption(modelNamespace, v)}
  onUnhideOption={(v) => unhideDropdownOption(modelNamespace, v)}
  nonHideableValues={["default", ""]}
  ...
/>

// Agent and Skills — same pattern with DROPDOWN_NAMESPACES.AGENT / .SKILLS
```

### Step 7 — PropertiesDrawer wiring

Identical namespace keys → hide state automatically synced with SettingsDrawer via shared `uiStore`.

```tsx
const { hiddenDropdownOptions, hideDropdownOption, unhideDropdownOption } = useUiStore();
const modelNamespace = `model:${currentHarness}`; // already computed in PropertiesDrawer

<CustomSelect  // harness — same namespace as SettingsDrawer's HarnessDropdown
  namespace={DROPDOWN_NAMESPACES.HARNESS}
  hiddenValues={hiddenDropdownOptions[DROPDOWN_NAMESPACES.HARNESS] ?? []}
  onHideOption={(v) => hideDropdownOption(DROPDOWN_NAMESPACES.HARNESS, v)}
  onUnhideOption={(v) => unhideDropdownOption(DROPDOWN_NAMESPACES.HARNESS, v)}
  nonHideableValues={["default", ""]}
  ...
/>
// Model, Agent, Skills — same pattern
```

---

## No Remaining Open Questions

All decisions resolved. Ready to implement. 3. **Hide button always visible vs hover-only?**  
 Always-visible hide buttons add visual clutter (especially on the harness dropdown with only 4 items). Hover-only is cleaner but less discoverable. **Recommendation:** Hover-only, but always show if `hiddenValues.length > 0` for the namespace (so users know the feature exists).

4. **Eye icon placement in `CustomSelect` rows?**  
   Far right

5. **Behavior when the selected value is hidden mid-session?**  
   prevent hiding current value

6. **MultiCheckboxDropdown hide semantics?**  
   hiding a checked skill should uncheck it

7. **Skills namespace — sync between drawers?**  
   yes, sync all hiding state between property drawer and settings drawer (including skills that are hidden)
