# Pre-Condition Plan

## Overview

This plan covers three closely related additions to FlightPath's script-execution model:

1. **Pre-Condition** — a new script gate that runs _before_ a prompt and decides whether to
   run the prompt, skip it, or stop the workflow entirely. The key motivation is gating the
   `finalStep` (and its loop) on a live check: e.g., only re-run "Fix test failures" if
   tests are actually failing.

2. **Standardize Script Properties** — `endCondition`, `preCondition`, and `scriptStep` all
   run scripts and evaluate their output. Right now only `endCondition` has `compareSource`
   and `returns`; `scriptStep` only tests exit code. This plan aligns all three behind a
   shared `scriptProperties` schema definition .

3. **Failure Action** — replace ad-hoc booleans (`continueOnFailure`) and implicit stop
   behaviour with an explicit `failureAction` enum that differs per context:

   | Context       | Options                                          |
   | ------------- | ------------------------------------------------ |
   | End Condition | `"continue"` · `"retry"` · `"stopWorkflow"`      |
   | Pre-Condition | `"continue"` · `"skipPrompt"` · `"stopWorkflow"` |
   | Script Step   | `"continue"` · `"stopWorkflow"`                  |

---

## Why Pre-Condition and Not Just a Script Step Before the Prompt?

A `type: script` step before the final prompt runs _once_. The `finalStep` loop re-runs
the final prompt until its own end condition passes. A `preCondition` on the `finalStep`
runs at the _start of each loop iteration_, gating whether the AI prompt runs at all on
that pass.

Example: `npm test` passes → the "Fix test failures" prompt is skipped → loop exits
cleanly. Without `preCondition`, you would need the AI prompt to detect the clean state,
which wastes an AI round-trip.

The same benefit applies to regular queue steps: a `preCondition` can gate "Generate API
docs" on whether the relevant source files changed, for example.

---

## Shared `scriptProperties` Schema Definition

Create a new `$ref`-able definition that captures the fields common to all three contexts:

```json
"scriptProperties": {
  "type": "object",
  "properties": {
    "script": {
      "type": "string",
      "description": "Shell command or path to script. Resolved relative to workspace root or .flightpath/."
    },
    "compareSource": {
      "type": "string",
      "enum": ["auto", "stdout", "stderr", "exitCode"],
      "description": "Which output to compare against returns. 'auto': 'true'/'false' use exit code, other values compare stdout. 'stdout': always compare stdout. 'stderr': compare stderr. 'exitCode': compare numeric exit code."
    },
    "returns": {
      "type": "string",
      "description": "Expected result to compare against. For 'true'/'false' with auto compareSource, uses exit code (0 = true). For other values, auto checks stdout via exact match, numeric >=, or substring. For compareSource 'exitCode', provide the expected code as a string (e.g. '0', '1')."
    },
    "timeout": {
      "type": "number",
      "description": "Timeout in milliseconds. Defaults to flightpath.scriptTimeout setting."
    }
  },
  "required": ["script"]
}
```

`endCondition` gains `$ref: "#/definitions/scriptProperties"` via `allOf`, removing its
duplicate `script`/`compareSource`/`timeout` inline properties. `endCondition` continues
to require `returns`.

### Field Name: `returns`

The schema field stays `returns` across all three contexts — it reads naturally in YAML
(`returns: "true"`) and is already implemented in `endCondition`. The UI label "Expected
Return" already diverges from the schema name and that's intentional; UI labels don't need
to mirror field names verbatim. No rename is needed.

---

## 1. Pre-Condition

### Schema

`preCondition` is added to `executionProperties` alongside `endCondition`, so it inherits
to every prompt and can be set at workflow-level defaults or per-prompt.

```json
"preCondition": {
  "oneOf": [
    { "$ref": "#/definitions/preCondition" },
    { "type": "null" }
  ],
  "description": "Script gate that runs before the prompt. Determines whether to run the prompt, skip it, or stop the workflow. When set at workflow level, all prompts inherit it unless overridden. Use null to disable inherited pre-condition for a specific prompt."
}
```

