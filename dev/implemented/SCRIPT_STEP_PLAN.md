# Script Step Plan

## Overview

Add a first-class `type: script` step to FlightPath workflows: a queue item that runs a
shell script/command directly with no AI interaction. Script steps can appear anywhere in
the queue and as the final step. This replaces the current workaround of pairing a no-op
prompt with an `endCondition` that always passes.

### `finalStep` → `finalStep` rename

The `finalStep` schema field and `PromptFile.finalStep` type are renamed to
`finalStep` / `PromptFile.finalStep` as part of this work. Since the field can now hold
either an AI prompt or a script step, `finalStep` is a misnomer. Pre-release — no
backward compatibility constraints. The rename is mechanical across ~20 references.

Internal runtime identifiers that describe the AI-specific loop behaviour
(`FinalStepPhase`, `finalStepSessionId`, `finalStepRuntime`, `finalStepAll`,
`finalStepPrevious`) are **not renamed** — they specifically describe the loop mechanism
which only applies to AI final steps.

---

## Scope: `type: script` Only — `postScript` Removed

An earlier draft of this plan included a `postScript` field on AI prompt steps. This has
been **removed** — the hooks system (see `dev/implemented/HOOKS_EXPOSURE_PLAN.md`) already
covers the use cases:

| Need                               | Covered by                                                            |
| ---------------------------------- | --------------------------------------------------------------------- |
| Run formatter after every AI step  | `Stop` hook (fires after AI finishes, before end condition)           |
| Notify on step completion          | Completion notifications feature (`COMPLETION_NOTIFICATIONS_PLAN.md`) |
| Run side-effect after success only | `Stop` hook + check result in script                                  |
| Blocking gate with visible output  | `type: script` step                                                   |
| Per-prompt validation with retries | `endCondition`                                                        |

The one timing distinction — `postScript` fires after end condition passes; `Stop` hook
fires before end condition and on each retry — does not justify the added schema complexity.
Formatters are idempotent (running 3× on retries is fine) and notifications are handled
natively. `postScript` is not built.

---

## Use Cases

- Gate workflow progression on test/build results (`npm test`, `pytest`, `cargo test`)
- Run a linter, type-checker, or build as a blocking step
- Run a cleanup script or CI trigger as the `finalStep`
- Replace the no-op-prompt workaround with clean `type: script` syntax

---

## Schema Design

### Decision: `type` discriminant field (not `harness: "script"`)

`harness` means "which AI execution framework." Adding `"script"` to that enum would be
semantically wrong, pollute `Harness` enum, and break harness availability checks.

`type` is a separate discriminant: "is this an AI step or a script step?" These are
orthogonal concepts. **Option B — `type: "prompt" | "script"` — is the decision.**

### `scriptStep` definition (`schemas/prompt-schema.json`)

```json
"scriptStep": {
  "type": "object",
  "description": "A workflow step that runs a shell script/command with no AI interaction.",
  "properties": {
    "type": { "type": "string", "const": "script" },
    "name": { "type": "string", "maxLength": 100 },
    "script": {
      "type": "string",
      "description": "Shell command or path to script. Resolved relative to workspace root or .flightpath/."
    },
    "timeout": {
      "type": "number",
      "description": "Timeout in milliseconds. Defaults to flightpath.scriptTimeout setting."
    },
    "continueOnFailure": {
      "type": "boolean",
      "default": false,
      "description": "When true, non-zero exit is a warning only — workflow continues."
    }
  },
  "required": ["type", "script"],
  "additionalProperties": false
}
```

`promptItem` becomes a `oneOf` — the existing definition renamed `aiPromptItem`, `prompt`
stays required on it. `type: "prompt"` remains optional (absence = AI prompt, fully
backwards compatible).

`endCondition` is NOT on script steps — exit code 0 is the success condition. The concepts
are inverted: script steps ARE the action; end conditions validate after a separate AI
interaction.

---

## Type System (`src/types/FlightPathTypes.ts`)

```typescript
export type PromptItemType = "prompt" | "script";

/** New script step — no AI harness properties */
export interface ScriptStep {
  type: "script";
  name?: string;
  script: string;
  timeout?: number;
  continueOnFailure?: boolean;
  _runtime?: PromptRuntimeMetadata; // reuse for startedAt/completedAt
}

/** Union type for all workflow steps */
export type WorkflowStep = PromptItem | ScriptStep;

export function isScriptStep(step: WorkflowStep): step is ScriptStep {
  return step.type === "script";
}
```

