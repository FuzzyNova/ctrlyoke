# MCP condition preset lookup accepts `Object.prototype` names and strips the step's gate

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli subagent)
- **Area:** `src/utils/McpConditionPresetResolver.ts`
- **Severity:** high

## Symptom

`append_step` and `edit_step` accept `endCondition` / `preCondition`
`{ "use": "constructor" }` (also `"__proto__"`, `"toString"`,
`"hasOwnProperty"`, …) even though the workflow declares no such preset. The
step is persisted with a condition of `{ "env": {} }`, which has no script.
That replaces both the step's own authored gate and any workflow-level
condition it would have inherited.

`docs/reference/mcp-tools.md` says agents can only attach author-defined
presets and that condition gates cannot be cleared through MCP. This lets an
agent remove a gate the author set, e.g. a "tests must pass" end condition.
At run time a script-less condition is an evaluation error (`WorkflowExecutor`,
~line 4623). By default that stops the workflow. With
`errorBehavior.onError: "continue"` the gate is skipped silently.

## Steps to Reproduce

Against the compiled `out/mcp-server.js`, with a paused run whose workflow
declares only the preset `tests`, a workflow `endCondition: { script: "exit 1" }`,
and step 1 with `endCondition: { script: "npm test" }`:

1. `append_step({ position: "end", steps: [{ prompt: "x", endCondition: { use: "constructor" } }] })`
   succeeds and reports `endConditionPreset: "constructor"`.
2. `edit_step({ index: 1, updates: { endCondition: { use: "__proto__" } } })`
   succeeds with `changed: true`.
3. Control: `use: "missing"` is rejected as an unknown preset.
4. The persisted step end conditions are `[null, {"env":{}}, {"env":{}}]`.
   The `npm test` gate is gone, and the inherited workflow gate no longer
   applies to the appended step.

## Root Cause

`materializeMcpConditionPreset` (`src/utils/McpConditionPresetResolver.ts:84-90`):

```ts
const conditions = workingFile.conditions ?? {};
const preset = conditions[reference.use];
if (!preset) { throw … unknown condition preset … }
```

`conditions` is a plain object, so inherited `Object.prototype` members are
truthy and pass the existence check. The rest of the function spreads the
function or prototype into an empty condition with no `script`.

## Suggested Fix

Look the preset up only when
`Object.prototype.hasOwnProperty.call(conditions, reference.use)` (or
`Object.hasOwn`) is true, and throw the existing unknown-preset error otherwise.
Check other name-keyed lookups into `workingFile.conditions` the same way: grep
`conditions[` and `.conditions?.[` in `src/`, including `workflow_status`'s
`metadata.conditionPresets` listing and the CLI/dashboard preset resolution.
Add `McpServer.test.ts` (or `McpConditionPresetResolver` unit) cases for
`constructor` and `__proto__` through both `append_step` and `edit_step`,
asserting rejection and an unchanged run file.
