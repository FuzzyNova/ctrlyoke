# Script output substituted into a retry prompt is re-parsed as live `@file`, `!SECRET` and `$previous` references

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/core/harness/shared/CliPromptPreparer.ts` (`planPrompt`)
- **Resolution:** fixed in this commit

## Symptom

When a retry prompt uses `$endCondition:stdout`/`stderr` (or `$preCondition:…`), the script's
output is pasted in first and then scanned for references. Ordinary test-runner output then
produces errors or attaches unrelated context.

Reproduced by calling the real `CliPromptPreparer.planPrompt` with a `ContextExpander`-backed
`buildPromptSections`, the prompt `"The check failed:\n$endCondition:stdout\nPlease fix."`, and
typical `npm test` stdout:

```
> @acme/web@1.0.0 test
> vitest run

FAIL ...: expected !CI_TOKEN to be set; see @src/config.ts
```

Diagnostics produced:

- `prompt.secret.unknown` (severity error): `Secret "CI_TOKEN" referenced by !CI_TOKEN ...`
- `prompt.reference.unresolved`: `Reference "acme/web@1.0.0" could not be attached`. This comes
  from the npm banner line that every `npm run` prints.

With stdout `error in @src/config.ts; also see $previous`, the plan attaches `src/config.ts` as a
file reference and adds a prior-context section. With `contextResolutionFailure: "fail"`,
`CliIntegration.ts:~1101-1111` throws on these diagnostics, so the retry fails because of what the
test runner printed. (This last step was confirmed by reading the code, not by running it.)

## Steps to Reproduce

1. Give a step an end condition that runs `npm test`, with `onFail: retry` and
   `retryPrompt: "Tests failed:\n$endCondition:stdout\nFix them."`.
2. Make the tests fail.
3. The retry turn reports an unresolved `acme/web@1.0.0` reference (and a secret error for any
   `!WORD` in the output). With `contextResolutionFailure: fail`, the retry turn fails.

## Root Cause

In `planPrompt` (`CliPromptPreparer.ts:~136-143`), condition-output substitution runs first. The
later passes all scan the substituted text: slash-token scanning (`~205`), `parseSecretReferences`
(`~242`), `buildPromptSections` → `ContextExpander.expandContextSplit`, and
`parseInlinePriorContextRefs` (`~318`). `maskFencedCodeBlocks` exists to keep pasted literal text
from becoming a live reference, but substituted condition output bypasses it.

## Suggested Fix

Keep substituted condition output inert. Either run reference parsing on the authored text before
substitution and substitute afterwards, or wrap each substituted value in a fence longer than any
backtick run inside it (reuse the existing `fenceLiteral` helper) so every parser masks it. Add
tests: stdout containing `@file`, `!NAME`, `$previous` and an npm banner produces no reference
diagnostics and no attached context, while the authored prompt's own references still resolve.
