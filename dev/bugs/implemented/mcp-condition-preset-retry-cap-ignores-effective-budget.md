# MCP condition-preset `maxRetries` cap ignores the retry budget the preset actually gets

- **Found:** 2026-11-13 by the bug-hunt workflow final step (claude-cli)
- **Area:** `src/utils/McpConditionPresetResolver.ts` (`resolveMaxRetries`, `materializeMcpConditionPreset`), `src/core/RetryBudget.ts` (`resolveRetryBudget`)
- **Resolution:** fixed in this commit

## Symptom

The `append_step`/`edit_step` tool descriptions say an agent's `maxRetries`
"cannot exceed the preset's own maxRetries", and
`docs/workflows/end-conditions.md` says the same. When the preset does not set
`maxRetries`, the check compares against a hard-coded limit of `0`, while the
runtime gives the preset a different budget. Both directions break:

1. **A valid request is rejected.** With
   `conditions: { gate: { script: "npm test", onFail: retry } }`,
   `{ use: "gate" }` runs with 1 retry (`DEFAULT_ERROR_BEHAVIOR_RETRIES`),
   but `{ use: "gate", maxRetries: 1 }` fails with
   `endCondition: maxRetries 1 exceeds preset 'gate' limit 0.`
2. **The cap can be bypassed.** With `conditions: { gate: { script: "npm test" } }`
   (0 retries as authored) and the user setting
   `defaults.endCondition.maxRetries: 3`, an explicit `maxRetries: 1` is
   rejected, but `{ use: "gate", retryPrompt: "fix it" }` is accepted and the
   materialized condition runs with 3 retries: adding retry text alone turns on
   `defaults.endCondition.maxRetries`.

## Steps to Reproduce

Against the compiled resolver (`out/utils/McpConditionPresetResolver.js`) and
`out/core/RetryBudget.js`:

1. `materializeMcpConditionPreset({ conditions: { gate: { script: "x", onFail: "retry" } } }, "endCondition", { use: "gate", maxRetries: 1 })`
   throws "exceeds preset 'gate' limit 0".
2. `materializeMcpConditionPreset({ conditions: { gate: { script: "x" } } }, "endCondition", { use: "gate", retryPrompt: "fix it" })`
   returns a condition with `retryPrompt` and no `maxRetries`;
   `resolveRetryBudget(that, { maxRetries: 3 })` gives `maxRetries: 3, canRetry: true`.

## Root Cause

`resolveMaxRetries` (#selection:src/utils/McpConditionPresetResolver.ts:81-97)
uses `preset.maxRetries ?? 0` as the limit, and returns `preset.maxRetries`
(possibly `undefined`) when the caller passes none. `resolveRetryBudget`
(#selection:src/core/RetryBudget.ts:54-63) derives an omitted `maxRetries`
from `onFail`/`onPass` (`retry` → 1) and from the presence of a
`retryPrompt` (→ `defaults.maxRetries`). So the materialized condition's
budget depends on fields the caller can add, while the cap never sees them.
The existing MCP tests only use presets that set `maxRetries` explicitly.

## Suggested Fix

Make the cap the preset's effective budget as authored, and make sure the
caller's overrides can never raise it:

- Compute the preset's limit the way `resolveRetryBudget` would for the preset
  as written (`maxRetries` if set; else 1 for `onFail`/`onPass: retry`; else
  the user default only if the preset itself carries a `retryPrompt`; else 0).
  Single-source that derivation with `RetryBudget.ts` rather than copying it.
- Accept a caller `maxRetries` up to that limit (`-1` stays unlimited).
- When the caller supplies `retryPrompt`/`passRetryPrompt` and no
  `maxRetries`, pin the materialized `maxRetries` to the preset's limit so
  the added text cannot switch on a larger default budget.
- Apply the same to `preCondition` presets.

Tests in `src/test/unit/McpServer.test.ts` (or a resolver unit test): the two
reproductions above, plus an explicit-`maxRetries` preset staying as today.
