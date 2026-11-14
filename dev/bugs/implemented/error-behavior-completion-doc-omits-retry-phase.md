# errorBehavior completion documentation omits `retryPhase`

- **Found:** 2026-11-13 by the bug-hunt workflow final step (claude-cli), reviewing a1f660730
- **Area:** `src/completions/WorkflowPropertySnippets.ts`
- **Resolution:** fixed in this commit

## Symptom

The IntelliSense documentation for the `errorBehavior` property says
"`onError` supports `stopWorkflow`, `retry`, or `continue`", so it leaves out
`retryPhase`, which a1f660730 added to the schema, the executor and the
dashboard.

## Steps to Reproduce

1. In a `.ctrlyoke.yaml` step, start typing `errorBehavior` and read the
   completion's documentation.
2. It lists three `onError` values. `retryPhase` is missing.

## Root Cause

The `PROMPT_PROPERTIES.ERROR_BEHAVIOR` entry in `WorkflowPropertySnippets.ts`
is hand-written text, and a1f660730 updated only the schema descriptions and
the docs.

## Suggested Fix

List `retryPhase` and say which retry scope each value has.
