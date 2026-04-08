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

3. **Pass/Fail Actions** — replace ad-hoc booleans (`continueOnFailure`) and implicit
   behaviour with explicit `onPass` and `onFail` fields on every script-evaluating block.
   Both fields share the same options per context — `onPass` and `onFail` are symmetric:

   | Context       | Options (same for both `onPass` and `onFail`)            | `onPass` default  | `onFail` default   |
   | ------------- | -------------------------------------------------------- | ----------------- | ------------------ |
   | End Condition | `"continue"` · `"retry"` · `"stopWorkflow"`              | `"continue"`      | `"stopWorkflow"`   |
   | Pre-Condition | `"continue"` · `"skipPrompt"` · `"stopWorkflow"`         | `"continue"`      | `"skipPrompt"`     |
   | Script Step   | `"continue"` · `"stopWorkflow"`                          | `"continue"`      | `"stopWorkflow"`   |

   `retry` is available on both `onPass` and `onFail` for `endCondition` — e.g.,
   `onPass: "retry"` enables "keep running this prompt while tests pass" patterns.
   `skipPrompt` is available on both fields for `preCondition`. Each context has one
   action type used for both fields, simplifying the type system to one type per context.

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
    "onPass": {
      "type": "string",
      "enum": ["continue", "skipPrompt", "stopWorkflow"],
      "default": "continue",
      "description": "What to do when the pre-condition check passes (script exits 0 / returns matches). 'continue': run the prompt (default). 'skipPrompt': skip this prompt and advance the queue. 'stopWorkflow': halt execution."
    },
    "onFail": {
      "type": "string",
      "enum": ["continue", "skipPrompt", "stopWorkflow"],
      "default": "skipPrompt",
      "description": "What to do when the pre-condition check fails. 'continue': run the prompt anyway (pre-condition is advisory). 'skipPrompt': skip this prompt and advance the queue (default). 'stopWorkflow': halt execution."
    }
  },
  "required": ["script"]
}
```

**Default `onPass` is `"continue"`** (run the prompt) and **default `onFail` is `"skipPrompt"`** — the most common intent is a gate check: condition passes → run the prompt, condition fails → skip. Both fields are optional; you only need to set the one that differs from the default.

The test-skip case ("skip prompt when tests pass") is expressed naturally as `onPass: skipPrompt` with no `onFail` needed. The gate case ("only run when source changed") is `onFail: skipPrompt` with no `onPass` needed.

### Pre-Condition Logic in the Final Step Loop

When the `finalStep` has a `preCondition`, it is evaluated at the start of each loop
iteration (before the AI prompt runs). The resolved action comes from `onPass` (if the
script passes) or `onFail` (if it fails):

- **`skipPrompt`** (from either field): the loop exits cleanly — this means the condition
  being fixed is already resolved. The runtime marks the workflow `completed`. This is the
  primary use case: "if tests pass, skip the fix prompt and we're done."
- **`continue`**: the AI prompt runs regardless; pre-condition is informational only.
- **`stopWorkflow`**: halt.

### YAML Examples

```yaml
# Skip the fix prompt when tests pass (tests passing = we're done)
finalStep:
  prompt: Tests are failing — fix them and try again.
  harness: claude-cli
  preCondition:
    script: npm test
    onPass: skipPrompt  # tests pass → skip prompt → loop exits

# Gate the fix prompt on tests failing (equivalent via onFail)
finalStep:
  prompt: Tests are failing — fix them and try again.
  harness: claude-cli
  preCondition:
    script: npm test
    onFail: skipPrompt  # tests fail → skip doesn't fire → prompt runs
    # onPass defaults to "continue", so passing tests run the prompt — NOT what you want here
    # Use the onPass form above for the test-fix loop

# Workflow-level pre-condition: stop all prompts if on a protected branch
preCondition:
  script: git branch --show-current | grep -qv "^main$"
  onFail: stopWorkflow

