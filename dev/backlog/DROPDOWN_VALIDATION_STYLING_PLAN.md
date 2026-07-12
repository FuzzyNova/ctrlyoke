# Dropdown Validation & Error Styling Plan

## Problem

When a workflow YAML is loaded with values that no longer match the current environment — a model not valid for the selected harness, a skill name that doesn't exist, or an agent filename slug that is no longer discovered — the relevant dropdown must preserve the raw value while making the stale configuration visible.

The new `PriorContextSelect` introduced a local `customError` state + red-border pattern for its range-input validation. This plan describes the shared utility used consistently by `WorkflowPropertiesPanel.tsx`, `PropertiesDrawer.tsx`, and the dashboard's workflow defaults page.

## Implementation Status

Completed:

- Shared pure validation functions and warning/error style helpers live in `src/ui/webview-react/utils/dropdownValidation.ts` with focused unit coverage; agent and skill references use their canonical discovered names.
- `CustomSelect`, `MultiCheckboxDropdown`, and `SkillsSelect` accept `warning?: string` and render the shared yellow warning border and message.
- Workflow-level and prompt-level model, agent, and skills overrides are validated locally; inherited values are intentionally not warned.
- The dashboard default agent picker persists the canonical agent filename slug. Stale values remain visible and receive a warning; they are not blocked.
- `PriorContextSelect` now uses the shared border helper while retaining its red syntax-error treatment.
- `border-warning-fg` is already generated from the existing `warning-fg` Tailwind color token; no separate Tailwind configuration entry was needed.

Deferred:

- Parallel-group `sessionId` conflict warnings remain deferred until the parallel-steps feature supplies workflow-level group context.

---

## Affected Dropdowns

| Dropdown                    | Location                             | Validation scenario                                                               |
| --------------------------- | ------------------------------------ | --------------------------------------------------------------------------------- |
| Model                       | Workflow + prompt drawers            | Explicit model ID not in `getModelsForHarness(harness)` after discovery completes |
| Agent                       | Workflow + prompt drawers + defaults | Explicit agent filename slug not found in `availableAgents`                       |
| Skills                      | Workflow + prompt drawers + defaults | One or more explicit skills not found in `availableSkills`                        |
| Prior Context (range input) | Both drawers                         | Invalid range notation while in custom mode _(already implemented)_               |
| Harness                     | Both drawers                         | Not a known harness ID _(edge case; `HarnessDropdown` always has all options)_    |
| Session ID (parallel group) | PropertiesDrawer                     | Two or more steps in the same parallel group share the same `sessionId` value     |

> **Note on `sessionId` conflict detection:** This is a parallel-group-specific validation — it
> requires cross-step context (knowing which other steps share the same group) that is not
> available within a single step's `PropertiesDrawer` instance. The warning must therefore be
> computed at the workflow level (e.g., in `workflowStore.ts` or the parent panel that renders
> the group) and passed down to each `PropertiesDrawer` as a `sessionIdWarning?: string` prop.
> This is deferred to the parallel steps implementation — it is not part of the initial
> dropdown validation utility work.

---

## Design

### 1. Shared Validation Utility — `utils/dropdownValidation.ts` (new file)

A single file containing pure functions that check whether a property value is consistent with available options. These functions have no React dependencies and can be unit-tested in isolation.

```typescript
// Returns a warning message if invalid, null if valid.
export function modelWarning(
  model: string | null | undefined,
  harness: HarnessId,
  modelOptions: ModelOption[]
): string | null;

export function agentWarning(
  agent: string | null | undefined, // null = explicitly "None" — always valid
  availableAgents: AgentOption[]
): string | null;

export function skillsWarning(
  skills: string[] | null | undefined, // null = explicitly "None" — always valid
  availableSkills: SkillOption[]
): string | null;
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
export function dropdownBorderClass(
  validation: string | boolean | null | undefined,
  severity?: "warning" | "error"
): string {
  // warning → yellow dropdown border; error → red input border
}
```

This remains intentionally small while allowing `PriorContextSelect` to preserve its red syntax-error border and environment checks to use yellow warning borders.

---

### 3. CustomSelect — add optional `warning` prop

`CustomSelect` is used for model, agent, additional-args mode, resume-session, and tool-permissions mode. Adding a single optional `warning?: string` prop is the minimal change needed:

```typescript
interface CustomSelectProps extends HideableProps {
  // ... existing props ...
  warning?: string; // If set, apply warning border to trigger button
}
```

Internal changes:

- The trigger `<button>` replaces its current fixed `border-dropdown-border` with `dropdownBorderClass(warning)`.
- A `<span>` with `text-xxs text-warning-fg` is rendered below the button when `warning` is set.

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

