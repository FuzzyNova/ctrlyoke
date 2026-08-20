# Workflow Schema → UI Parity Plan

> **Status:** Not started — audit complete and verified against the code
> (2026-08-19); fixes not designed.
> **Priority:** P1 — one open question below (property preservation on save) is
> a possible silent data-loss bug and must be answered first.
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
the *only* way to resolve it (script steps have no prompt, so the inline
`!NAME` gesture does not exist). A UI-only author hitting that failure on a
script step is stuck with no path forward inside the product.

## Open question — answer this before anything else

**Does saving a step through the UI preserve properties the UI cannot edit?**

The script-step submit path (`PromptEditor.tsx:838-856` and `:926-940`) builds
its payload by **explicit enumeration**:

```ts
properties: {
  type: STEP_TYPES.SCRIPT,
  ...(scriptTimeout !== undefined && { timeout: scriptTimeout }),
  ...(scriptOnPass !== CONDITION_ACTIONS.CONTINUE && { onPass: scriptOnPass }),
  ...(scriptOnFail !== CONDITION_ACTIONS.STOP_WORKFLOW && { onFail: scriptOnFail }),
  ...(scriptCompareSource !== COMPARE_SOURCES.AUTO && { compareSource: scriptCompareSource }),
  ...(scriptReturns && { returns: scriptReturns }),
  ...(scriptExecutionMode !== undefined && { executionMode: scriptExecutionMode }),
  ...(!stepEnabled && { enabled: false }),
}
```

`env`, `secrets`, and `errorBehavior` are absent. If `UPDATE_PROMPT` replaces
the step's properties rather than merging them, then **opening a hand-authored
or CLI-authored script step in the dashboard and saving it silently deletes
those fields** — including a secret grant, which would convert a working
workflow into the hard failure above.

This has **not** been verified either way. Verify it first: it decides whether
this document describes a discoverability gap (annoying) or a data-loss bug
(urgent), and it may apply to prompt steps and the final step too. If
properties are replaced rather than merged, fix that before adding any
controls — round-tripping unknown properties safely is the foundation
everything else sits on.

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

| Property | Notes |
| --- | --- |
| `vars` | Zero occurrences anywhere under `src/ui/webview-react/components/`. Workflow-level `{{var}}` defaults are schema-and-CLI-only. Directly related to `OVERZEALOUS_STEP_FAILURES_PLAN.md` item 2: a UI author cannot see that a workflow defines vars, nor define one to satisfy an unresolved-placeholder error. |

### Prompt step — `PropertiesDrawer.tsx`

**Present:** `harness`, `model`, `agent`, `skills`, `additionalArgs`,
`executionMode`, `resumeSession`, `sessionId`, `priorContext`, `preCondition`,
`endCondition`, `errorBehavior`, `mcpServers`, `toolPermissions`. Step `name`
and `enabled` live in `EditorSection.tsx` (`:217-253`).

**Missing:**

| Property | Notes |
| --- | --- |
| `secrets` | In `executionProperties`, so it is valid on every step, and the workflow panel has a control for it — but the step drawer does not. A per-step grant is unreachable. Highest-value single addition: it is the fix for the failure that started this. |

### Script step — `PromptEditor.tsx` + `ScriptConditionEditor` (`variant="scriptStep"`)

**Present:** `script`, `timeout`, `onPass`, `onFail`, `compareSource`,
`returns`, `executionMode`, `enabled`, `name`.

**Missing:**

| Property | Notes |
| --- | --- |
| `env` | The map the schema explicitly documents as the place `${secret:NAME}` is allowed. `ScriptConditionValue` has no `env` field at all. |
| `secrets` | The **only** way a script step can grant a secret. Its absence makes the item-3 hard failure unrecoverable from the UI. |
| `errorBehavior` | Declared on `scriptStep` in the schema; the drawer's Error Behavior control is on the prompt-step path. Confirm whether it reaches script steps before treating this as a gap. |

### Conditions — `ScriptConditionEditor` (`preCondition` / `endCondition`)

**Present:** `script`, `returns`, `compareSource`, `timeout`, `onPass`,
`onFail`; endCondition adds `maxRetries`, `retryPrompt`, `passRetryPrompt`,
`resumeSessionOnRetry`.

**Missing:**

| Property | Notes |
| --- | --- |
| `env` | `preCondition` inherits it from `scriptProperties` in the schema; `endCondition` supports it at runtime (see schema bug below). `ScriptConditionValue` has no `env` field, so neither is editable. Both are scanned by `getProcessMaps`, so both can trigger the item-3 failure. |

### Hooks — `HooksEditor.tsx`

**Present:** `event`, `command`.

**Missing:**

