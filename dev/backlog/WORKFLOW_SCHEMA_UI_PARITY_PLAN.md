# Workflow Schema → UI Parity Plan

> **Status:** Schema cleanup landed; UI parity work not started. Audit complete
> and verified against the code (2026-08-19).
> **Priority:** P0 — the property-preservation question is answered and the
> answer is **confirmed silent data loss**: saving a script step through the
> dashboard, or toggling one enabled/disabled from the context menu, deletes
> `env`, `secrets`, `errorBehavior` (and, on the toggle, `executionMode`). Fix
> that before adding any control below.
> **Origin:** A user who authors workflows **exclusively through the dashboard**
> hit a hard failure caused by `${secret:NAME}` in an MCP env map, and could not
> resolve it because the field that fixes it (`secrets`) is not reachable from
> the UI. Schema-only properties are invisible to a UI-only author.

## Problem

`schemas/workflow-schema.json` is the source of truth for what a workflow can
express, but it is not the surface most users author through. Properties have
been added to the schema (and to the CLI, and to the runtime) without a
corresponding control in the dashboard, so a dashboard-only user cannot reach
them, cannot discover them, and — for at least one class of failure — cannot
recover from an error the runtime raises about them.

This is not a cosmetic gap. `secrets` is required to resolve the hard failure
in `OVERZEALOUS_STEP_FAILURES_PLAN.md` item 3, and for a **script step** it is
the _only_ way to resolve it (script steps have no prompt, so the inline
`!NAME` gesture does not exist). A UI-only author hitting that failure on a
script step is stuck with no path forward inside the product.

## Answered — saving a step through the UI DELETES properties it cannot edit

**Verified 2026-08-19 by driving the real persistence pipeline** (the
`propertyRoundTrip` integration harness: `UPDATE_PROMPT` →
`WorkflowOrchestrator` → `WorkingFileManager` → disk) with the exact payloads
the editor posts. This is a **data-loss bug, not a discoverability gap**, and it
is worse than the original suspicion: one of the fields destroyed
(`executionMode`) is one the UI _can_ edit.

### The split: prompt steps merge, script steps are replaced

`WorkflowInstance.updatePromptInQueue` (`src/core/WorkflowInstance.ts:2678-2695`)
and its static twin `buildPromptStepChange` (`src/core/WorkflowOrchestrator.ts:186-206`)
branch on `properties.type`:

| Step kind | Path                                                            | Result                                                 |
| --------- | --------------------------------------------------------------- | ------------------------------------------------------ |
| Prompt    | `PromptQueue.updatePrompt` → `{ ...existing, ...updates }`      | **Safe.** Unknown properties survive.                  |
| Script    | `PromptQueue.replaceStep` / `nextSteps[index] = change.replace` | **Lossy.** The step is rebuilt from the payload alone. |

The replace is deliberate and correct in itself — the comment at
`WorkflowInstance.ts:2686` explains it, and it is what makes a prompt→script type
change clean. The bug is that the _editor's payload_ is an incomplete
enumeration, so "replace" means "delete everything the editor forgot".

### Measured, seeded step vs. saved step

Seeded a run with a fully-populated script step, then routed the payload
`PromptEditor.handleUpdate` posts when the user changes nothing but the command:

```jsonc
// on disk before
{
  "type": "script",
  "script": "npm run deploy",
  "name": "Deploy",
  "env": { "DEPLOY_TOKEN": "${secret:DEPLOY_TOKEN}" },
  "secrets": ["DEPLOY_TOKEN"],
  "errorBehavior": { "onError": "continue", "maxRetries": 2 },
  "executionMode": "headless",
  "timeout": 60000
}

// on disk after pressing Update
{
  "type": "script",
  "script": "npm run deploy",
  "executionMode": "headless",
  "name": "Deploy",
  "timeout": 60000
}
```

`env`, `secrets`, and `errorBehavior` are gone. A working workflow becomes the
`OVERZEALOUS_STEP_FAILURES_PLAN.md` item-3 hard failure, caused by opening the
step and pressing save.

### Worse: the enable/disable toggle drops `executionMode` too

`buildWorkflowStepEnabledUpdate` (`src/ui/webview-react/utils/stepClipboard.ts:62-83`)
re-enumerates a script step from the step object and carries only `timeout`,
`compareSource`, `returns`, `onPass`, `onFail`. Right-clicking a script step and
toggling Disable/Enable produced:

```json
{
  "type": "script",
  "script": "npm run deploy",
  "name": "Deploy",
  "enabled": false,
  "timeout": 60000
}
```

