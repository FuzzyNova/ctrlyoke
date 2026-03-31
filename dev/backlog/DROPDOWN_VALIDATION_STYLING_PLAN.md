# Dropdown Validation & Error Styling Plan

## Problem

When a workflow YAML is loaded with values that no longer match the current environment — a model not valid for the selected harness, a skill name that doesn't exist, an agent path that isn't found — the relevant dropdowns silently show the raw invalid value. There is no visual feedback to help users spot stale or incorrect workflow configurations.

The new `PriorContextSelect` introduced a local `customError` state + red-border pattern for its range-input validation. This plan describes how to generalise that approach into a shared utility that can be applied consistently across all dropdowns in `SettingsDrawer.tsx` and `PropertiesDrawer.tsx` with minimal duplication.

---

## Affected Dropdowns

| Dropdown | Location | Validation scenario |
|---|---|---|
| Model | Both drawers | Loaded model ID not in `getModelsForHarness(harness)` list |
| Agent | Both drawers | Loaded agent path not found in `availableAgents` |
| Skills | Both drawers | One or more loaded skills not found in `availableSkills` |
| Prior Context (range input) | Both drawers | Invalid range notation while in custom mode *(already implemented)* |
| Harness | Both drawers | Not a known harness ID *(edge case; `HarnessDropdown` always has all options)* |

---

## Design

### 1. Shared Validation Utility — `utils/dropdownValidation.ts` (new file)

A single file containing pure functions that check whether a property value is consistent with available options. These functions have no React dependencies and can be unit-tested in isolation.

```typescript
// Returns a warning message if invalid, null if valid.
export function modelWarning(
  model: string | undefined,
  harness: HarnessId,
  modelOptions: Record<HarnessId, ModelOption[]>
): string | null

export function agentWarning(
  agent: string | null | undefined,   // null = explicitly "None" — always valid
  availableAgents: AgentOption[]
): string | null

export function skillsWarning(
  skills: string[] | null | undefined, // null = explicitly "None" — always valid
  availableSkills: SkillOption[]
): string | null
```

Rules:
- `undefined` (inherit) is always valid — not the user's explicit choice yet.
- `null` (explicitly none) is always valid.
- Empty string for model/agent = inherit, so valid.
- An explicit string or array that contains at least one entry not in the available list → return a human-readable warning string.

For skills the return value can mention how many are unrecognised: `"1 skill not found: 'foo'"`.

---

### 2. Shared Styling Helper — `utils/dropdownValidation.ts` (same file)

```typescript
/**
 * Returns the CSS border class to apply to a dropdown trigger button.
 * Pass null/undefined for no warning state (normal border).
 */
export function dropdownBorderClass(warning: string | null | undefined): string {
  return warning
    ? "border-input-error-border"
    : "border-dropdown-border";
}
```

This is intentionally tiny — it exists to make the intent clear in call sites and to ensure both drawers use the same token (avoiding one using `border-input-error-border` and the other `border-warning-fg` by accident).

---

### 3. CustomSelect — add optional `warning` prop

`CustomSelect` is used for model, agent, additional-args mode, resume-session, and tool-permissions mode. Adding a single optional `warning?: string` prop is the minimal change needed:

```typescript
interface CustomSelectProps extends HideableProps {
  // ... existing props ...
  warning?: string;  // If set, apply warning border to trigger button
}
```

