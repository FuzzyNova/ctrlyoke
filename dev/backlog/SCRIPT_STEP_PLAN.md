# Script Step Plan

## Overview

Add a first-class "script step" to FlightPath workflows: a prompt item that runs a shell
script/command directly — no AI interaction. Script steps can appear anywhere in the queue
and as the `finalPrompt`. This replaces the current workaround of pairing a no-op prompt
with an `endCondition` that always passes.

---

## Use Cases

**Script steps** (`type: script`) — a queue item that IS a script, not an AI interaction:
- Gate workflow progression on test/build results (`npm test`, `pytest`, etc.)
- Run a script at a specific point in the queue with its own output block and step number
- Have the `finalPrompt` be a script (e.g., post-workflow cleanup or CI trigger)

**`postScript`** — a hook that runs after every AI prompt's end condition passes:
- Run a formatter after every AI step (`npm run format`, `prettier --write .`)
- Send a notification after every prompt completes
- Any side-effect that should happen consistently without being a queue gate

---

## Schema Design Decision: `type` Field vs. `harness: "script"`

### Option A — `harness: "script"` (new harness value)

Add `"script"` to the `harness` enum.

**Pro:** Fits the existing 3-tier precedence model; reuses the harness selector dropdown.
**Con:** Semantically wrong — "harness" means AI execution framework. `harness: "script"` implies
a script-based AI framework, which is confusing. Pollutes `Harness` enum and `HARNESS_IDS`
with a non-AI concept. Would break harness availability checks and CLI composition.

### Option B — `type: "prompt" | "script"` (discriminant field) ✅ RECOMMENDED

Add a `type` discriminant to `PromptItem`. Default is `"prompt"` (backwards compatible).
When `type === "script"`, the `prompt` field is replaced by `script`.

**Pro:** Semantically clean. The step kind and the AI framework are orthogonal concepts.
No AI harness properties (`harness`, `model`, `agent`, `skills`, `resumeSession`,
`sessionId`, `allowDynamicExtension`) apply to script steps — they are simply ignored
(or schema-validated away). Clear UI affordance: step type is distinct from harness.
**Con:** More invasive schema change; `prompt` required-ness becomes conditional.

**Decision: Option B.** The `harness` field answers "which AI to use"; `type` answers "is
this an AI step or a script step?" These are separate concerns.

---

## Schema Changes (`schemas/prompt-schema.json`)

### New `scriptStep` definition

```json
"scriptStep": {
  "type": "object",
  "description": "A workflow step that runs a shell script/command directly with no AI interaction.",
  "properties": {
    "type": {
      "type": "string",
      "const": "script",
      "description": "Marks this step as a script execution step (no AI harness)."
    },
    "name": {
      "type": "string",
      "description": "Optional display label shown in the FlightPath dashboard.",
      "maxLength": 100
    },
    "script": {
      "type": "string",
      "description": "Shell command or path to script file to execute. Resolved relative to workspace root or .flightpath directory."
    },
    "timeout": {
      "type": "number",
      "description": "Timeout in milliseconds. Defaults to flightpath.scriptTimeout setting."
    },
    "continueOnFailure": {
      "type": "boolean",
      "description": "When true, a non-zero exit code is shown as a warning in the dashboard but does NOT fail the workflow. Use for formatters, notifiers, and other side-effect scripts where failure is acceptable.",
      "default": false
    }
  },
  "required": ["type", "script"],
  "additionalProperties": false
}
```

### Changes to `promptItem`

`promptItem` becomes a `oneOf` between the existing prompt object and the new `scriptStep`:

```json
"promptItem": {
  "oneOf": [
    { "$ref": "#/definitions/aiPromptItem" },
    { "$ref": "#/definitions/scriptStep" }
  ]
}
```

The existing `promptItem` definition is renamed `aiPromptItem` (no functional change, just
renamed). `prompt` remains required on `aiPromptItem`. `type: "prompt"` is optional
(backwards compatible — its absence means AI prompt).

**Note:** `endCondition` is NOT reused for script steps. Script steps ARE the action; they
don't validate after a separate AI interaction. The semantics are inverted. Success is
determined solely by exit code 0.

### `postScript` on `aiPromptItem` and workflow root

`postScript` is a string field added to `ExecutionProperties` (workflow root + per-prompt).
It follows the existing 3-tier precedence model — same as `harness`, `model`, `endCondition`.

```json
"postScript": {
  "type": ["string", "null"],
  "description": "Shell command to run after this prompt's end condition passes. Runs as a non-blocking side effect — failure is shown as a warning but does not stop the workflow. Set to null at the prompt level to disable an inherited workflow-level postScript."
}
```