### WorkflowPropertiesPanel.tsx

```typescript
// Near existing "effective value" derivations:
const modelWarn = modelWarning(
  workflowProperties.model, // explicit override only; undefined = no warning
  effectiveHarness,
  modelOptions
);
const agentWarn = agentWarning(workflowProperties.agent, availableAgents);
const skillsWarn = skillsWarning(workflowProperties.skills, availableSkills);
```

Only the _explicit_ workflow-level override is validated, not the _effective_ resolved value. If the workflow overrides the model and the override is bad, that's a warning. Dashboard workflow defaults are validated separately in `DefaultsHarnessPage.tsx`.

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

Tailwind generates `border-warning-fg` from the existing `warning-fg` color token.

---

## Implementation Steps

1. **Complete** — `border-warning-fg` is generated by the existing `warning-fg` Tailwind color token.

2. **Complete** — add `src/ui/webview-react/utils/dropdownValidation.ts` with pure model, agent, and skills warnings plus shared warning/error border and message helpers.

3. **Complete** — update `CustomSelect`: add `warning?: string`, apply the shared warning border, and render the message below the trigger.

4. **Complete** — update `MultiCheckboxDropdown` and `SkillsSelect` with the same warning prop and visual treatment.

5. **Complete** — update `PriorContextSelect` to use the shared border helper with its hard-error severity, retaining `text-error-fg`.

6. **Complete** — update `WorkflowPropertiesPanel.tsx` and `DefaultsHarnessPage.tsx` to compute and pass the applicable explicit-value warnings.

7. **Complete** — update `PropertiesDrawer.tsx` with the same explicit-value warnings.

---

## What Is and Is Not Shared

| Concern                            | Shared                               | Per-dropdown                                        |
| ---------------------------------- | ------------------------------------ | --------------------------------------------------- |
| Validation logic (is value valid?) | ✅ `dropdownValidation.ts` functions | —                                                   |
| Border class selection             | ✅ `dropdownBorderClass()` helper    | —                                                   |
| Warning text color class           | ✅ `dropdownWarningClass()` helper   | —                                                   |
| Warning message formatting         | —                                    | Per-dropdown (skills names vs single model name)    |
| Trigger button border              | —                                    | Each component reads `dropdownBorderClass(warning)` |
| Warning message rendering          | —                                    | Each component renders `<span>` below trigger       |

The rendering is intentionally not abstracted into a wrapper component. Each dropdown is structurally different enough (portal-based vs inline, button vs div trigger) that a shared wrapper would introduce more complexity than it saves. The shared utility functions and class helpers are sufficient to keep the visual output consistent without coupling the component implementations.

---

## Non-Goals

- Blocking save/run when warnings are present — warnings are purely informational.
- Validating settings outside the dashboard; the dashboard workflow defaults page is covered because it is the direct authoring surface for these values.
- Validating values that are `undefined` (inherited) — those carry no explicit user choice at this level.
- Validating `sessionId` or `additionalArgs` free-text fields — content is too open-ended to validate statically.

---

## Broader Error Handling Gap (Out of Scope for This Plan)

The current ctrlyoke error surface has three tiers:

| Tier                | Mechanism                                                       | User-visible result                            |
| ------------------- | --------------------------------------------------------------- | ---------------------------------------------- |
| Schema validation   | AJV at parse time in `PromptFileParser`                         | VS Code diagnostic (squiggly + Problems panel) |
| Semantic validation | Business rule checks in `PromptFileParser`                      | `platform.error()` toast notification          |
| Runtime fallbacks   | Best-effort degradation (e.g., session not found → new session) | Log warning only — **not surfaced to user**    |

**The gap:** Runtime warnings are logged but never reach the dashboard or the user. A workflow
that silently starts fresh sessions when it shouldn't, skips steps due to unmet pre-conditions,
or uses a model that falls back to a harness default — the user has no visibility into any of
this during or after execution.

**Recommended future plan (separate backlog item):** A `WorkflowDiagnosticsService` that collects
warnings during execution and surfaces them:

- In the Output section as a `[Warning]` label on the relevant step
- As a summary badge on the step in the Prompts Panel (yellow ⚠ icon)
- Optionally in a dedicated "Diagnostics" tab in the workflow drawer

This would cover runtime warnings (session fallback, model fallback, pre-condition skip) as
well as the parse-time semantic errors (currently shown only as a toast that disappears). The
dropdown validation work in this plan addresses the _before-run_ static check; the future plan
would address _during/after-run_ dynamic feedback.
