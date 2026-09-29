# `ctrlyoke history show` labels every AI attempt as a script step

- **Found:** 2026-09-29 by Claude while validating recovered run history
- **Area:** `src/core/orchestration/RunOutputResolver.ts`
- **Severity:** medium

## Symptom

`ctrlyoke history show` prints every AI prompt attempt as a script step:

```
│ [Script step] opencode-ctrlyoke-mcp
│ Script step output:
The prompt file doesn't exist at that path. …
```

This reproduces on untouched runs, e.g. any run whose `cliOutputRecorded`
events carry `"responseKind": "ai"`, which is every AI attempt written by
current builds.

## Steps to Reproduce

1. Run any workflow with an AI prompt step.
2. `node out/cli.js history show --workflow <key> --run 1`
3. The AI attempt is rendered with the `[Script step]` header and
   `Script step output:` label.

## Root Cause

`RunOutputResolver.ts` (the `CLI_OUTPUT_RECORDED` case, around line 321):

```ts
kind:
  (event.responseKind ??
  event.payload.cliOutput.source === SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP)
    ? TIMELINE_ATTEMPT_KINDS.SCRIPT
    : TIMELINE_ATTEMPT_KINDS.AI,
```

Because of how the parentheses group, the conditional tests the truthiness of
`responseKind ?? (source === SCRIPT_STEP)`. Any non-empty `responseKind`,
including `"ai"` and `"condition"`, is truthy, so the attempt resolves to
`SCRIPT`. `isHistoryScriptAttempt()` in `src/cli/HistoryInspectionCommands.ts`
then routes it through the script formatter.

## Suggested Fix

Use the recorded kind when present and fall back to the legacy source check
only when it is absent:

```ts
kind:
  event.responseKind ??
  (event.payload.cliOutput.source === SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP
    ? TIMELINE_ATTEMPT_KINDS.SCRIPT
    : TIMELINE_ATTEMPT_KINDS.AI),
```

Add a resolver test covering `responseKind: "ai"`, `"script"` and
`"condition"` plus a legacy event with no `responseKind`.