`env`, `secrets`, `errorBehavior` **and `executionMode`** destroyed — by a
context-menu gesture that never opens an editor, on a field the dashboard
itself authors. This one is a plain bug independent of the parity work.

### Full matrix, measured

`src/test/integration/schemaUiPropertyRoundTrip.integration.test.ts` enumerates
every user-authorable property in `schemas/workflow-schema.json` and drives it
through the real persistence pipeline on five surfaces, in both directions:
**preservation** (a save that does not mention the property must not delete it)
and **acceptance** (a property present in the payload must land on disk). 140
checks. Result:

| Surface                          | Preservation    | Acceptance      |
| -------------------------------- | --------------- | --------------- |
| Workflow root (18 props)         | all pass        | all pass        |
| Prompt step (16 props)           | all pass        | `secrets` fails |
| Script step (9 props)            | **all 9 fail**  | all pass        |
| `finalStep` as prompt (16 props) | **all 16 fail** | `secrets` fails |
| `finalStep` as script (9 props)  | **all 9 fail**  | all pass        |

Two things this makes precise that reading the code did not:

- **`finalStep` is worse than the step list.** It is written as one whole
  property, so the stored step is only ever as complete as the editor's outgoing
  object — _every_ execution property is unprotected, not just the ones with no
  control. A prompt final step survives today only because the drawer happens to
  round-trip its own state into the payload.
- **The script-step builders are already complete.** Every script property
  passes acceptance, so `buildScriptStepFromProperties` knows every key in the
  schema. The 18 script failures are purely replace-vs-merge plus incomplete
  payloads — one merge fix closes all of them without touching the builder.

Two narrower losses live in the webview payload builders rather than the
persistence layer, and are pinned by `it.fails` guards in
`src/ui/webview-react/test/utils/stepClipboard.test.ts`:
`buildWorkflowStepEnabledUpdate` (the context-menu toggle) and
`buildWorkflowStepEnabledState` (the final-step toggle, which routes through
`sanitizeClipboardWorkflowStep` — whose script branch omits `secrets` while its
prompt branch includes it).

### `secrets` on a prompt step needs a backend change, not just a control

`buildPromptStepProperties` (`WorkflowStepSanitizer.ts:605-676`) has no `secrets`
case. Today that is harmless — the merge preserves an existing value — but it
means adding the drawer control from step 2 below **will not persist** until
`secrets` is added to that builder. The same is true of `vars`. Confirmed: a
prompt step carrying `secrets` and `vars` survived a drawer save untouched, and
a `model` override applied alongside them.

### Fix direction

Make the script path stop rebuilding from an enumeration. The narrow fix is to
merge `buildScriptStepFromProperties` over the existing step when the existing
step is already a script step, replacing only on a genuine type change — that
closes every caller at once (editor save, context toggle, and the static
`updateStepAtRun` path) instead of patching each payload builder. `finalStep`
needs the same treatment: merge against what is on disk rather than writing the
editor's object whole.

The verification is already in place. Every failing pair is listed in
`KNOWN_LOSSY_PRESERVATION` / `KNOWN_UNACCEPTED` in the round-trip suite, and each
entry is asserted to _still_ fail — so fixing one turns the suite red until the
entry is deleted. The lists can only shrink. A schema property with no sample
value also fails, which is the schema→UI guard proposed at the end of this
document, in its cheapest form: adding a property to the schema without deciding
how the dashboard round-trips it breaks the build at the moment the schema
changes.

## Audit

Verified by reading each surface against `schemas/workflow-schema.json`.
Runtime-only fields (`_runtime`, `runtimeMetadata`, `originalFile`,
`workflowName`, `startedAt`, token totals, `conditionEvaluationSummary`) are
out of scope, as are `_templateMeta`/`templateVariableMetadata`, which belong
to the separate template-authoring surface.

### Workflow root — `WorkflowPropertiesPanel.tsx`

**Present:** `harness`, `model`, `agent`, `skills`, `additionalArgs`,
`executionMode`, `worktree` (mode / branch / base / setup / keep / merge),
`resumeSession`, `sessionId`, `priorContext`, `preCondition`, `endCondition`,
`errorBehavior`, `mcpServers`, `toolPermissions` (mode / allowed / denied),
`secrets`.

**Missing:**

