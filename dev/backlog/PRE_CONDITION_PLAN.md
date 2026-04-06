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

The same benefit applies to regular queue prompts: a `preCondition` can gate "Generate API
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
prompts:
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
    }
  },
  "required": ["type", "script"],
  "additionalProperties": false
}
```

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
  scriptStep                ← UPDATED: allOf scriptProperties, continueOnFailure→failureAction
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
  if (step.preCondition) {
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

---

## UI Changes

### Validation Tab (Both Panels)

Both `PropertiesDrawer.tsx` (prompt-level) and `WorkflowPropertiesPanel.tsx`
(workflow-level) host the Validation tab. Both need the same updates:

**End Condition section:**

- Add `failureAction` dropdown: Continue / Retry / Stop Workflow (placed after the Script
  field, before the compare/returns row)
- **When `failureAction` is not `"retry"`, hide**: Max Retries, Retry Prompt, and Resume
  Session on Retry — these fields are only meaningful when retrying. This keeps the
  Validation tab clean for the common non-retry cases.
- The existing `failureAction: "retry"` UI state shows all three retry fields as before

**New Pre-Condition section** (below End Condition):

- Enable checkbox: "Enable Pre-Condition"
- Script input field
- Compare Source dropdown (same options as end condition)
- Expected Return input field
- Timeout (ms) input
- Failure Action dropdown: Continue / Skip Prompt / Stop Workflow

The two sections can be separated by a subtle divider. The "Enable" toggles follow the
same pattern as the existing End Condition toggle (grays out fields when disabled).

### Script Step Editor

In `PromptEditor.tsx`, when `stepType === "script"`:

- Replace "Continue on failure" checkbox with a `failureAction` dropdown
  (Continue / Stop Workflow)
- Add Compare Source dropdown
- Add Expected Return input

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

`executionProperties` in `settingsStore` and `WorkflowProperties` gain `preCondition?:
PreCondition | null`.

---

## File Change Summary

| File                                                                 | Change                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemas/prompt-schema.json`                                         | Add `scriptProperties`, `preCondition` definitions; update `endCondition` (allOf scriptProperties, add `failureAction`); update `scriptStep` (allOf scriptProperties, `continueOnFailure`→`failureAction`); add `preCondition` to `executionProperties`                                   |
| `src/types/FlightPathTypes.ts`                                       | Add `ScriptProperties`, `PreCondition`, `PreConditionFailureAction`, `EndConditionFailureAction`, `ScriptStepFailureAction`; update `EndCondition` (add `failureAction`, extend `ScriptProperties`); update `ScriptStep` (`continueOnFailure`→`failureAction`, extend `ScriptProperties`) |
| `src/flightpath/WorkflowExecutor.ts`                                 | Add pre-condition gate before every step dispatch; handle `skipPrompt` on `finalStep` as clean loop exit                                                                                                                                                                                  |
| `src/flightpath/EndConditionHandler.ts`                              | Wire `failureAction` for continue/retry/stop                                                                                                                                                                                                                                              |
| `src/flightpath/EndConditionEvaluator.ts`                            | `ScriptEvaluationConfig` already uses `returns`; shared by all three consumers unchanged                                                                                                                                                                                                  |
| `src/flightpath/WorkflowExecutor.ts` (script step)                   | `continueOnFailure` → `failureAction`; pass `compareSource`/`returns` to evaluator                                                                                                                                                                                                        |
| `src/ui/webview-react/components/editor/PropertiesDrawer.tsx`        | Validation tab: add failureAction dropdown to End Condition, add Pre-Condition section                                                                                                                                                                                                    |
| `src/ui/webview-react/components/layout/WorkflowPropertiesPanel.tsx` | Same Validation tab updates as PropertiesDrawer                                                                                                                                                                                                                                           |
| `src/ui/webview-react/components/editor/PromptEditor.tsx`            | Script step editor: `continueOnFailure` checkbox → `failureAction` dropdown; add compareSource + returns fields                                                                                                                                                                           |
| `src/ui/webview-react/store/settingsStore.ts`                        | Add `preCondition` to `WorkflowProperties` and `executionProperties` shape                                                                                                                                                                                                                |
| `src/ui/webview-react/utils/endCondition.ts`                         | No rename needed; add helpers for preCondition if needed                                                                                                                                                                                                                                  |
| `src/completions/`                                                   | Offer `preCondition` completions in `executionProperties`; add `failureAction` to `endCondition` and `scriptStep` completions; add `compareSource`/`returns` to `scriptStep` completions                                                                                                  |

---

## Edge Cases

| Scenario                                                          | Handling                                                                                                                                                        |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preCondition` on a `type: script` step                           | Fully supported — pre-condition runs before the script step, not just AI prompts                                                                                |
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