# Per-prompt pre-condition: skip if no source changes
steps:
  - name: generate-docs
    prompt: Generate API documentation.
    preCondition:
      script: git diff --name-only HEAD | grep -q "src/"
      onFail: skipPrompt  # skip if no source changes (exit non-zero)
```

---

## 2. End Condition Updates

### `returns` Field (Unchanged)

`endCondition` already uses `returns`. No rename is needed — all three contexts will use
`returns` in the schema. The UI labels it "Expected Return" in all three places.

### Add `onPass` and `onFail`

Replace the implicit "stop after maxRetries exhausted" with explicit fields:

```json
"onPass": {
  "type": "string",
  "enum": ["continue", "retry", "stopWorkflow"],
  "default": "continue",
  "description": "What to do when the end condition passes. 'continue': advance to the next step (default). 'retry': re-run the AI prompt again (e.g., keep implementing backlog items while tests stay green). 'stopWorkflow': halt execution immediately."
},
"onFail": {
  "type": "string",
  "enum": ["continue", "retry", "stopWorkflow"],
  "default": "stopWorkflow",
  "description": "What to do when end condition fails. 'retry': re-run the AI prompt (up to maxRetries times). 'continue': advance to the next step even if validation fails. 'stopWorkflow': halt execution (default)."
}
```

**Interaction with `maxRetries`**: `"retry"` (on either field) is the mechanism; `maxRetries`
is the limit. When `maxRetries` is exhausted the behavior escalates to `stopWorkflow`.

**`"retry"` defaults `maxRetries` to 1 if unset.** This avoids the confusing state where a
user selects "retry" but gets zero retries because they never set `maxRetries`. The runtime
applies this default at execution time; the schema field remains optional. `"continue"` and
`"stopWorkflow"` ignore `maxRetries` entirely.

**`onPass: "retry"` use case**: keep re-running a prompt as long as the end condition
passes — e.g., "implement next backlog item" with `endCondition` checking that tests still
pass. Each iteration runs the prompt again until eventually tests fail (triggering `onFail`)
or `maxRetries` is exhausted.

**`onPass: "stopWorkflow"` use case**: in a dynamic workflow where prompts are appended at
runtime, stop the moment the end condition passes rather than advancing to whatever was
appended next.

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
    "onPass": {
      "type": "string",
      "enum": ["continue", "stopWorkflow"],
      "default": "continue",
      "description": "What to do when the script passes. 'continue': advance the queue (default). 'stopWorkflow': halt execution."
    },
    "onFail": {
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

### Replace `continueOnFailure` with `onPass`/`onFail`

`continueOnFailure: boolean` is removed. Migration: `continueOnFailure: true` →
`onFail: "continue"`. Pre-release — no backward compat alias needed.

`EndConditionEvaluator.evaluateScript()` (the shared helper extracted in the Script Step
plan) already handles the result evaluation; `executeScriptStep()` uses the same helper
and now also passes `compareSource` and `returns`, and the caller applies `onPass` or
`onFail` based on the result.

---

## Schema Design Summary

```
definitions/
  scriptProperties          ← NEW: script, compareSource, returns, timeout
  preCondition              ← NEW: allOf scriptProperties + onPass + onFail
  endCondition              ← UPDATED: allOf scriptProperties, add onPass + onFail (returns unchanged)
  scriptStep                ← UPDATED: allOf scriptProperties, continueOnFailure→onPass+onFail,
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
    const scriptResult = await EndConditionEvaluator.evaluateScript(step.preCondition);
    const action = scriptResult.passed
      ? (step.preCondition.onPass ?? "continue")
      : (step.preCondition.onFail ?? "skipPrompt");

    if (action === "skipPrompt") {
      return this.handleSkippedStep(step, index);
    }
    if (action === "stopWorkflow") {
      return this.stopWorkflow("Pre-condition check did not pass");
    }
    // "continue" → fall through and run the step
  }
  // ... existing dispatch
}
```

`EndConditionEvaluator.evaluateScript()` now returns `{ passed: boolean, ... }` so callers
can branch on `onPass` vs `onFail` themselves. The same pattern applies in
`EndConditionHandler` (for `endCondition`) and `executeScriptStep()` (for `scriptStep`).

### Final Step Loop — Skip = Exit

When `finalStep` has a `preCondition` and the resolved action is `skipPrompt`, this is
semantically "the condition we were fixing is resolved — the loop is done."
`executeFinalStep()` exits the loop and marks the workflow complete. This is distinct from
a mid-queue skip, where the queue simply advances to the next step.

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
timeout, onPass, onFail) with only the action options and the retry-specific fields
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

- `variant: "endCondition"` renders On Pass / On Fail dropdowns with options
  Continue / Retry / Stop Workflow and shows the retry-specific fields
  (Max Retries, Retry Prompt, Resume Session on Retry) when either field is `"retry"`.
- `variant: "preCondition"` renders On Pass / On Fail dropdowns with options
  Continue / Skip Prompt / Stop Workflow; no retry fields.
- Both variants render: Script (full width), On Pass + On Fail (side-by-side row),
  Compare Source + Expected Return (side-by-side row), Timeout (half-width).

Both `PropertiesDrawer` and `WorkflowPropertiesPanel` import and reuse this component for
both sections. This is the only acceptable implementation — do not copy-paste the field
blocks.

#### Concrete Validation tab layout

```
── End Condition ─────────────────────────
[✓] Enable End Condition

  Script:          [npm test              ]
  On Pass:         [Continue             ▾]   ← NEW (side-by-side)
  On Fail:         [Stop Workflow        ▾]   ← NEW
  Compare Source:  [auto▾]   Expected:  [true]
  Timeout (ms):    [30000   ]

  ── shown only when On Pass or On Fail = Retry ──
  Max Retries:     [1      ]
  Retry Prompt:    [________________________]
  [✓] Resume Session on Retry