| Property | Notes                                                                                                                                                                                                                                                                                                          |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vars`   | Zero occurrences anywhere under `src/ui/webview-react/components/`. Workflow-level `{{var}}` defaults are schema-and-CLI-only. Directly related to `OVERZEALOUS_STEP_FAILURES_PLAN.md` item 2: a UI author cannot see that a workflow defines vars, nor define one to satisfy an unresolved-placeholder error. |

### Prompt step — `PropertiesDrawer.tsx`

**Present:** `harness`, `model`, `agent`, `skills`, `additionalArgs`,
`executionMode`, `resumeSession`, `sessionId`, `priorContext`, `preCondition`,
`endCondition`, `errorBehavior`, `mcpServers`, `toolPermissions`. Step `name`
and `enabled` live in `EditorSection.tsx` (`:217-253`).

**Missing:**

| Property  | Notes                                                                                                                                                                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `secrets` | In `executionProperties`, so it is valid on every step, and the workflow panel has a control for it — but the step drawer does not. A per-step grant is unreachable. Highest-value single addition: it is the fix for the failure that started this. |

### Script step — `PromptEditor.tsx` + `ScriptConditionEditor` (`variant="scriptStep"`)

**Present:** `script`, `timeout`, `onPass`, `onFail`, `compareSource`,
`returns`, `executionMode`, `enabled`, `name`.

**Missing:**

| Property        | Notes                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `env`           | The map the schema explicitly documents as the place `${secret:NAME}` is allowed. `ScriptConditionValue` has no `env` field at all.                                            |
| `secrets`       | The **only** way a script step can grant a secret. Its absence makes the item-3 hard failure unrecoverable from the UI.                                                        |
| `errorBehavior` | Declared on `scriptStep` in the schema; the drawer's Error Behavior control is on the prompt-step path. Confirm whether it reaches script steps before treating this as a gap. |

### Conditions — `ScriptConditionEditor` (`preCondition` / `endCondition`)

**Present:** `script`, `returns`, `compareSource`, `timeout`, `onPass`,
`onFail`; endCondition adds `maxRetries`, `retryPrompt`, `passRetryPrompt`,
`resumeSessionOnRetry`.

**Missing:**

| Property | Notes                                                                                                                                                                                                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env`    | `preCondition` inherits it from `scriptProperties` in the schema; `endCondition` supports it at runtime (see schema bug below). `ScriptConditionValue` has no `env` field, so neither is editable. Both are scanned by `getProcessMaps`, so both can trigger the item-3 failure. |

### Hooks — `HooksEditor.tsx`

**Present:** `event`, `command`.

**Missing:**

| Property     | Notes                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `env`        | Zero occurrences in the file. Another `${secret:NAME}` surface with no control.                                                 |
| `timeoutSec` | Declared in the editor's own local TS interface (`:10`) but never rendered — the file has exactly one `<input>`, for `command`. |

### MCP servers — three surfaces, only one of which edits

Worth stating plainly, because it is easy to look in the wrong file:

| File                                     | Role                                                                                                                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `McpServersEditor.tsx` (workflow + step) | **Selector only.** Toggles which registry servers are attached, toggles individual ctrlyoke tools, and renders a read-only detail summary (`:169-201`). Edits nothing; links out to MCP Manager (`:252`, `:521-531`). |
| `McpManagerSection.tsx` (settings)       | List, import, export, delete, set-default. Delegates all field editing to the form below.                                                                                                                             |
| **`McpServerForm.tsx`**                  | **The only place MCP server fields are actually edited.**                                                                                                                                                             |

`McpServerFormState` (`:15-27`) is therefore the real parity surface:
`id`, `description`, `command`, `args`, `env`, `autoApprove`, `url`,
`transport`. It is also where the `${secret:NAME}` picker lives (`:357`).

**Missing from the form:**

| Field                        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `headers`                    | **The significant one.** No form state, no input. Remote MCP servers' headers are preserved across an edit (`mcpServerFormStateToServer` clones `originalServer`, and only the stdio branch deletes them — `:177`), so this is not data loss, but they can never be _authored or filled in_. `registryEntryToServer` imports a registry entry's required headers as **empty strings** (`:200-207`), so a remote server needing `Authorization` arrives with `{ "Authorization": "" }` and the dashboard offers no way to set it. This is exactly the original complaint's shape — and headers are a `${secret:NAME}` surface scanned by `getProcessMaps`, so a Bearer token is precisely what belongs there. |
| `autoApprove` as a tool list | Form state types it `boolean` only (`:22`). The schema and types both allow `boolean \| string[]`, so per-tool auto-approval is not authorable. An existing array survives an edit via `cloneMcpServerConfig`, but is overwritten with a boolean once the user touches the toggle.                                                                                                                                                                                                                                                                                                                                                                                                                           |