**Key properties:**
- Added to `ExecutionProperties` — inherits at workflow level, overridable per prompt
- `postScript: null` at prompt level disables an inherited workflow-level `postScript` (same pattern as `endCondition: null`)
- Always non-blocking — failure is a warning, never a workflow stop (unlike `type: script` which is blocking by default)
- Does NOT apply to `type: script` steps — they have no end condition to hook into
- Runs **after** end condition passes (or immediately after the AI prompt completes if no end condition is set)
- `postScript` is NOT available on `scriptStep` — `additionalProperties: false` on `scriptStep` enforces this

---

## Type System Changes (`src/types/FlightPathTypes.ts`)

```typescript
/** Step type discriminant */
export type PromptItemType = "prompt" | "script";

// Add to ExecutionProperties (inherited by PromptFile and PromptItem):
export interface ExecutionProperties {
  // ... existing fields ...
  /**
   * Shell command to run after this prompt's end condition passes.
   * Always non-blocking — failure is a warning, never stops the workflow.
   * Set to null at the prompt level to disable an inherited workflow-level postScript.
   */
  postScript?: string | null;
}

/** Existing PromptItem (AI prompt) — `type` defaults to "prompt" */
export interface PromptItem extends ExecutionProperties {
  type?: "prompt";          // optional, absence = "prompt"
  name?: string;
  prompt: string;
  sessionId?: string | number;
  _runtime?: PromptRuntimeMetadata;
}

/** New script step — no AI harness properties apply */
export interface ScriptStep {
  type: "script";
  name?: string;
  script: string;
  timeout?: number;
  /** When true, non-zero exit is a warning only — workflow continues regardless. */
  continueOnFailure?: boolean;
  _runtime?: PromptRuntimeMetadata;  // reuse for startedAt/completedAt
}

/** Union: either an AI prompt step or a script step */
export type WorkflowStep = PromptItem | ScriptStep;

/** Type guard */
export function isScriptStep(step: WorkflowStep): step is ScriptStep {
  return step.type === "script";
}
```

`PromptFile.prompts` and `PromptFile.finalPrompt` become `WorkflowStep[]` / `WorkflowStep`.
`QueueState.prompts` becomes `WorkflowStep[]`. All consumers that currently receive
`PromptItem[]` are updated to `WorkflowStep[]`.

---

## Execution Architecture

### `WorkflowExecutor` routing

```typescript
// In executePrompt():
if (isScriptStep(step)) {
  return this.executeScriptStep(step, stepIndex);
} else {
  return this.executeAiPrompt(step, stepIndex);  // existing path
}
```

### `executeScriptStep(step, stepIndex)`

No harness involvement. Directly uses `EndConditionEvaluator`:

1. Emit `STEP_STATUS_CHANGED` → `"running"`
2. Update working file `_runtime` with `startedAt`
3. Call `EndConditionEvaluator.evaluate({ script: step.script, returns: "0", timeout: step.timeout })` — success = exit code 0
4. Capture stdout/stderr into a synthetic `DashboardOutput` so the output panel shows
   script output (same shape as CLI output but with a `"script"` source marker)
5. On success (exit 0) → `STEP_STATUS_CHANGED` → `"completed"`, advance queue
6. On failure (non-zero exit):
   - If `continueOnFailure: true` → `STEP_STATUS_CHANGED` → `"completed"` with a warning badge, advance queue
   - Otherwise → `STEP_STATUS_CHANGED` → `"failed"`

**No session tracking, no MCP config, no agent/model resolution** for script steps.

### `postScript` execution (in `executeAiPrompt`)

After the AI prompt completes and its end condition passes (or immediately on completion if no end condition), `WorkflowExecutor` checks for a resolved `postScript`:

```typescript
const resolvedPostScript = PropertyResolver.resolve(step, workflowFile).postScript;
if (resolvedPostScript != null) {
  await this.runPostScript(resolvedPostScript, step.timeout);
}
```

`runPostScript(script, timeout)`:
1. Calls `EndConditionEvaluator.evaluate({ script, returns: "0", timeout })` — reuses same infrastructure as script steps
2. On failure: emits a `STATUS_MESSAGE` with `severity: "warning"` (e.g., "postScript exited with code 1") — does NOT fail the step or stop the workflow
3. Output is appended to the current step's output block (not a new step)

`postScript` is resolved by `PropertyResolver` like any other `ExecutionProperties` field — prompt-level overrides workflow-level; `null` explicitly disables inheritance.