── Pre-Condition ─────────────────────────   ← NEW section
[✓] Enable Pre-Condition

  Script:          [npm test              ]
  On Pass:         [Continue             ▾]   (side-by-side)
  On Fail:         [Skip Prompt          ▾]
  Compare Source:  [auto▾]   Expected:  [    ]
  Timeout (ms):    [30000   ]
```

Section headers use the existing `text-[11px] font-semibold uppercase text-description-fg`
label style (same as field labels), left-aligned, acting as a visual separator — no
horizontal rule needed.

#### Action conditional rendering

Read `onPass` and `onFail` directly from the condition config value, not from local
component state. The retry-specific block renders when either field is `"retry"`:

```tsx
{
  variant === "endCondition" &&
    (value?.onPass === "retry" || value?.onFail === "retry") && (
      <>{/* Max Retries, Retry Prompt, Resume Session on Retry */}</>
    );
}
```

Default: when `onPass` is `undefined`, treat as `"continue"`. When `onFail` is
`undefined`, treat as `"stopWorkflow"` for End Condition and `"skipPrompt"` for
Pre-Condition (do not show retry fields unless explicitly set).

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

- Replace "Continue on failure" checkbox with `onPass` + `onFail` dropdowns (Continue / Stop Workflow), side-by-side
- Add Compare Source dropdown
- Add Expected Return input

### `editorStore.ts` — Missing UI State Fields

Two more changes are required in `editorStore.ts` beyond those already covered in the
Editor State Cache Maintenance section:

**`EndConditionConfig`** (webview-local mirror of `EndCondition`) needs `onPass` and `onFail`:

```typescript
export interface EndConditionConfig {
  script: string;
  returns?: string;
  compareSource?: EndConditionCompareSource;
  timeout?: number;
  maxRetries?: number;
  retryPrompt?: string;
  resumeSessionOnRetry?: boolean;
  onPass?: EndConditionAction; // ← ADD
  onFail?: EndConditionAction; // ← ADD
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

**`EndCondition` UI conditional rendering**: the retry-specific fields (Max Retries,
Retry Prompt, Resume Session on Retry) are shown when either `onPass` or `onFail` is
`"retry"`. Controlled by reading `properties.endCondition?.onPass` and
`properties.endCondition?.onFail`.

---

## Type System Changes

```typescript
// New — one action type per context, shared by both onPass and onFail
export type PreConditionAction = "continue" | "skipPrompt" | "stopWorkflow";
export type EndConditionAction = "continue" | "retry" | "stopWorkflow";
export type ScriptStepAction = "continue" | "stopWorkflow";

export interface ScriptProperties {
  script: string;
  compareSource?: "auto" | "stdout" | "stderr" | "exitCode";
  returns?: string;
  timeout?: number;
}

export interface PreCondition extends ScriptProperties {
  onPass?: PreConditionAction; // default: "continue"
  onFail?: PreConditionAction; // default: "skipPrompt"
}

// Updated
export interface EndCondition extends ScriptProperties {
  // returns is in ScriptProperties (unchanged field name)
  maxRetries?: number;
  retryPrompt?: string;
  resumeSessionOnRetry?: boolean;
  onPass?: EndConditionAction; // default: "continue"
  onFail?: EndConditionAction; // default: "stopWorkflow"
}

export interface ScriptStep extends ScriptProperties {
  type: "script";
  name?: string;
  onPass?: ScriptStepAction; // default: "continue"
  onFail?: ScriptStepAction; // replaces continueOnFailure; default: "stopWorkflow"
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

When this plan adds `onPass`, `onFail`, `compareSource`, and `returns` to `ScriptStep`, the
following changes are required in `editorStore.ts`:

1. **Add the new fields to `SavedNewStepState`**:

   ```typescript
   export interface SavedNewStepState {
     // ... existing fields ...
     scriptOnPass?: ScriptStepAction;
     scriptOnFail?: ScriptStepAction;
     scriptCompareSource?: CompareSource;
     scriptReturns?: string;
   }
   ```

2. **Write all four fields in every `pendingEdits` assignment** — there are currently two
   write sites: `enterEditMode` (outgoing-step save) and `deselect`. Both must include the
   new fields.

3. **Write all four fields in the `savedNewStepState` snapshot** inside `enterEditMode`
   (the snapshot taken when first entering edit mode from new-step form).

4. **Restore all four fields in `enterEditMode`** when loading a script step — use
   `pendingEdit.scriptOnPass ?? promptData.onPass` (and same pattern for the others)
   so the cache takes precedence over the persisted workflow data.

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
fields (`onPass`, `onFail`, `compareSource`, `returns`) from this plan, add them as direct
`EditorState` fields (e.g. `scriptOnPass`, `scriptOnFail`, `scriptCompareSource`, `scriptReturns`),
keeping the same two-type split. The `PropertyValues` interface is purely for execution
properties that apply to AI prompt steps.

Renaming `PropertyValues` to `PromptExecutionProperties` is an optional cosmetic improvement
worth doing at the same time as the `SavedNewStepState` rename, but not a blocker.

---

## File Change Summary

| File                                                                 | Change                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemas/prompt-schema.json`                                         | Add `scriptProperties`, `preCondition` definitions; update `endCondition` (allOf scriptProperties, add `onPass`+`onFail`); update `scriptStep` (allOf scriptProperties, `continueOnFailure`→`onPass`+`onFail`, add explicit `_runtime` property); add `preCondition` to `executionProperties`                                                        |
| `src/types/FlightPathTypes.ts`                                       | Add `ScriptProperties`, `PreCondition`, `PreConditionAction`, `EndConditionAction`, `ScriptStepAction`; update `EndCondition` (add `onPass`+`onFail`, extend `ScriptProperties`); update `ScriptStep` (`continueOnFailure`→`onPass`+`onFail`, extend `ScriptProperties`; no `preCondition` — prompt-only)                                          |
| `src/types/DashboardConstants.ts`                                    | Add `SKIPPED: "skipped"` to `STEP_STATUS`                                                                                                                                                                                                                                                                                                                           |
| `src/flightpath/WorkflowExecutor.ts`                                 | Add pre-condition gate before every prompt step dispatch; resolve `onPass`/`onFail` from script result; `handleSkippedStep()` broadcasts `STEP_STATUS.SKIPPED` + output entry; handle `skipPrompt` on `finalStep` as clean loop exit; script step `continueOnFailure` → `onPass`+`onFail`; pass `compareSource`/`returns` to evaluator            |
| `src/flightpath/EndConditionHandler.ts`                              | Wire `onPass`+`onFail` for continue/retry/stop; apply `maxRetries` default of 1 when either field is `"retry"` and `maxRetries` is unset                                                                                                                                                                                                           |
| `src/flightpath/EndConditionEvaluator.ts`                            | Return `{ passed: boolean, ... }` so callers branch on `onPass` vs `onFail` themselves; shared by all three consumers                                                                                                                                                                                                                                |
| `src/ui/webview-react/store/editorStore.ts`                          | Rename `SavedNewPromptState` → `SavedNewStepState`; add `scriptOnPass`, `scriptOnFail`, `scriptCompareSource`, `scriptReturns` to `SavedNewStepState` and `EditorState`; update all `pendingEdits`/`savedNewStepState` write+read paths; add `onPass`+`onFail` to `EndConditionConfig`; add `preCondition` to `PropertyValues` + `PROPERTY_DEFAULTS` + `getPromptProperties()` |
| `src/ui/webview-react/store/workflowStore.ts`                        | `setStepStatus` and `liveOrderedEntries` handlers accept `"skipped"` automatically via `StepStatus` type (picks up new constant); verify no hardcoded status string comparisons                                                                                                                                                                     |
| `src/ui/webview-react/store/settingsStore.ts`                        | Add `preCondition` to `WorkflowProperties` and `executionProperties` shape                                                                                                                                                                                                                                                                          |
| `src/ui/webview-react/components/shared/ScriptConditionEditor.tsx`   | NEW shared component; `variant` prop selects endCondition (onPass+onFail: continue/retry/stop, retry fields shown when either is retry) vs preCondition (onPass+onFail: continue/skip/stop, no retry fields)                                                                                                                                        |
| `src/ui/webview-react/components/editor/PropertiesDrawer.tsx`        | Validation tab: replace inline End Condition fields with `<ScriptConditionEditor variant="endCondition">`; add `<ScriptConditionEditor variant="preCondition">` below with its own enable toggle                                                                                                                                                    |
| `src/ui/webview-react/components/layout/WorkflowPropertiesPanel.tsx` | Same Validation tab swap as PropertiesDrawer — both panels now delegate to `ScriptConditionEditor`                                                                                                                                                                                                                                                  |
| `src/ui/webview-react/components/editor/PromptEditor.tsx`            | Script step editor: `continueOnFailure` checkbox → `onPass`+`onFail` dropdowns (side-by-side); add `compareSource` + `returns` fields                                                                                                                                                                                                              |
| `src/ui/webview-react/components/layout/WorkflowStepsPanel.tsx`      | Render `skipped` step status with skip/dash icon in muted style; tooltip "Skipped by pre-condition"                                                                                                                                                                                                                                                 |
| `src/ui/webview-react/utils/endCondition.ts`                         | No rename needed; add helpers for preCondition if needed                                                                                                                                                                                                                                                                                            |
| `src/completions/`                                                   | Offer `preCondition` completions in `executionProperties`; add `onPass`+`onFail` to `endCondition` and `scriptStep` completions; add `compareSource`/`returns` to `scriptStep` completions                                                                                                                                                          |
| `src/test/` (multiple files)                                         | See Testing section above for per-file breakdown; run `grep -r "continueOnFailure" src/test/` first to find all compile-broken references                                                                                                                                                                                                           |

---

## Testing

The test suite (`src/test/`) has ~64 files. The following files are directly affected and
require new test cases or updates to existing ones:

| Test File                              | Required Changes                                                                                                                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EndConditionEvaluator.test.ts`        | Verify `returns` absent → exit code 0 = pass; `compareSource` + `returns` combinations; verify evaluator returns `{ passed: boolean }` for caller branching                                                                                                                                                                                        |
| `EndConditionHandler.test.ts`          | Add cases for `onPass: "retry"` (re-run while passing), `onFail: "continue"` (advance despite failure), `onFail: "retry"` defaulting `maxRetries` to 1 when unset; verify defaults for `onPass`/`onFail` match expected behaviour |
| `WorkflowExecutor.test.ts`             | Pre-condition gate: `onPass: skipPrompt` skips when passes; `onFail: skipPrompt` skips when fails; `stopWorkflow` halts; `continue` falls through; `finalStep` skip = loop exit + `completed` state; script step `onPass`/`onFail` variants     |
| `PromptFileParser.test.ts`             | New valid YAML with `preCondition`, `onPass`+`onFail` on `endCondition` and `scriptStep`, `compareSource`/`returns` on `scriptStep`; verify `continueOnFailure` fails schema validation (removed field)      |
| Schema validation tests (if separate)  | Same as PromptFileParser coverage above                                                                                                                                                                                                                                                                                                              |
| `PropertyResolver.test.ts` (if exists) | `preCondition: null` at prompt level overrides workflow-level `preCondition` object; workflow-level `preCondition` inherits to all prompts without explicit override                                                                                                                                                                               |

**Files with `continueOnFailure` references** — run `grep -r "continueOnFailure" src/test/`
before starting; every occurrence is a compile error after the type change and needs
updating to `onPass`/`onFail`.

**New test cases to add (no existing file)**: if there is no `PropertyResolver.test.ts`,
add `preCondition` null-override coverage to `WorkflowExecutor.test.ts` as an integration
scenario.

---

## Edge Cases

| Scenario                                                          | Handling                                                                                                                                                        |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preCondition.onPass: "skipPrompt"` on a mid-queue step    | Step is skipped when script passes; queue advances to next step normally                                                                                        |
| `preCondition.onPass: "skipPrompt"` on `finalStep`         | Loop exits cleanly when script passes (treated as "resolved")                                                                                                   |
| `preCondition.onFail: "skipPrompt"` on a mid-queue step    | Step is skipped when script fails; queue advances to next step normally                                                                                         |
| `preCondition.onFail: "skipPrompt"` on `finalStep`         | Loop exits cleanly when script fails                                                                                                                            |
| `preCondition.onFail: "continue"`                          | Pre-condition result is logged but step runs regardless of failure                                                                                              |
| Workflow-level `preCondition` + prompt-level `preCondition: null` | Prompt-level `null` disables inherited pre-condition (mirrors `endCondition` null behaviour)                                                               |
| `endCondition.onPass: "retry"` with `maxRetries: 5`        | Re-runs the AI prompt up to 5 times while condition passes (e.g., keep implementing backlog items while tests stay green); exhausting retries escalates to `stopWorkflow` |
| `endCondition.onFail: "continue"` with `maxRetries: 3`     | All 3 retries exhausted, then proceeds anyway                                                                                                                   |
| `endCondition.onFail: "retry"` with `maxRetries` unset     | Runtime defaults `maxRetries` to 1 at execution time                                                                                                            |
| `endCondition.onFail: "retry"` with `maxRetries: 0`        | Explicitly zero retries — treated as immediate `stopWorkflow`                                                                                                   |
| `scriptStep` with `returns` but no `compareSource`                | `compareSource` defaults to `"auto"` — `"true"`/`"false"` use exit code, other strings check stdout                                                             |
| `continueOnFailure` in existing working files                     | Treated as unknown field by schema (`additionalProperties: false` on scriptStep) — schema validation warns; users should migrate to `onFail: "continue"` |

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