`PromptFile.prompts`, `PromptFile.finalStep`, `QueueState.prompts`, and
`WorkflowContext` are updated from `PromptItem[]` / `PromptItem` to `WorkflowStep[]` /
`WorkflowStep`.

---

## Execution Architecture

### `WorkflowExecutor` routing

```typescript
if (isScriptStep(step)) {
  return this.executeScriptStep(step, stepIndex);
} else {
  return this.executeAiPrompt(step, stepIndex); // unchanged
}
```

### `executeScriptStep(step, stepIndex)`

No harness involvement. Reuses `EndConditionEvaluator` infrastructure:

1. Emit `STEP_STATUS_CHANGED` → `"running"`
2. Write `startedAt` to working file `_runtime`
3. Spawn child process via `EndConditionEvaluator.evaluate({ script: step.script, returns: "0", timeout })`
4. **Stream stdout/stderr** progressively to the Output panel as `DashboardOutput` entries with `source: "script"` — do not batch until process exits
5. On exit code 0 → `STEP_STATUS_CHANGED` → `"completed"`, advance queue
6. On non-zero exit:
   - `continueOnFailure: true` → `"completed"` with warning badge, advance queue
   - `continueOnFailure: false` (default) → `"failed"`, stop workflow

No session tracking, no MCP config, no `PropertyResolver` call — none of the AI execution
machinery applies.

### `PropertyResolver` bypass

`PropertyResolver.resolve()` is not called for script steps. Script commands are used
verbatim (with `{{var}}` substitution from the existing variable substitution pipeline,
consistent with how prompt text is handled).

### `EndConditionHandler` refactor

Extract a reusable `evaluateScript(script, timeout)` helper shared by:

- `endCondition` evaluation (existing)
- `executeScriptStep()` (new)

The retry loop in `EndConditionHandler` does NOT apply to script steps — they run once,
success determined by exit code alone.

---

## Dashboard / UI

### EditorSection — no new tabs

The OutputSection has Output/Terminal tabs to switch between two _views of output_.
Step type is a _property of the step being edited_ — a different concept. **No tab is
added to EditorSection's header.**

Instead: a **segmented control ("Prompt | Script")** at the top of the editor content
area inside `PromptEditor`. Visible when creating a new step or editing an existing one.

### When "Script" is selected in PromptEditor

- CodeMirror editor is hidden
- `PropertiesDrawer` and its footer tab bar (`DrawerTabBar`) are hidden entirely — no
  harness/model/session/agent properties apply to script steps
- The editor content area shows three fields:
  - **Script command** — single-line text input (or minimal CodeMirror with shell syntax)
  - **Timeout** — number input (ms), placeholder showing inherited default
  - **Continue on failure** — checkbox with label
- `EditorFooter` action buttons (Add / Update / Cancel / Delete) are identical to prompt
  steps — same CRUD controls
- All 6 footer quick pickers (Harness, Model, Agent, Skills, Permissions, Context) and
  the DrawerTabBar are hidden — none of their properties apply to script steps
- The token count in `EditorSection`'s header is hidden for script steps (token count
  lives in the section header, not the footer)

### `editorStore` additions

`editorStore` needs two new fields alongside `promptText`:

- `stepType: "prompt" | "script"` — determines which editor mode renders
- `scriptCommand: string` — the script field value for script steps

When a script step is selected for editing, `scriptCommand` is populated; `promptText` is
cleared. When switching type via the segmented control, both fields reset.

### Prompts list (`PromptItem` component)

Script steps render a distinct variant in the list:

- Terminal icon instead of text preview
- `Script` badge (grey/neutral) where harness badge normally appears
- Command text as subtitle (`npm test`) instead of truncated prompt text
- No model badge, no session badge
- Status icons, drag handle, and start-position controls are identical to prompt steps

The component accepts a new `stepType?: "prompt" | "script"` prop (or a `scriptCommand`
prop). `PromptsPanel` passes the appropriate data when iterating `WorkflowStep[]`.

### `workflowStore` update

`workflowStore.prompts` is typed as `WorkflowStep[]`. Components reading prompt text for
display guard with `isScriptStep()` before accessing `step.prompt`.

### Output panel rendering

Script step output renders in the **Output tab** (not Terminal tab — that's for AI CLI
PTY sessions). A `source: "script"` marker on `DashboardOutput` entries triggers
simplified rendering: plain stdout/stderr text with an exit code summary line. No tool
call events, no thinking blocks, no structured events.

### `FinalStepFooter`

Checks `isScriptStep(finalStep)` → renders `"Final Script"` label and Script badge
instead of harness/model info.