### `PropertyResolver` bypass

`PropertyResolver.resolve()` is not called for script steps — there are no AI execution
properties to resolve. `EndConditionEvaluator` is called directly.

---

## Dashboard / UI Changes

### Step list rendering

Script steps render differently from AI prompt steps. Instead of showing harness/model
pills, they show:

```
[terminal icon]  Run tests                    Script
                 npm test
```

- No harness badge, no model badge, no session badge
- A "Script" type badge (grey/neutral) in the top-right where harness normally appears
- The script command is shown as the subtitle (like prompt text preview)
- Status icons/colors are identical to AI prompt steps

### Prompt editor (CodeMirror panel)

When creating or editing a step, a **Step Type** selector appears at the top of the
settings panel (above harness/model):

```
Step Type:  [ AI Prompt ▼ ]   or   [ Script ▼ ]
```

When "Script" is selected:
- The CodeMirror prompt textarea is replaced with a single-line (or multi-line) script
  command input
- All AI-specific settings (harness, model, agent, skills, resumeSession, etc.) are hidden
- Script-specific settings appear: Script command, Timeout, Continue on failure (checkbox)

When "AI Prompt" is selected:
- Normal prompt editor with all AI settings (current behavior)

### `finalPrompt` footer

`FinalPromptFooter` checks `isScriptStep(finalPrompt)` and renders a "Script" badge
instead of harness/model info. The label shows "Final Script" instead of "Final Prompt".

### Dashboard constants additions

```typescript
// DashboardConstants.ts
export const STEP_TYPES = {
  PROMPT: "prompt",
  SCRIPT: "script",
} as const;
export type StepType = (typeof STEP_TYPES)[keyof typeof STEP_TYPES];

// PROMPT_PROPERTIES additions
STEP_TYPE: "type",
SCRIPT: "script",
CONTINUE_ON_FAILURE: "continueOnFailure",
POST_SCRIPT: "postScript",
```

---

## YAML Authoring UX

### Inline queue step

```yaml
prompts:
  - name: Implement feature
    prompt: |
      Implement the feature described in #file:spec.md
    harness: claude-cli

  - name: Run tests
    type: script
    script: npm test

  - name: Fix failing tests
    prompt: |
      Tests are failing. Review the output and fix them.
    harness: claude-cli
    resumeSession: true

  - name: Format code
    type: script
    script: npm run format
    continueOnFailure: true   # formatter failure is non-blocking

  - name: Verify coverage
    type: script
    script: npm run coverage
```

### `postScript` — run a command after every AI prompt

```yaml
harness: claude-cli
postScript: npm run format   # runs after every prompt's end condition passes

prompts:
  - name: Implement feature
    prompt: |
      Implement the feature described in #file:spec.md

  - name: Add tests
    prompt: |
      Write tests for the feature.
    postScript: npm run format && npm run lint   # override: different script for this step

  - name: Final cleanup
    prompt: |
      Review and clean up the implementation.
    postScript: null   # disable inherited postScript for this step
```

### `postScript` + `type: script` together

```yaml
postScript: npm run format   # side-effect after every AI step

prompts:
  - prompt: Implement the feature
    harness: claude-cli
    # → runs AI, then runs "npm run format" (warning-only if it fails)

  - type: script
    script: npm test
    # → runs npm test as a blocking gate; postScript does NOT apply to script steps

  - prompt: Fix failing tests
    harness: claude-cli
    resumeSession: true
    # → runs AI, then runs "npm run format"
```

### Script as `finalPrompt`

```yaml
prompts:
  - prompt: Implement the feature

finalPrompt:
  type: script
  script: npm run notify
```

### No-op prompt replacement

The current workaround:
```yaml
# BEFORE (workaround)
- prompt: just say hi
  endCondition:
    script: npm test
    returns: "true"
```

Becomes:
```yaml
# AFTER (clean)
- type: script
  script: npm test
```

---

## IntelliSense (`src/completions/`)

The YAML/JSON completion providers need to:
- Offer `type: script` as an option when inside a prompt item
- When `type: script` is detected, suppress AI-only completions (`harness`, `model`, `agent`,
  `skills`, `resumeSession`, `sessionId`, `allowDynamicExtension`, `endCondition`, `prompt`)
- Instead offer: `script`, `timeout`, `continueOnFailure`

---

## Output History

Script step output is stored identically to AI prompt output via `OutputHistoryManager`.
The synthetic `DashboardOutput` carries:
- `source: "script"` (new field, optional, for display differentiation)
- `rawTextOutput: true` (script stdout/stderr as plain text)
- No structured events (no file edits, tool calls, etc.)