Internal changes:
- The trigger `<button>` replaces its current fixed `border-dropdown-border` with `dropdownBorderClass(warning)`.
- A `<span>` with `text-[10px] text-error-fg` is rendered below the button when `warning` is set (same pattern as `PriorContextSelect`'s error message).

No other changes to CustomSelect are needed.

---

### 4. SkillsSelect / MultiCheckboxDropdown — add optional `warning` prop

`SkillsSelect` wraps `MultiCheckboxDropdown`, which renders its own trigger button. The same `warning?: string` prop travels through `SkillsSelect` → `MultiCheckboxDropdown` → trigger button.

The warning message for skills is slightly different because the invalid skill name(s) should be identified clearly: `"1 skill not found: 'my-skill'"`. SkillsSelect can format this from the raw `skillsWarning()` result.

---

### 5. HarnessDropdown — no change needed (yet)

`HarnessDropdown` always includes every harness in the list, so a loaded YAML value will always be a selectable option. The only visual issue would be a harness showing as "unavailable" (already handled by the existing status badge). No warning prop needed.

---

### 6. PriorContextSelect — already done

The range-input validation is already implemented as a local state inside `PriorContextSelect`. The `dropdownBorderClass()` helper should be imported and used here to keep the border token consistent, but no structural change is needed.

---

## Where Warnings Are Computed

Warning strings are computed locally in each drawer component rather than in the store. This keeps the stores free of UI-display logic.

### SettingsDrawer.tsx

```typescript
// Near existing "effective value" derivations:
const modelWarn = modelWarning(
  workflowProperties.model,  // explicit override only; undefined = no warning
  effectiveHarness,
  modelOptions
);
const agentWarn = agentWarning(workflowProperties.agent, availableAgents);
const skillsWarn = skillsWarning(workflowProperties.skills, availableSkills);
```

Only the *explicit* workflow-level override is validated, not the *effective* resolved value. If the workflow overrides the model and the override is bad, that's a warning. If the model comes entirely from global settings, the warning shows on the global settings UI (VS Code settings, not this panel).

### PropertiesDrawer.tsx

```typescript
const modelWarn = modelWarning(properties.model, resolvedHarness, modelOptions);
const agentWarn = agentWarning(properties.agent, availableAgents);
const skillsWarn = skillsWarning(properties.skills, availableSkills);
```

Same logic: only the prompt-level override is validated. If the property is `undefined` (inheriting from workflow), no warning is shown — the workflow-level drawer already warns about that value.

---

## Severity: Warning, Not Error

All these cases are **warnings** (orange/yellow border and message text), not hard errors. The value came from the user's YAML file; it might be intentional (e.g., a model that will be valid once a harness is installed, or a skill registered by a script that hasn't run yet). The user should be informed but not blocked.

The distinction in the CSS:
- Hard **error** (red) — `border-input-error-border` / `text-error-fg` — used by `PriorContextSelect` for range parse failures (unambiguously wrong syntax).
- **Warning** (yellow/orange) — `border-warning-fg` / `text-warning-fg` — used for "value not found in current environment."

The Tailwind token table in `tailwind.config.js` already includes:
- `warning-fg` → `--vscode-editorWarning-foreground`

A `border-warning-fg` utility should be added to the config if not already present, following the same pattern as `border-input-error-border`.

---

## Implementation Steps

1. **Add `border-warning-fg`** to `tailwind.config.js` (the border variant of the existing `warning-fg` token).

2. **Create `src/ui/webview-react/utils/dropdownValidation.ts`** with:
   - `modelWarning()`, `agentWarning()`, `skillsWarning()`
   - `dropdownBorderClass(warning)` — returns border class for warning or normal state
   - `dropdownWarningClass(warning)` — returns text-color class for warning message text

3. **Update `CustomSelect`**: add `warning?: string` prop, apply `dropdownBorderClass()` to trigger border, render message below.

4. **Update `MultiCheckboxDropdown` / `SkillsSelect`**: thread `warning?: string` through, apply same pattern.

5. **Update `PriorContextSelect`**: swap its hardcoded `border-input-error-border` to use `dropdownBorderClass()` from the new utility (retaining `text-error-fg` for the range-parse error since that's a hard syntax error, not a soft warning).

6. **Update `SettingsDrawer.tsx`**: compute `modelWarn`, `agentWarn`, `skillsWarn`; pass to respective components.

7. **Update `PropertiesDrawer.tsx`**: same.

---

## What Is and Is Not Shared

| Concern | Shared | Per-dropdown |
|---|---|---|
| Validation logic (is value valid?) | ✅ `dropdownValidation.ts` functions | — |
| Border class selection | ✅ `dropdownBorderClass()` helper | — |
| Warning text color class | ✅ `dropdownWarningClass()` helper | — |
| Warning message formatting | — | Per-dropdown (skills names vs single model name) |
| Trigger button border | — | Each component reads `dropdownBorderClass(warning)` |
| Warning message rendering | — | Each component renders `<span>` below trigger |

The rendering is intentionally not abstracted into a wrapper component. Each dropdown is structurally different enough (portal-based vs inline, button vs div trigger) that a shared wrapper would introduce more complexity than it saves. The shared utility functions and class helpers are sufficient to keep the visual output consistent without coupling the component implementations.

---

## Non-Goals

- Blocking save/run when warnings are present — warnings are purely informational.
- Validating global VS Code settings values — those are the user's responsibility in the settings UI.
- Validating values that are `undefined` (inherited) — those carry no explicit user choice at this level.
- Validating `sessionId` or `additionalArgs` free-text fields — content is too open-ended to validate statically.