### `EditorSection` mode text

`getModeText()` currently returns `"Editing: Final Prompt"` for the final prompt phase.
Must return `"Editing: Final Script"` when `stepType === "script"` and the selection
target is `FINAL_PROMPT_PHASES.FINAL_PROMPT`.

### Type switching mid-edit (Prompt → Script)

When the user switches the segmented control from Prompt to Script while the
`PropertiesDrawer` is open, the drawer must close and `drawerActivePage` reset to the
default tab. `PromptEditor` should call `closePropertiesDrawer()` on type change.
Conversely, switching Script → Prompt should not auto-open the drawer.

---

## `WorkingFileManager` update

`WorkingFileManager` serializes `PromptItem[]` today. After this change it must handle
`WorkflowStep[]` — specifically preserve `type: "script"` and `script` fields through
disk write/read cycles without stripping unknown keys.

---

## IntelliSense (`src/completions/`)

When `type: script` is present in a prompt item:

- Suppress AI-only completions: `harness`, `model`, `agent`, `skills`, `resumeSession`,
  `sessionId`, `allowDynamicExtension`, `endCondition`, `prompt`
- Offer script-specific completions: `script`, `timeout`, `continueOnFailure`

---

## YAML Examples

### Inline script gate

```yaml
prompts:
  - name: implement
    prompt: Implement the feature in #file:spec.md
    harness: claude-cli

  - name: run-tests
    type: script
    script: npm test

  - name: fix-tests
    prompt: Tests are failing. Fix them.
    harness: claude-cli
    resumeSession: true

  - name: format
    type: script
    script: npm run format
    continueOnFailure: true # formatter failure is non-blocking
```

### Script as `finalStep`

Note: `finalStep` is renamed to `finalStep` in this work. A script `finalStep` runs
**exactly once** — the AI loop mechanism (`FinalStepPhase`, `loopCount`) is bypassed.

```yaml
prompts:
  - name: implement
    prompt: Implement the feature.

finalStep:
  type: script
  script: npm run notify
```

### No-op prompt replacement

```yaml
# BEFORE (workaround)
- prompt: "just say hi"
  endCondition:
    script: npm test
    returns: "true"

# AFTER (clean)
- type: script
  script: npm test
```

---

## File Change Summary

