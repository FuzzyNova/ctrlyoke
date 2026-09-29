# Fallback end-condition retry prompt pastes unfenced script output that is re-parsed as references

- **Found:** 2026-09-29 by bug-hunt final step (claude-cli)
- **Area:** `src/core/EndConditionHandler.ts` (`buildRetryPrompt` fallback)
- **Severity:** medium

## Symptom

`endCondition: { onFail: retry }` without a `retryPrompt` now uses the
fallback prompt (made the default by the fix for
`end-condition-onfail-retry-without-retryprompt-never-retries`). The fallback
embeds `evaluationResult.stdout` raw. That text then goes through `{{var}}`
substitution and `CliPromptPreparer.planPrompt`, which scans for `!NAME`,
`@file`, `$previous`, `/skill:` and `~hash`. So the bug fixed by
`condition-output-reparsed-as-prompt-references` (which fenced the
`$endCondition:*` placeholder path) comes back through this path.

Reproduced by calling the real `buildRetryPrompt` with no retry template and
stdout
`> @acme/web@1.0.0 test\nFAIL: expected !CI_TOKEN; see @src/config.ts and $previous`:
the prepared retry prompt resolves secrets `["CI_TOKEN"]`, file refs
`["acme/web@1.0.0","src/config.ts"]` and prior context `["$previous"]`. In
practice, npm's own `> pkg@version script` banner produces an unresolved `@`
reference on every retry. That fails the retry under
`contextResolutionFailure: fail`, and `!NAME` in test output raises a secret
diagnostic.

## Steps to Reproduce

1. A prompt step with `endCondition: { script: npm test, onFail: retry }` and no
   `retryPrompt` (none in settings either).
2. The test fails and prints `> my-pkg@1.0.0 test` (npm's banner).
3. The retry prompt contains an unresolved `@my-pkg@1.0.0` reference.

## Root Cause

`buildRetryPrompt` interpolates `stdout` (and the expected/actual strings)
directly instead of fencing them with `fenceLiteral`, as the placeholder
substitution path does.

## Suggested Fix

Wrap stdout, and the expected/actual values, with `fenceLiteral(...)` in the
fallback, reusing the same helper as `substituteConditionOutputRefs`. Add a
regression test next to the existing onFail-retry tests asserting that no
references or secrets are detected in the prepared fallback retry prompt.