The output panel renders script output in a simpler format — no tool call events, no
thinking blocks. Just stdout/stderr text with an exit code summary line.

---

## File Change Summary

| File | Change |
|---|---|
| `schemas/prompt-schema.json` | Add `scriptStep` definition; `promptItem` becomes `oneOf`; add `postScript` to `executionProperties` |
| `src/types/FlightPathTypes.ts` | Add `postScript?: string \| null` to `ExecutionProperties`; add `ScriptStep`, `WorkflowStep` union, `isScriptStep()` guard; update `PromptFile`, `QueueState`, `WorkflowContext` |
| `src/types/DashboardConstants.ts` | Add `STEP_TYPES`, `StepType`; add `STEP_TYPE`, `SCRIPT`, `CONTINUE_ON_FAILURE`, `POST_SCRIPT` to `PROMPT_PROPERTIES` |
| `src/flightpath/WorkflowExecutor.ts` | Route `isScriptStep` to `executeScriptStep()`; add `runPostScript()` call in `executeAiPrompt()` after end condition passes |
| `src/flightpath/PromptFileParser.ts` | Validate `scriptStep` via AJV; type narrowing after parse |
| `src/flightpath/PromptQueue.ts` | `prompts` array typed as `WorkflowStep[]` |
| `src/flightpath/PropertyResolver.ts` | Skip resolution for script steps; resolve `postScript` for AI prompts |
| `src/flightpath/EndConditionHandler.ts` | Extract reusable `evaluateScript()` helper (shared by `endCondition`, script steps, and `postScript`) |
| `src/ui/webview-react/components/prompts/PromptItem.tsx` | Render script step variant (terminal icon, Script badge, command preview); show `postScript` indicator on AI prompt items that have one |
| `src/ui/webview-react/components/prompts/PromptEditor.tsx` | Add Step Type selector; swap editor UI based on type; add `postScript` field to AI prompt settings |
| `src/ui/webview-react/components/prompts/FinalPromptFooter.tsx` | Handle `isScriptStep(finalPrompt)` → show Script badge |
| `src/ui/webview-react/components/output/CliOutput.tsx` | Handle `source: "script"` for simplified rendering |
| `src/completions/` | Suppress/replace AI completions when `type: script` detected; offer `postScript` for AI prompt items |

---

## Edge Cases

| Scenario | Handling |
|---|---|
| `type: script` with `harness`, `model`, etc. | Schema validation error (additionalProperties: false on `scriptStep`) |
| `type: script` with no `script` field | Schema validation error (required) |
| Script step as only item in queue | Executes normally; no AI harness spun up |
| Script step mid-queue with `resumeSession` next | `resumeSession` applies to the *AI* prompt only; script step has no session |
| Script exits non-zero, `continueOnFailure: false` (default) | Step fails, workflow stops |
| Script exits non-zero, `continueOnFailure: true` | Step completes with warning badge, workflow continues |
| Script step as `finalPrompt` | `WorkflowExecutor.executeFinalPrompt()` routes through `executeScriptStep` |
| `postScript` on a `type: script` step | Schema error — `additionalProperties: false` on `scriptStep` rejects it |
| `postScript` fails | Warning status message emitted; step still marked `completed`; workflow continues |
| `postScript: null` at prompt level | Disables inherited workflow-level `postScript` for that step (mirrors `endCondition: null`) |
| `postScript` + `endCondition` together | End condition runs first (with retries); `postScript` runs only after end condition passes |
| `postScript` when no end condition | Runs immediately after AI prompt completes |
| Undo changes for script step | Script steps are not AI-driven; no file events. Workspace snapshot still captures any filesystem mutations. Undo dialog works via Tier 2 snapshot only. |
| Undo changes after `postScript` ran | `postScript` filesystem changes captured in Tier 2 snapshot, attributed to the enclosing AI prompt step |

---

## Not In Scope (YAGNI)

- `returns` / output-matching success conditions — exit code 0 + `continueOnFailure` covers all v1 use cases
- `maxRetries` / `retryScript` — retrying the same script against the same state is pointless without a distinct success condition or a recovery action between retries
- Async/parallel script steps
- Script step output piped to next prompt context
- `stdin` input to script steps
- Script steps as `endCondition` replacement (they are separate concepts)
- Environment variable injection (users can set them in the script itself)
- Shell selector (`bash` vs `powershell`) — use existing EndConditionEvaluator behavior
