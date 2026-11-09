# A single-step root workflow suggests keys from the other step kind, and following the suggestion fails to load

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli subagent, failing Mocha repro)
- **Area:** `src/core/PromptFileParser.ts` (`getValidKeysAtPointer`)
- **Resolution:** fixed in this commit

## Symptom

In a workflow file with no `steps` (a single-step root), an unknown-key typo is matched against
the union of prompt-step and script-step keys:

- `{ type: "script", script: "echo hi", harnes: "claude-cli" }` warns
  "Did you mean 'harness'?". `harness` is not valid on a script step.
- `{ prompt: "hello", shel: "bash" }` warns "Did you mean 'shell'?". `shell` is not valid on a
  prompt step.

Following the advice is worse than the typo: `{ prompt: "hello", shell: "bash" }` throws
`Validation failed: … must NOT have unevaluated properties …`, while the same key inside
`steps[0]` only produces an unknown-property warning.

## Steps to Reproduce

`new PromptFileParser().getSchemaWarnings(...)` (or load a file) with the objects above.

## Root Cause

2ee096670 (`fix: suggest keys valid for the step kind`) fixed only the step branch of
`getValidKeysAtPointer` (~767). The root branch (~748-755) still uses `[defs.singleStepRoot]`,
which is `oneOf: [promptStep root, rootScriptStep root]`, and the suggestion visitor walks both
alternatives. In `validateSchema`, a root key that appears in that union is also not treated as an
unknown-property candidate, so it escalates to a hard validation error instead of a warning.

## Suggested Fix

When `suggestionCandidatesOnly` is set at the root without `steps`, choose the alternative by
`target.type === STEP_TYPES.SCRIPT` (`singleStepRoot.oneOf[1]` vs `oneOf[0]`, which already
include the workflow-only properties) instead of the union. Keep the union for validation
relaxation if needed, but make a root key that is only valid for the other kind produce the same
unknown-property warning it does under `steps[]` rather than a hard error. Add root cases to the
"step-kind-specific unknown property suggestions" suite in `src/test/promptFileParser.test.ts`.
