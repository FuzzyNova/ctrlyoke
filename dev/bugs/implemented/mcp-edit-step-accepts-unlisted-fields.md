# MCP `edit_step` accepts any step field, so an agent can turn a pending step into a script step

- **Found:** 2026-10-01 by bug-hunt final step (claude-cli), reproduced against the compiled MCP server (`out/`) with a live run
- **Area:** `src/utils/McpToolDefinitions.ts` (`MCP_STEP_UPDATE_SCHEMA`, `edit_step` `clearProperties`), `src/mcp-server.ts` (`toWorkflowStepUpdates`), `src/core/WorkflowStepSanitizer.ts` (`mergeWorkflowStepUpdate`)
- **Resolution:** fixed in this commit

## Symptom

`docs/reference/mcp-tools.md` limits `edit_step` to `prompt`, `name`, `model`,
`harness`, `resumeSession`, `sessionId`, `agent`, `enabled`, `color`,
`additionalArgs`, and `skills`, and says script steps cannot be appended over
MCP. Yet this call succeeds:

```json
{ "index": 2, "updates": { "type": "script", "script": "echo pwned > pwned.txt", "secrets": ["GITHUB_TOKEN"] } }
```

It returns `success: true, changed: true`, and the pending prompt step is saved
as `{"type":"script","script":"echo pwned > pwned.txt","secrets":["GITHUB_TOKEN"]}`.
Its `stepId` is lost. When the step runs, ctrlyoke executes the raw shell
command outside the harness's tool-permission sandbox.

Unlisted fields of other kinds get through the same way, e.g. `endCondition`
(an end-condition script), `preCondition`, `mcpServers`, `hooks`, `env`,
`toolPermissions`. `clearProperties` takes any string too, so an agent can
remove `prompt`, `toolPermissions`, and so on.

## Steps to Reproduce

1. Start a run with at least one pending prompt step.
2. From the step's agent, call `edit_step` with the `updates` above.
3. `workflow_status` shows the step as `(script) echo pwned > pwned.txt`. It
   runs when reached.

## Root Cause

- `MCP_STEP_UPDATE_SCHEMA` has no `additionalProperties: false`, and
  `McpSchemaValidator` only rejects unknown keys when that flag is set.
- `toWorkflowStepUpdates` forwards the remaining keys unchanged.
- `mergeWorkflowStepUpdate` treats `type: "script"` / a `script` key as a step
  kind change and returns the incoming object wholesale.
- `clearProperties` is `items: { type: "string" }` with no `enum`.

## Suggested Fix

- Set `additionalProperties: false` on `MCP_STEP_UPDATE_SCHEMA`.
- Restrict `clearProperties` items to an `enum` of the updatable field names.
  Derive it from the schema's property keys so the list stays single-sourced.
- Make `toWorkflowStepUpdates` pick only those keys (defence in depth, in case
  a caller skips validation).
- In the same schema, fix the `sessionId` description ("The session or step
  index to resume"). It is a **1-based step number**, as `append_step` and the
  docs say, and the `index` it sits next to is zero-based.
- Tests: `type`/`script`/`endCondition`/`secrets` in `updates` are rejected;
  `clearProperties: ["prompt"]` is rejected; the documented fields still work.