**Not a gap after all:** inline `mcpServerConfig` objects in a workflow's
`mcpServers` array are not merely schema-legal, the UI writes them —
`handleToggleServer` embeds `managedServer.config` when a server is enabled.
The earlier framing of this as "decide whether inline objects should be
authorable" is wrong; they already are, implicitly. What matters instead is
that the schema describe what gets written (see Schema cleanup item 1).

## Schema cleanup — DONE

Landed in `fix(schema): align workflow schema with the config the UI writes`.
All four items below are fixed; the section is kept because the confirmed
reproduction is the evidence for why the parity work that follows matters.

**The suspected validation failure was real.** Validating the old schema
directly with ajv rejected three of four cases:

| Case                                                                   | Old schema             | New schema         |
| ---------------------------------------------------------------------- | ---------------------- | ------------------ |
| Uncheck a ctrlyoke MCP tool → `{ id: "ctrlyoke", deniedTools: [...] }` | **INVALID**            | valid              |
| Enable a managed MCP server → embedded config with `description`       | **INVALID**            | valid              |
| Root-level script workflow with `secrets`                              | **INVALID**            | valid              |
| `endCondition.env`                                                     | valid but undocumented | valid + documented |

So two ordinary dashboard gestures produced workflows ctrlyoke's own parser
rejects. That is the strongest possible argument for the parity guard proposed
at the end of this document: the schema and the UI drifted apart silently, and
nothing failed until a user tried the combination.

### 1. `mcpServerConfig` rejected fields the UI writes — FIXED

`schemas/workflow-schema.json:1299-1358` declares `mcpServerConfig` with
`"additionalProperties": false` and these properties only: `id`, `command`,
`args`, `env`, `autoApprove`, `url`, `transport`, `headers`.

`McpServerConfig` in `src/types/CtrlYokeTypes.ts:65-95` has **two more**:

| Field         | Written by                                                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `description` | `McpServerForm`'s description input (`:293`), and `registryEntryToServer` on every registry import                                 |
| `deniedTools` | `McpServersEditor.buildArray` — emitted as `{ id: "ctrlyoke", deniedTools: [...] }` whenever a user unchecks any ctrlyoke MCP tool |

Both reach workflow files: `McpServersEditor.handleToggleServer` pushes
`managedServer.config` — the **whole object, including `description`** — into
the `mcpServers` array when a server is enabled for a workflow.

With `additionalProperties: false`, a workflow carrying either field should
fail `PromptFileParser` validation. **Verify this before anything else** — if
it reproduces, then enabling a managed MCP server on a workflow, or unchecking
a ctrlyoke tool, produces a workflow ctrlyoke itself cannot load. Fix by adding
both properties to the schema (they are real, documented, ctrlyoke-only
metadata — `description` is deliberately stripped from every harness export
path, per its doc comment).

This also settles the inline-object question below: inline `mcpServerConfig`
objects are not a hypothetical the schema merely tolerates — **the UI actively
writes them**, so the schema must describe exactly what the UI produces.

### 2. `endCondition` duplicated `scriptProperties` and lost `env` — FIXED

`endCondition` (`:815-867`) hand-declares its property list instead of
`$ref`-ing `scriptProperties` the way `preCondition` (`:899-922`) does, and in
the process **drops `env`**. At runtime that field is fully live:

- `EndCondition extends ScriptProperties` (`src/types/CtrlYokeTypes.ts:878`),
  and `ScriptProperties` has `env`.
- `SecretResolver.getProcessMaps` reads `step.endCondition?.env` **and**
  `workflow.endCondition?.env` — so it is scanned for secret grants and can
  hard-fail a run.
- `VarSubstitutor.applyToEndCondition` substitutes into `cond.env`.

So `endCondition.env` works, participates in two failure paths, and is invisible
to IntelliSense and hover docs. It validates today only because `endCondition`
has no `additionalProperties: false`.

**Decision: restructure `endCondition` to `allOf` + `$ref: scriptProperties`,
mirroring `preCondition`, and keep only its genuinely endCondition-specific
properties inline** (`maxRetries`, `retryPrompt`, `passRetryPrompt`,
`resumeSessionOnRetry`, and its own `onPass`/`onFail` enums). That removes the
duplicated `script`/`returns`/`compareSource`/`timeout` definitions, picks up
`env` for free, and makes the two condition types structurally symmetric —
which is what the TypeScript types already assert.

Watch two details while doing it: `endCondition` currently has
`"required": ["script", "returns"]` where `scriptProperties` requires only
`script`, so the `returns` requirement must be preserved at the `endCondition`
level; and `scriptProperties.returns` has a shorter description than
`endCondition`'s, so keep the richer wording where it belongs.

### 3. `scriptStep` duplicated `scriptProperties` too — FIXED

