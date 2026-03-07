# Dropdown Hide Feature

> **Status: Fully Implemented** — All 7 planned steps are complete as of the current codebase.

## Overview

Per-item hide/show functionality for select dropdowns in `SettingsDrawer.tsx` and
`PropertiesDrawer.tsx`, persisted to `localStorage` and **shared** between both panels.

---

## Affected Dropdowns

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

## Implementation

### Files Implemented

| File                                          | What was added                                                         |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `types/dropdownNamespaces.ts`                 | `DROPDOWN_NAMESPACES` constants + `modelNamespaceForHarness()`         |
| `store/uiStore.ts`                            | `hiddenDropdownOptions` state + 3 actions + added to `persistedFields` |
| `components/shared/CustomSelect.tsx`          | `HideableProps`; row hide button; hidden section; footer bar           |
| `components/shared/MultiCheckboxDropdown.tsx` | Same; hide auto-unchecks checked values                                |
| `components/layout/SettingsDrawer.tsx`        | Harness, model, agent, skills all wired to `uiStore`                   |
| `components/editor/PropertiesDrawer.tsx`      | Same wiring — shares namespace keys for cross-drawer sync              |

### State Shape (`uiStore`)

```ts
// UiState
hiddenDropdownOptions: Record<string, string[]>; // namespace → hidden value[]

// Actions
hideDropdownOption:         (namespace: string, value: string) => void;
unhideDropdownOption:       (namespace: string, value: string) => void;
clearHiddenDropdownOptions: (namespace: string) => void;
```

`hiddenDropdownOptions` is included in `persistedFields` → survives page reloads via `localStorage`.

### Namespace Constants (`types/dropdownNamespaces.ts`)

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

// Derive the active model namespace at render time:
const modelNamespace = modelNamespaceForHarness(effectiveHarness);
```

### Shared Props Interface (`HideableProps`)

Defined in `CustomSelect.tsx`, imported by `MultiCheckboxDropdown.tsx`:

```ts
interface HideableProps {
  /** Enables hide feature. When undefined the component renders exactly as before. */
  namespace?: string;
  /** Controlled — read from uiStore at the call site. */
  hiddenValues?: string[];
  onHideOption?: (value: string) => void;
  onUnhideOption?: (value: string) => void;
  /**
   * Values that never get a hide button (sentinel / structural options).
   * Defaults to ["default", ""] if omitted.
   */
  nonHideableValues?: string[];
}
```

When `namespace` is **not** passed the components render exactly as before — zero regression.

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

The "Show hidden" button is always visible but grayed out when nothing is hidden. This keeps a bottom border visible at all times (better UX contrast) and reminds users the feature exists.

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

### HarnessDropdown row layout

```
Copilot Chat       ● Available [eye-closed]
Copilot CLI        ● checking  [eye-closed]
```

---

## "Non-Hideable" Sentinel Values

Defaulted to `["default", ""]` if `nonHideableValues` is not explicitly passed.
Call sites may extend this list. The hide button is simply not rendered for these values.
