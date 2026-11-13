# MCP `edit_step` merges prompt-only fields into a script step and reports success

- **Found:** 2026-11-12 by the bug-hunt workflow's final step (claude-cli subagent), confirmed with a throwaway Mocha test in `src/test/unit/McpServer.test.ts`
- **Area:** `src/mcp-server.ts` (`handleStepEdit`, harness/model validation), `src/core/WorkflowStepSanitizer.ts` (`mergeWorkflowStepUpdate`)
- **Resolution:** fixed in this commit

## Symptom

On a running run whose pending step 2 is `{ type: "script", script: "npm test" }`, the
call

```json
edit_step { "index": 2, "updates": { "endCondition": { "use": "committed" },
  "harness": "bogus-harness", "model": "m", "skills": ["s"],
  "resumeSession": true, "sessionId": 1 } }
```

returns `success: true, changed: true`. The persisted step becomes
`{"type":"script","script":"npm test",…,"harness":"bogus-harness","model":"m","skills":["s"],"resumeSession":true,"sessionId":1,"endCondition":{…}}`.

None of it has any effect: `WorkflowExecutor` hands script steps to `executeScriptStep`
before any pre/end-condition loop, so the gate the agent attached never runs. The run
file also stops validating: `PromptFileParser.getSchemaWarnings` reports
`/steps/2/harness: must be equal to one of the allowed values` plus unevaluated-property
errors, because `scriptStep` in `schemas/workflow-schema.json` has none of these fields
and `workflowStep` sets `unevaluatedProperties: false`.

## Steps to Reproduce

1. Start a workflow with a pending script step and a `conditions.committed` preset.
2. From a step with `/mcp:ctrlyoke`, call `edit_step` on the script step with any of
   `endCondition`, `preCondition`, `harness`, `model`, `agent`, `skills`,
   `resumeSession`, `sessionId`.
3. The tool reports success; the step file now holds fields the schema rejects and the
   executor ignores.

## Root Cause

`handleStepEdit` only refuses `updates.prompt` on a script step
(#selection:src/mcp-server.ts:1660-1666). `mergeWorkflowStepUpdate`
(`src/core/WorkflowStepSanitizer.ts`) then copies every other update onto it, and the
harness/model check skips script steps (`if (isScriptStep(step)) continue;`,
#selection:src/mcp-server.ts:1867-1868), so not even the harness value is validated.
`.github/instructions/extension.instructions.md` requires MCP tools to refuse rather than
report a truthful-but-inert success. The dashboard builds script steps from an allow-list
(`buildScriptStepFromProperties`), so only MCP can write this.
`dev/bugs/implemented/mcp-edit-step-wipes-script-step.md` already suggested rejecting
prompt-only fields on a script step; that part was never done.

## Suggested Fix

In `handleStepEdit`, when the existing step is a script step, refuse any key in `updates`
or `clearProperties` that a script step cannot hold (derive the allowed set from the
script-step schema or a single shared constant rather than a hand-typed list; a script
step's editable fields are along the lines of `name`, `enabled`, `color`,
`executionMode`, `script`-related fields if MCP allows them). Return an `Error:` result
naming the rejected keys; nothing is written. Add a `McpServer.test.ts` case modelled on
"merges a partial edit into a pending script step" that asserts the refusal and that the
run file is unchanged.