| Property | Notes |
| --- | --- |
| `env` | Zero occurrences in the file. Another `${secret:NAME}` surface with no control. |
| `timeoutSec` | Declared in the editor's own local TS interface (`:10`) but never rendered — the file has exactly one `<input>`, for `command`. |

### MCP servers — `McpServersEditor.tsx` (workflow/step) + `McpManagerSection.tsx` (settings)

The workflow-level editor is a **selector over registry-managed servers** plus
a read-only detail summary (`args`, `transport`, `env` keys, `headers` keys,
`autoApprove` — `:173-199`), and it explicitly directs users to the MCP Manager
for `${secret:NAME}` references (`:252`). The MCP Manager covers `command`,
`args`, `env`, `url`, `transport`, `headers`, and `autoApprove`.

**Gap:** the schema allows an **inline `mcpServerConfig` object** in a
workflow's `mcpServers` array, not just a registry ID string. Inline objects
are not authorable from the workflow panel. Decide whether that is a deliberate
"registry is the only authoring path" product stance — if so, document it and
consider narrowing the schema — or a genuine gap. Do not add an inline-object
editor without making that call first.

## Schema bug found during the audit

`endCondition` in the JSON schema (`schemas/workflow-schema.json:815-867`)
declares its own property list and **does not include `env`**, and unlike
`preCondition` it does not `$ref` `scriptProperties`. But at runtime:

- `EndCondition extends ScriptProperties` in `src/types/CtrlYokeTypes.ts:878`,
  and `ScriptProperties` has `env`.
- `SecretResolver.getProcessMaps` reads `step.endCondition?.env` **and**
  `workflow.endCondition?.env`.
- `VarSubstitutor.applyToEndCondition` substitutes `cond.env`.

So `endCondition.env` works, is scanned for secrets, and can hard-fail a run —
while being absent from the schema, and therefore from IntelliSense, hover
docs, and any schema-derived documentation. It validates only because
`endCondition` has no `additionalProperties: false`. Align the schema with the
types (probably by `$ref`-ing `scriptProperties` the way `preCondition` does).

## Recommended order

1. **Answer the open question** on property preservation. If the UI drops
   unknown properties on save, fix that first — adding controls to a UI that
   silently deletes fields makes the problem worse, not better.
2. **`secrets` on the step drawer** and **`secrets` + `env` on script steps.**
   These unblock the hard failure that motivated this document. If
   `OVERZEALOUS_STEP_FAILURES_PLAN.md` item 3 (auto-grant from process maps)
   ships first, this becomes less urgent but is still needed — an explicit
   grant remains the way to grant a secret a step never textually references.
3. **`env` on conditions and hooks**, plus the `endCondition.env` schema fix.
   One shared key/value map editor should serve script steps, conditions, and
   hooks; build it once. It is also the natural home for the MCP Manager's
   `${secret:NAME}` picker and its literal-credential warning
   (`findLiteralCredentialEnvKeys`) — reuse, do not reimplement.
4. **`vars` at the workflow root.** Pairs with the `{{var}}` failure fix.
5. **`timeoutSec` on hooks** — smallest item, finish the hook editor.
6. **Decide the inline-`mcpServerConfig` question** and record the answer.

## Preventing the next one

The gaps above accumulated one feature at a time, each individually reasonable.
A checklist item in the instruction files is unlikely to hold on its own.
Consider a test that walks `schemas/workflow-schema.json`, enumerates
user-authorable properties, and asserts each one appears in a maintained
registry of UI control ids — with an explicit, commented opt-out list for
properties deliberately left CLI-only. That converts "we forgot" into a failing
test at the moment the schema changes, which is the only point where the
context to decide is still fresh.

If that proves too heavy, the cheaper version is a single documented table in
`.github/instructions/webview-react.instructions.md` mapping every schema
property to its control, reviewed whenever the schema gains a property.

## Files likely changed

| File | Change |
| --- | --- |
| `schemas/workflow-schema.json` | `endCondition` gains `env` (via `scriptProperties` `$ref`) |
| `src/ui/webview-react/components/editor/PropertiesDrawer.tsx` | Step-level `secrets` control |
| `src/ui/webview-react/components/editor/PromptEditor.tsx` | Script-step `env` / `secrets` / `errorBehavior` in the submit payload |
| `src/ui/webview-react/components/shared/ScriptConditionEditor.tsx` | `env` on `ScriptConditionValue` + editor for script steps and both conditions |
| `src/ui/webview-react/components/editor/HooksEditor.tsx` | Hook `env` and `timeoutSec` controls |
| `src/ui/webview-react/components/layout/WorkflowPropertiesPanel.tsx` | Workflow-level `vars` editor |
| `src/ui/webview-react/components/shared/` | New shared env key/value map editor with the secret picker |
| `src/test/**`, `src/ui/webview-react/test/**` | Property-preservation coverage; schema→UI parity guard |