```json
"preCondition": {
  "type": "object",
  "allOf": [{ "$ref": "#/definitions/scriptProperties" }],
  "properties": {
    "failureAction": {
      "type": "string",
      "enum": ["continue", "skipPrompt", "stopWorkflow"],
      "default": "skipPrompt",
      "description": "What to do when the pre-condition check fails. 'continue': run the prompt anyway (pre-condition is advisory). 'skipPrompt': skip this prompt and advance the queue (default). 'stopWorkflow': halt execution."
    }
  },
  "required": ["script"]
}
```

**Default `failureAction` is `skipPrompt`** — the most common intent (skip a prompt if a
condition isn't met). Users explicitly set `"continue"` to make it advisory, or
`"stopWorkflow"` for hard gates.

### Pre-Condition Logic in the Final Step Loop

When the `finalStep` has a `preCondition`, it is evaluated at the start of each loop
iteration (before the AI prompt runs):

- **`skipPrompt`**: the loop considers this iteration a no-op; the normal end-condition
  mechanism decides whether to loop again or exit. In practice: if the pre-condition says
  "skip" it typically means the condition causing the loop to continue is already resolved,
  so the loop should exit. The runtime exits the loop (treats as a clean pass) when
  `finalStep.preCondition` returns `skipPrompt`. This is the primary use case: "if tests
  pass, skip the fix prompt and we're done."
- **`continue`**: the AI prompt runs regardless; pre-condition is informational only.
- **`stopWorkflow`**: halt.

### YAML Examples

```yaml
# Gate the final step: only run "Fix test failures" if tests are failing
finalStep:
  prompt: Tests are failing — fix them and try again.
  harness: claude-cli
  preCondition:
    script: npm test
    failureAction: skipPrompt # tests pass → skip prompt → loop exits

# Workflow-level pre-condition: skip all prompts if branch is protected
preCondition:
  script: git branch --show-current | grep -qv "^main$"
  failureAction: stopWorkflow

# Per-prompt pre-condition with advisory mode
steps:
  - name: generate-docs
    prompt: Generate API documentation.
    preCondition:
      script: git diff --name-only HEAD | grep -q "src/"
      returns: "true"
      failureAction: skipPrompt # skip if no source changes
```

---

## 2. End Condition Updates

### `returns` Field (Unchanged)

`endCondition` already uses `returns`. No rename is needed — all three contexts will use
`returns` in the schema. The UI labels it "Expected Return" in all three places.

### Add `failureAction`

Replace the implicit "stop after maxRetries exhausted" with an explicit option:

```json
"failureAction": {
  "type": "string",
  "enum": ["continue", "retry", "stopWorkflow"],
  "default": "stopWorkflow",
  "description": "What to do when end condition fails. 'retry': re-run the AI prompt (up to maxRetries times — default when maxRetries > 0). 'continue': advance to the next step even if validation fails. 'stopWorkflow': halt execution (default when maxRetries is exhausted or 0)."
}
```

**Interaction with `maxRetries`**: `failureAction: "retry"` is the mechanism; `maxRetries`
is the limit. When `maxRetries` is exhausted the behavior escalates to `stopWorkflow`.

**`failureAction: "retry"` defaults `maxRetries` to 1 if unset.** This avoids the
confusing state where a user selects "retry" but gets zero retries because they never
set `maxRetries`. The runtime applies this default at execution time; the schema field
remains optional. `failureAction: "continue"` and `"stopWorkflow"` ignore `maxRetries`
entirely.

---

## 3. Script Step Updates

### Add `compareSource` and `returns`

Currently `scriptStep` only uses exit code 0 = success. With this change it adopts the
same `scriptProperties` base:

```json
"scriptStep": {
  "type": "object",
  "description": "A workflow step that runs a shell script/command with no AI interaction.",
  "allOf": [{ "$ref": "#/definitions/scriptProperties" }],
  "properties": {
    "type": { "type": "string", "const": "script" },
    "name": { "type": "string", "maxLength": 100 },
    "failureAction": {
      "type": "string",
      "enum": ["continue", "stopWorkflow"],
      "default": "stopWorkflow",
      "description": "What to do when the script fails or returns is not matched. 'continue': log a warning and advance the queue. 'stopWorkflow': halt execution (default)."
    },
    "_runtime": { "$ref": "#/definitions/promptRuntimeMetadata" }
  },
  "required": ["type", "script"],
  "additionalProperties": false
}
```

> **Why `_runtime` must be listed explicitly**: `scriptStep` uses `additionalProperties: false`,
> so every permitted field must appear in `properties`. `_runtime` is needed so FlightPath can
> write execution metadata (`startedAt`, `completedAt`, `terminalStatus`) into working files
> without failing AJV validation.

> **`preCondition` does not apply to script steps.** `preCondition` (like `endCondition`)
> exists to avoid wasteful AI round-trips — it has no value for shell scripts, which can
> self-gate with a trivial early-exit (`if ! condition; then exit 0; fi`) at zero cost.
> Keeping it off script steps also preserves the symmetry with `endCondition` and keeps the
> mental model simple: both gates are prompt-step concerns only.

### Replace `continueOnFailure` with `failureAction`

`continueOnFailure: boolean` is removed. Migration: `continueOnFailure: true` →
`failureAction: "continue"`. Pre-release — no backward compat alias needed.

`EndConditionEvaluator.evaluateScript()` (the shared helper extracted in the Script Step
plan) already handles the result evaluation; `executeScriptStep()` uses the same helper
and now also passes `compareSource` and `returns`.

---

## Schema Design Summary

```
definitions/
  scriptProperties          ← NEW: script, compareSource, returns, timeout
  preCondition              ← NEW: allOf scriptProperties + failureAction enum
  endCondition              ← UPDATED: allOf scriptProperties, add failureAction (returns unchanged)
  scriptStep                ← UPDATED: allOf scriptProperties, continueOnFailure→failureAction,
                               + explicit _runtime field (additionalProperties:false requires
                               every permitted field listed; preCondition NOT added — script
                               steps self-gate via early exit)
  executionProperties       ← UPDATED: add preCondition field (alongside endCondition)
```

`endCondition` continues to require `returns`. `preCondition` and `scriptStep` do not
require `returns` — absence means exit code 0 = success.

---

## Execution Architecture

### `WorkflowExecutor` — Pre-Condition Gate

Before dispatching any step (AI or script), check if that step has a `preCondition`:

```typescript
async executeStep(step: WorkflowStep, index: number) {
  // preCondition is prompt-only — script steps self-gate via early exit
  if (!isScriptStep(step) && step.preCondition) {
    const result = await this.evaluatePreCondition(step.preCondition, index);
    if (result === "skipPrompt") {
      // Mark step as skipped; if finalStep, exit loop cleanly
      return this.handleSkippedStep(step, index);
    }
    if (result === "stopWorkflow") {
      return this.stopWorkflow("Pre-condition check failed");
    }
    // "continue" → fall through and run the step
  }
  // ... existing dispatch
}
```

`evaluatePreCondition()` reuses `EndConditionEvaluator.evaluateScript()`, passing
`compareSource` and `returns` from the `preCondition` config.

### Final Step Loop — Skip = Exit

When `finalStep` has a `preCondition` and it returns `skipPrompt`, this is semantically
"the condition we were fixing is resolved — the loop is done." `executeFinalStep()` exits
the loop and marks the workflow complete. This is distinct from a mid-queue skip, where
the queue simply advances to the next step.

### `EndConditionEvaluator` — Shared Helper Update

`evaluateScript(config: ScriptEvaluationConfig)` signature:

```typescript
interface ScriptEvaluationConfig {
  script: string;
  compareSource?: "auto" | "stdout" | "stderr" | "exitCode";
  returns?: string;
  timeout?: number;
}
```

All three consumers (`endCondition`, `preCondition`, `scriptStep`) pass this same shape.
`returns` absent → exit code 0 = pass.

### Skipped Step — Status, Broadcast, and Output

When `handleSkippedStep()` runs, it must:

1. **Broadcast a `STEP_STATUS_CHANGED` message** to the webview with
   `status: STEP_STATUS.SKIPPED` (`"skipped"` — new constant, see DashboardConstants below).
   This is the same pattern used for `completed` and `failed`.

2. **Append a status output entry** to the live ordered entries so the user can see _why_
   the step was skipped. Format:

   ```
   [Pre-condition] Step skipped — pre-condition check did not pass.
   ```

   Include the pre-condition script command and its output (stdout/stderr) at debug
   verbosity so users can diagnose unexpected skips.

3. **For `finalStep` skips**: broadcast `FINAL_PROMPT_STATUS_CHANGED` with
   `status: STEP_STATUS.SKIPPED`, then mark the workflow `completed` (not `stopped`).
   The loop exits cleanly — this is the success case.

4. **For mid-queue skips**: advance `currentStep` normally (same as a step completing),
   then continue with the next queued step.

**`DashboardConstants.ts` change required:**

```typescript
// Add to STEP_STATUS
SKIPPED: "skipped",
```

**`WorkflowStepsPanel.tsx` rendering**: a skipped step shows a skip/dash icon (distinct
from the checkmark for `completed` and the X for `failed`) in a muted/gray style. The
step name renders at reduced opacity. Tooltip: "Skipped by pre-condition".

**`workflowStore.ts`**: `setStepStatus` and the `liveOrderedEntries` handlers must accept
`"skipped"` as a valid `StepStatus` value — already handled if `StepStatus` is typed as
`typeof STEP_STATUS[keyof typeof STEP_STATUS]` (which picks up the new constant
automatically).

### `PropertyResolver` — `preCondition` Inheritance

`PropertyResolver` merges `executionProperties` fields using three-tier precedence
(prompt → workflow → settings). The `null`-as-disable pattern is already handled for
`endCondition` (explicit `null` at prompt level overrides an inherited object). Since
`preCondition` follows the same schema shape (`oneOf: [preConditionDef, null]`),
`PropertyResolver` handles it correctly without modification — **no code change needed**.

Confirm: a prompt-level `preCondition: null` must resolve to `null` (disabled), not fall
through to the workflow-level default. Verify this matches how `endCondition: null` is
already resolved, and add a test case to cover it (see Testing section).

---

## UI Changes

### Validation Tab (Both Panels)

Both `PropertiesDrawer.tsx` (prompt-level) and `WorkflowPropertiesPanel.tsx`
(workflow-level) host the Validation tab. Both need the same updates.

#### Extract a shared `<ScriptConditionEditor>` component

End Condition and Pre-Condition render the same field set (script, compareSource, returns,
timeout, failureAction) with only the `failureAction` options and the retry-specific fields
differing. Rather than duplicating across two panels × two sections = four near-identical
blocks, extract a single component:

```tsx
// src/ui/webview-react/components/shared/ScriptConditionEditor.tsx
interface ScriptConditionEditorProps {
  value: EndConditionConfig | PreConditionConfig | null | undefined;
  onChange: (updated: ...) => void;
  variant: "endCondition" | "preCondition";
  disabled?: boolean;
  narrow?: boolean;
}
```

- `variant: "endCondition"` renders the Failure Action dropdown with options
  Continue / Retry / Stop Workflow and shows the retry-specific fields
  (Max Retries, Retry Prompt, Resume Session on Retry) only when
  `failureAction === "retry"`.
- `variant: "preCondition"` renders Failure Action with options
  Continue / Skip Prompt / Stop Workflow; no retry fields.
- Both variants render: Script (full width), Failure Action (full width),
  Compare Source + Expected Return (side-by-side row), Timeout (half-width).

Both `PropertiesDrawer` and `WorkflowPropertiesPanel` import and reuse this component for
both sections. This is the only acceptable implementation — do not copy-paste the field
blocks.

#### Concrete Validation tab layout

```
── End Condition ─────────────────────────
[✓] Enable End Condition

  Script:          [npm test              ]
  Failure Action:  [Stop Workflow        ▾]   ← NEW (full width)
  Compare Source:  [auto▾]   Expected:  [true]
  Timeout (ms):    [30000   ]

  ── shown only when Failure Action = Retry ──
  Max Retries:     [1      ]
  Retry Prompt:    [________________________]
  [✓] Resume Session on Retry

── Pre-Condition ─────────────────────────   ← NEW section
[✓] Enable Pre-Condition

  Script:          [npm test              ]
  Failure Action:  [Skip Prompt          ▾]
  Compare Source:  [auto▾]   Expected:  [    ]
  Timeout (ms):    [30000   ]
```

Section headers use the existing `text-[11px] font-semibold uppercase text-description-fg`
label style (same as field labels), left-aligned, acting as a visual separator — no
horizontal rule needed.

#### Failure Action conditional rendering

Read `failureAction` directly from the condition config value, not from local component
state. The retry-specific block renders conditionally:

```tsx
{
  variant === "endCondition" && value?.failureAction === "retry" && (
    <>{/* Max Retries, Retry Prompt, Resume Session on Retry */}</>
  );
}
```

Default: when `failureAction` is `undefined`, treat as `"stopWorkflow"` for the End
Condition (do not show retry fields) and `"skipPrompt"` for Pre-Condition.

#### Inherit vs. disable state

The Enable checkbox maps to two states only:

- **Unchecked** → `undefined` (inherit from workflow level, or no condition if already at
  workflow level). Grays out all fields.
- **Checked** → object with defaults. Fields become editable.

There is no explicit `null` (disabled) state in the UI for either section — that is a
schema-level concept for programmatic use. The UI does not expose a third "explicitly
disabled" toggle; omitting it keeps the interaction model simple.

### Script Step Editor

In `PromptEditor.tsx`, when `stepType === "script"`:

- Replace "Continue on failure" checkbox with a `failureAction` dropdown
  (Continue / Stop Workflow)
- Add Compare Source dropdown
- Add Expected Return input

### `editorStore.ts` — Missing UI State Fields

Two more changes are required in `editorStore.ts` beyond those already covered in the
Editor State Cache Maintenance section:

**`EndConditionConfig`** (webview-local mirror of `EndCondition`) needs `failureAction`:

```typescript
export interface EndConditionConfig {
  script: string;
  returns?: string;
  compareSource?: EndConditionCompareSource;
  timeout?: number;
  maxRetries?: number;
  retryPrompt?: string;
  resumeSessionOnRetry?: boolean;
  failureAction?: EndConditionFailureAction; // ← ADD
}
```

**`PropertyValues`** (webview-local mirror of `ExecutionProperties`) needs `preCondition`:

```typescript
export interface PropertyValues {
  // ... existing fields ...
  preCondition?: PreCondition | null; // ← ADD: undefined = inherit, null = disabled, object = override
}
```

**`PROPERTY_DEFAULTS`**: add `preCondition: undefined`.

**`getPromptProperties()`**: emit `preCondition` when `properties.preCondition !== undefined`
(same pattern as `endCondition`).

**`EndCondition` UI conditional rendering**: when `failureAction` is not `"retry"`, the
PropertiesDrawer and WorkflowPropertiesPanel Validation tabs must hide the Max Retries,
Retry Prompt, and Resume Session on Retry fields. These are controlled by local UI state
reading `properties.endCondition?.failureAction`.

---

## Type System Changes

```typescript
// New
export type PreConditionFailureAction =
  | "continue"
  | "skipPrompt"
  | "stopWorkflow";
export type EndConditionFailureAction = "continue" | "retry" | "stopWorkflow";
export type ScriptStepFailureAction = "continue" | "stopWorkflow";

export interface ScriptProperties {
  script: string;
  compareSource?: "auto" | "stdout" | "stderr" | "exitCode";
  returns?: string;
  timeout?: number;
}

export interface PreCondition extends ScriptProperties {
  failureAction?: PreConditionFailureAction; // default: "skipPrompt"
}

// Updated
export interface EndCondition extends ScriptProperties {
  // returns is in ScriptProperties (unchanged field name)
  maxRetries?: number;
  retryPrompt?: string;
  resumeSessionOnRetry?: boolean;
  failureAction?: EndConditionFailureAction; // default: "stopWorkflow"
}

export interface ScriptStep extends ScriptProperties {
  type: "script";
  name?: string;
  failureAction?: ScriptStepFailureAction; // replaces continueOnFailure; default: "stopWorkflow"
  _runtime?: PromptRuntimeMetadata;
}
```

`preCondition` is **not** added to `ScriptStep` — script steps can self-gate with an early
exit and don't benefit from an external gate. This matches `endCondition`, which is also
prompt-only. `WorkflowExecutor` must guard the pre-condition check accordingly:

```typescript
// preCondition is only on PromptStep (via ExecutionProperties)
if (!isScriptStep(step) && step.preCondition) {
  const result = await this.evaluatePreCondition(step.preCondition, index);
  ...
}
```

`ExecutionProperties` (and its webview mirror `PropertyValues`) gains `preCondition?:
PreCondition | null`. This flows into `settingsStore.WorkflowProperties` and all prompt-level
property resolution automatically.

---

## Editor State Cache Maintenance

### Rule: Every script step field must appear in `SavedNewStepState`

`editorStore` caches the user's in-progress edits in two places:

- **`pendingEdits`** — keyed by step index, preserves unsaved changes when the user clicks
  away to another step and comes back
- **`savedNewStepState`** — snapshots the new-step form when the user clicks an existing
  step for editing, then restores it when they cancel or finish

Both caches use the `SavedNewStepState` interface (renamed from `SavedNewPromptState` — see
Naming Decision below). Every field that appears in `EditorState` for a script step must
also appear in `SavedNewStepState`, otherwise that field is silently dropped when the user
navigates away.

When this plan adds `failureAction`, `compareSource`, and `returns` to `ScriptStep`, the
following changes are required in `editorStore.ts`:

1. **Add the new fields to `SavedNewStepState`**:

   ```typescript
   export interface SavedNewStepState {
     // ... existing fields ...
     scriptFailureAction?: ScriptStepFailureAction;
     scriptCompareSource?: CompareSource;
     scriptReturns?: string;
   }
   ```

2. **Write all three fields in every `pendingEdits` assignment** — there are currently two
   write sites: `enterEditMode` (outgoing-step save) and `deselect`. Both must include the
   new fields.

3. **Write all three fields in the `savedNewStepState` snapshot** inside `enterEditMode`
   (the snapshot taken when first entering edit mode from new-step form).

4. **Restore all three fields in `enterEditMode`** when loading a script step — use
   `pendingEdit.scriptFailureAction ?? promptData.failureAction` (and same pattern for the
   other two) so the cache takes precedence over the persisted workflow data.

5. **`enterNewPromptMode`, `cancelEdit`, `deselect`** — all three restore-from-saved paths
   must set the new fields from `savedNewStepState`.

> **Checklist shorthand**: any time you add a direct `EditorState` field for a script step,
> grep for `scriptCommand` and mirror every occurrence for the new field. `scriptCommand` is
> the canonical example of how script-specific fields are handled throughout the store.

---

### Naming Decision: `SavedNewPromptState` → `SavedNewStepState`

**Recommendation: rename it.** The interface now holds both prompt and script step state, so
`SavedNewPromptState` is a misnomer. `SavedNewStepState` is accurate and low-risk (purely a
type rename, no runtime impact).

Method names (`selectPrompt`, `enterNewPromptMode`, `enterEditMode`) are internal
implementation details that describe _editor mode operations_, not step types. "New prompt
mode" is a specific UI concept meaning "creating a new step from scratch" — it remains
sensible regardless of whether the step being created is a prompt or a script. Leave those
method names as-is to avoid high-churn, low-value renaming.

---

### Architectural Pattern: Two-Type Model Already in Place

The current `editorStore` design already mirrors the schema's split between `promptStep` and
`scriptStep`:

- **Script step fields** (`scriptCommand`, `scriptTimeout`, `scriptContinueOnFailure`) live
  as direct `EditorState` properties — not inside `PropertyValues`.
- **Prompt step fields** (`harness`, `model`, `agent`, `skills`, `resumeSession`, etc.) live
  inside `PropertyValues` (which maps 1:1 to the schema's `executionProperties`).

This is correct. Do **not** merge them into a single blob. When adding the new script step
fields (`failureAction`, `compareSource`, `returns`) from this plan, add them as direct
`EditorState` fields (e.g. `scriptFailureAction`, `scriptCompareSource`, `scriptReturns`),
keeping the same two-type split. The `PropertyValues` interface is purely for execution
properties that apply to AI prompt steps.

Renaming `PropertyValues` to `PromptExecutionProperties` is an optional cosmetic improvement
worth doing at the same time as the `SavedNewStepState` rename, but not a blocker.

---

## File Change Summary

| File                                                                 | Change                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemas/prompt-schema.json`                                         | Add `scriptProperties`, `preCondition` definitions; update `endCondition` (allOf scriptProperties, add `failureAction`); update `scriptStep` (allOf scriptProperties, `continueOnFailure`→`failureAction`, add explicit `preCondition` + `_runtime` properties); add `preCondition` to `executionProperties`                                                        |
| `src/types/FlightPathTypes.ts`                                       | Add `ScriptProperties`, `PreCondition`, `PreConditionFailureAction`, `EndConditionFailureAction`, `ScriptStepFailureAction`; update `EndCondition` (add `failureAction`, extend `ScriptProperties`); update `ScriptStep` (`continueOnFailure`→`failureAction`, extend `ScriptProperties`; no `preCondition` — prompt-only)                                          |
| `src/types/DashboardConstants.ts`                                    | Add `SKIPPED: "skipped"` to `STEP_STATUS`                                                                                                                                                                                                                                                                                                                           |
| `src/flightpath/WorkflowExecutor.ts`                                 | Add pre-condition gate before every step dispatch; `handleSkippedStep()` broadcasts `STEP_STATUS.SKIPPED` + output entry; handle `skipPrompt` on `finalStep` as clean loop exit; script step `continueOnFailure` → `failureAction`; pass `compareSource`/`returns` to evaluator                                                                                     |
| `src/flightpath/EndConditionHandler.ts`                              | Wire `failureAction` for continue/retry/stop; apply `maxRetries` default of 1 when `failureAction: "retry"` and `maxRetries` is unset                                                                                                                                                                                                                               |
| `src/flightpath/EndConditionEvaluator.ts`                            | `ScriptEvaluationConfig` already uses `returns`; shared by all three consumers unchanged                                                                                                                                                                                                                                                                            |
| `src/ui/webview-react/store/editorStore.ts`                          | Rename `SavedNewPromptState` → `SavedNewStepState`; add `scriptFailureAction`, `scriptCompareSource`, `scriptReturns` to `SavedNewStepState` and `EditorState`; update all `pendingEdits`/`savedNewStepState` write+read paths; add `failureAction` to `EndConditionConfig`; add `preCondition` to `PropertyValues` + `PROPERTY_DEFAULTS` + `getPromptProperties()` |
| `src/ui/webview-react/store/workflowStore.ts`                        | `setStepStatus` and `liveOrderedEntries` handlers accept `"skipped"` automatically via `StepStatus` type (picks up new constant); verify no hardcoded status string comparisons                                                                                                                                                                                     |
| `src/ui/webview-react/store/settingsStore.ts`                        | Add `preCondition` to `WorkflowProperties` and `executionProperties` shape                                                                                                                                                                                                                                                                                          |
| `src/ui/webview-react/components/shared/ScriptConditionEditor.tsx`   | NEW shared component used by both panels; `variant` prop selects endCondition (failureAction: continue/retry/stop + retry fields) vs preCondition (failureAction: continue/skip/stop, no retry fields)                                                                                                                                                              |
| `src/ui/webview-react/components/editor/PropertiesDrawer.tsx`        | Validation tab: replace inline End Condition fields with `<ScriptConditionEditor variant="endCondition">`; add `<ScriptConditionEditor variant="preCondition">` below with its own enable toggle                                                                                                                                                                    |
| `src/ui/webview-react/components/layout/WorkflowPropertiesPanel.tsx` | Same Validation tab swap as PropertiesDrawer — both panels now delegate to `ScriptConditionEditor`                                                                                                                                                                                                                                                                  |
| `src/ui/webview-react/components/editor/PromptEditor.tsx`            | Script step editor: `continueOnFailure` checkbox → `failureAction` dropdown; add `compareSource` + `returns` fields                                                                                                                                                                                                                                                 |
| `src/ui/webview-react/components/layout/WorkflowStepsPanel.tsx`      | Render `skipped` step status with skip/dash icon in muted style; tooltip "Skipped by pre-condition"                                                                                                                                                                                                                                                                 |
| `src/ui/webview-react/utils/endCondition.ts`                         | No rename needed; add helpers for preCondition if needed                                                                                                                                                                                                                                                                                                            |
| `src/completions/`                                                   | Offer `preCondition` completions in `executionProperties`; add `failureAction` to `endCondition` and `scriptStep` completions; add `compareSource`/`returns` to `scriptStep` completions                                                                                                                                                                            |
| `src/test/` (multiple files)                                         | See Testing section above for per-file breakdown; run `grep -r "continueOnFailure" src/test/` first to find all compile-broken references                                                                                                                                                                                                                           |

---

## Testing

The test suite (`src/test/`) has ~64 files. The following files are directly affected and
require new test cases or updates to existing ones:

| Test File                              | Required Changes                                                                                                                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EndConditionEvaluator.test.ts`        | Verify `returns` absent → exit code 0 = pass; `compareSource` + `returns` combinations on `evaluateScript()`                                                                                               |
| `EndConditionHandler.test.ts`          | Add cases for `failureAction: "continue"` (advance despite failure) and `failureAction: "retry"` defaulting `maxRetries` to 1 when unset; verify `failureAction: "stopWorkflow"` matches current behaviour |
| `WorkflowExecutor.test.ts`             | Pre-condition gate: `skipPrompt` skips step and advances queue; `stopWorkflow` halts; `continue` falls through; `finalStep` skip = loop exit + `completed` state; script step `failureAction` variants     |
| `PromptFileParser.test.ts`             | New valid YAML with `preCondition`, `failureAction` on `endCondition` and `scriptStep`, `compareSource`/`returns` on `scriptStep`; verify `continueOnFailure` fails schema validation (removed field)      |
| Schema validation tests (if separate)  | Same as PromptFileParser coverage above                                                                                                                                                                    |
| `PropertyResolver.test.ts` (if exists) | `preCondition: null` at prompt level overrides workflow-level `preCondition` object; workflow-level `preCondition` inherits to all prompts without explicit override                                       |

**Files with `continueOnFailure` references** — run `grep -r "continueOnFailure" src/test/`
before starting; every occurrence is a compile error after the type change and needs
updating to `failureAction`.

**New test cases to add (no existing file)**: if there is no `PropertyResolver.test.ts`,
add `preCondition` null-override coverage to `WorkflowExecutor.test.ts` as an integration
scenario.

---

## Edge Cases

| Scenario                                                          | Handling                                                                                                                                                        |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preCondition.failureAction: "skipPrompt"` on a mid-queue step    | Step is skipped; queue advances to next step normally                                                                                                           |
| `preCondition.failureAction: "skipPrompt"` on `finalStep`         | Loop exits cleanly (treated as "resolved")                                                                                                                      |
| `preCondition.failureAction: "continue"`                          | Pre-condition result is logged but step runs regardless                                                                                                         |
| Workflow-level `preCondition` + prompt-level `preCondition: null` | Prompt-level `null` disables inherited pre-condition (mirrors `endCondition` null behaviour)                                                                    |
| `endCondition.failureAction: "continue"` with `maxRetries: 3`     | All 3 retries exhausted, then proceeds anyway                                                                                                                   |
| `endCondition.failureAction: "retry"` with `maxRetries` unset     | Runtime defaults `maxRetries` to 1 at execution time                                                                                                            |
| `endCondition.failureAction: "retry"` with `maxRetries: 0`        | Explicitly zero retries — treated as immediate `stopWorkflow`; no special handling needed since the intent is clear                                             |
| `scriptStep` with `returns` but no `compareSource`                | `compareSource` defaults to `"auto"` — `"true"`/`"false"` use exit code, other strings check stdout                                                             |
| `continueOnFailure` in existing working files                     | Treated as unknown field by schema (`additionalProperties: false` on scriptStep) — schema validation warns; users should migrate to `failureAction: "continue"` |

---

## Not In Scope

- Pre-condition on the `finalStep` loop with access to loop count or prior AI output — the
  pre-condition script runs in the shell environment; if it needs loop metadata it must
  read a file that FlightPath or the AI wrote
- Pre-condition output injected into the prompt text (use `priorContext` or shell
  variables via `script` for that)
- `preCondition.maxRetries` / retry loop on pre-condition failure — re-running a gate
  check without a recovery action between attempts is pointless; just run the script step
  as a `type: script` step before the prompt if retry logic is needed
- `preCondition.retryPrompt` — pre-conditions have no AI interaction
- UI for `preCondition` on workflow defaults in a separate settings panel beyond the
  Validation tab — the existing tab hierarchy covers it