Same shape as (2), lower stakes: `scriptStep` (`:724-814`) re-declares
`script`, `env`, `compareSource`, `returns`, and `timeout` inline rather than
referencing `scriptProperties`, even though `ScriptStep extends ScriptProperties`
in the types (`src/types/CtrlYokeTypes.ts:712`). Its `additionalProperties: false`
makes a `$ref` restructure slightly more delicate than (2). Worth folding into
the same cleanup pass so all three consumers of `scriptProperties` share one
definition, but it is not blocking anything.

## Recommended order

0. ~~Schema cleanup~~ — **done**, see above.
1. ~~Answer the open question on property preservation~~ — **answered: the UI
   deletes them.** Fix the script-step and `finalStep` replace paths first, plus
   `buildWorkflowStepEnabledUpdate`. Adding controls to a UI that silently
   deletes fields makes the problem worse, not better.
2. **`secrets` on the step drawer** and **`secrets` + `env` on script steps.**
   These unblock the hard failure that motivated this document. If
   `OVERZEALOUS_STEP_FAILURES_PLAN.md` item 3 (auto-grant from process maps)
   ships first, this becomes less urgent but is still needed — an explicit
   grant remains the way to grant a secret a step never textually references.
3. **`env` on conditions and hooks**, plus **`headers` on `McpServerForm`.**
   One shared key/value map editor should serve script steps, conditions,
   hooks, MCP `env`, and MCP `headers`; build it once. `McpServerForm` already
   has the pieces worth reusing — the `${secret:NAME}` picker (`:357`) and the
   literal-credential warning (`findLiteralCredentialEnvKeys`) — so lift those
   into the shared component rather than reimplementing them per surface.
4. **`vars` at the workflow root.** Pairs with the `{{var}}` failure fix.
5. **`timeoutSec` on hooks** and **`autoApprove` as a tool list** — small
   completions of editors that already exist.

## Preventing the next one

The gaps above accumulated one feature at a time, each individually reasonable.
A checklist item in the instruction files was never going to hold.

**Half of this now exists.** `schemaUiPropertyRoundTrip.integration.test.ts`
walks the schema, enumerates user-authorable properties, and fails when one has
no sample value — so a new schema property cannot land without someone deciding
how it round-trips. What it does _not_ check is whether a control exists: a
property can round-trip perfectly through the message contract and still be
unreachable in the UI (`vars` and `headers` are exactly that today).

The remaining piece is therefore the control-id half: assert each authorable
property appears in a maintained registry of UI control ids, with an explicit,
commented opt-out list for properties deliberately left CLI-only. The sample
table in the round-trip suite is the natural place to hang it — it already
enumerates the same property set and already fails when the schema grows.

## Files likely changed

| File                                                                 | Change                                                                                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `schemas/workflow-schema.json`                                       | `mcpServerConfig` gains `description` + `deniedTools`; `endCondition` and `scriptStep` `$ref` `scriptProperties` instead of duplicating it |
| `src/ui/webview-react/components/shared/McpServerForm.tsx`           | `headers` editor; `autoApprove` tool list                                                                                                  |
| `src/ui/webview-react/components/editor/PropertiesDrawer.tsx`        | Step-level `secrets` control                                                                                                               |
| `src/ui/webview-react/components/editor/PromptEditor.tsx`            | Script-step `env` / `secrets` / `errorBehavior` in the submit payload                                                                      |
| `src/ui/webview-react/components/shared/ScriptConditionEditor.tsx`   | `env` on `ScriptConditionValue` + editor for script steps and both conditions                                                              |
| `src/ui/webview-react/components/editor/HooksEditor.tsx`             | Hook `env` and `timeoutSec` controls                                                                                                       |
| `src/ui/webview-react/components/layout/WorkflowPropertiesPanel.tsx` | Workflow-level `vars` editor                                                                                                               |
| `src/ui/webview-react/components/shared/`                            | New shared env key/value map editor with the secret picker                                                                                 |
| `src/core/WorkflowStepSanitizer.ts`                                  | Script-step merge-vs-replace; `secrets`/`vars` in `buildPromptStepProperties`; `secrets` in the clipboard script branch                    |
| `src/core/WorkflowInstance.ts`, `src/core/WorkflowOrchestrator.ts`   | Script-step and `finalStep` replace paths                                                                                                  |
| `src/ui/webview-react/utils/stepClipboard.ts`                        | `buildWorkflowStepEnabledUpdate` drops fields it does not enumerate                                                                        |
| `src/test/**`, `src/ui/webview-react/test/**`                        | Property-preservation coverage; schema→UI parity guard                                                                                     |