| File                                                          | Change                                                                                                                                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemas/prompt-schema.json`                                  | Add `scriptStep`; `promptItem` → `oneOf`; rename existing to `aiPromptItem`; rename `finalStep` → `finalStep`                                                                             |
| `src/types/FlightPathTypes.ts`                                | Add `ScriptStep`, `WorkflowStep`, `isScriptStep()`; rename `PromptFile.finalStep` → `finalStep`; update `QueueState`                                                                      |
| `src/types/WebviewMessageTypes.ts`                            | Rename `finalStep` → `finalStep` in all message types; `finalStep?: PromptItem` → `finalStep?: WorkflowStep` (~6 message interfaces)                                                      |
| `src/types/WorkflowContextTypes.ts`                           | Guard `finalStepSessionId` — only populated when finalStep is an AI prompt                                                                                                                |
| `src/types/DashboardConstants.ts`                             | Add `STEP_TYPES`; add `STEP_TYPE`, `SCRIPT`, `CONTINUE_ON_FAILURE` to `PROMPT_PROPERTIES`                                                                                                 |
| `src/flightpath/WorkflowExecutor.ts`                          | Route `isScriptStep` → `executeScriptStep()`; rename `executeFinalStep` → `executeFinalStep()`; bypass loop mechanism for script finalStep; streaming output                              |
| `src/flightpath/PromptFileParser.ts`                          | Validate `scriptStep` via AJV; type narrowing after parse; parse `finalStep` field                                                                                                        |
| `src/flightpath/PromptQueue.ts`                               | `prompts` typed as `WorkflowStep[]`; `finalStep` accessors → `finalStep`                                                                                                                  |
| `src/flightpath/PropertyResolver.ts`                          | Bypass for script steps; `{{var}}` substitution still applies to `script` field                                                                                                           |
| `src/flightpath/EndConditionHandler.ts`                       | Extract `evaluateScript()` helper shared by end conditions and script steps                                                                                                               |
| `src/flightpath/WorkingFileManager.ts`                        | Serialize/deserialize `WorkflowStep[]`; rename `finalStep` → `finalStep` in working file format                                                                                           |
| `src/ui/webview-react/store/editorStore.ts`                   | Add `stepType`, `scriptCommand` fields; close PropertiesDrawer on type switch                                                                                                             |
| `src/ui/webview-react/store/workflowStore.ts`                 | `prompts: WorkflowStep[]`; `finalStep` → `finalStep`; guard script step fields at access sites                                                                                            |
| `src/ui/webview-react/components/editor/PromptEditor.tsx`     | Segmented Prompt/Script control; conditional editor UI; close drawer on type switch to Script                                                                                             |
| `src/ui/webview-react/components/editor/EditorFooter.tsx`     | When `stepType === "script"`: hide all 6 quick pickers (Harness, Model, Agent, Skills, Permissions, Context) and the DrawerTabBar — only action buttons (Add/Update/Cancel/Delete) remain |
| `src/ui/webview-react/components/layout/EditorSection.tsx`    | `getModeText()` returns `"Editing: Final Script"` / `"New Script"` for script steps; hide token count display (rendered in this header, not in the footer)                                |
| `src/ui/webview-react/components/prompts/PromptItem.tsx`      | Script step variant (terminal icon, Script badge, command subtitle)                                                                                                                       |
| `src/ui/webview-react/components/prompts/PromptsPanel.tsx`    | Iterate `WorkflowStep[]`; pass `stepType` to `PromptItem`                                                                                                                                 |
| `src/ui/webview-react/components/prompts/FinalStepFooter.tsx` | `isScriptStep` check → `"Final Script"` label                                                                                                                                             |
| `src/ui/webview-react/components/output/CliOutput.tsx`        | `source: "script"` → simplified rendering                                                                                                                                                 |
| `src/completions/`                                            | Suppress AI completions / offer script completions when `type: script`                                                                                                                    |

---

## Edge Cases

| Scenario                                          | Handling                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type: script` with `harness`, `model`, etc.      | Schema validation error (`additionalProperties: false`)                                                                                                                                                                                                                                                                                                                                                                                             |
| `type: script` with no `script` field             | Schema validation error (`required`)                                                                                                                                                                                                                                                                                                                                                                                                                |
| Script step as only item in queue                 | Executes normally; no AI harness interaction occurs                                                                                                                                                                                                                                                                                                                                                                                                 |
| **All steps are `type: script`**                  | Works correctly — scripts run in order, no AI harness interaction. However, `WorkflowOrchestrator` currently initializes the harness eagerly before any steps run. For scripts-only workflows this is wasted work; if the configured harness CLI isn't installed it may log spurious errors. Proper fix is lazy harness initialization (initialize only when the first AI step is dispatched). Non-blocking for this feature but worth a follow-up. |
| `resumeSession: true` on step after a script step | Resumes from last _AI_ step's session; script step has no session                                                                                                                                                                                                                                                                                                                                                                                   |
| Non-zero exit, `continueOnFailure: false`         | Step fails, workflow stops                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Non-zero exit, `continueOnFailure: true`          | Step completes with warning badge, workflow continues                                                                                                                                                                                                                                                                                                                                                                                               |
| Script step as `finalStep`                        | `executeFinalStep()` routes through `executeScriptStep()`                                                                                                                                                                                                                                                                                                                                                                                           |
| `{{var}}` in script command                       | Substituted by existing variable pipeline before execution                                                                                                                                                                                                                                                                                                                                                                                          |
| Script step as `finalStep` (loop)                 | The AI loop mechanism (`FinalStepPhase`, `loopCount`, `finalStepAll`/`Previous`) is bypassed entirely. `executeFinalStep()` calls `executeScriptStep()` once and the workflow completes. `finalStepSessionId` is not populated.                                                                                                                                                                                                                     |
| `enabled` on a script step (future)               | `ScriptStep` has `additionalProperties: false` — adding `enabled` (from `CONDITIONAL_STEPS_PLAN`) requires a schema update to `scriptStep`. This is a known future touch point; add `enabled?: boolean \| string` to `scriptStep` when that plan is implemented.                                                                                                                                                                                    |

---

## Not In Scope

- `postScript` field on AI prompt steps — covered by hooks (`Stop` event) and the completion notifications feature
- `returns` / output-matching success conditions — exit code 0 + `continueOnFailure` covers all cases
- `maxRetries` / `retryScript` — retrying a script without a recovery action between retries is pointless
- Async/parallel script steps
- Script output piped into next prompt context (use `{{var}}` + a script that writes to a file instead)
- Shell selector (`bash` vs `powershell`) — use existing `EndConditionEvaluator` behavior
- Environment variable injection (set them in the script itself)
