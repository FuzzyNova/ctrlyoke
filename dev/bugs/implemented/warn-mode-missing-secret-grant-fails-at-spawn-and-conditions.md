# In `warn` mode, a missing secret grant still fails the step at spawn and in conditions

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (confirmed with a scratch `npx tsx` call to `EndConditionEvaluator.evaluateCondition`)
- **Area:** `src/core/WorkflowExecutor.ts` (callers of `resolveGrantedSecretValues`), `src/core/EndConditionEvaluator.ts`, `src/core/harness/shared/CliTransportCoordinator.ts`, `src/utils/SecretResolver.ts`
- **Resolution:** fixed in this commit

## Symptom

Under the default `execution.contextResolutionFailure: "warn"`, the docs say a
granted `!NAME` with no value only adds a warning and the step still runs
(`docs/reference/settings.md`, `docs/troubleshooting/common-errors.md`,
`docs/cli/ctrlyoke.md`). The warning row does appear, but the step then fails
anyway as soon as something re-resolves the grants. Each of the following throws
`MissingSecretError` ("Secret "X" is not resolvable …"):

- The real CLI harness spawn.
- The pre-condition and end-condition scripts. The condition errors through
  `errorBehavior`, and the script never runs.
- A `type: script` step.
- The retry prompt path.

So the fix in `dev/bugs/implemented/unapproved-grant-of-unresolvable-secret-fails-workflow.md`
(an appended step with a stray `!B` grant should warn, not fail) only holds for
the mock harness. A real harness still fails at spawn.

## Steps to Reproduce

1. Make sure no secret `CTRLYOKE_REPRO_MISSING` exists in the store or the
   environment. Keep the default `warn` mode.
2. Call
   `new EndConditionEvaluator(platform).evaluateCondition({ script: "node -e \"console.log('ok')\"" }, root, undefined, undefined, ["CTRLYOKE_REPRO_MISSING"])`.
   The result is `{ passed: false, errored: true, error: 'Secret "CTRLYOKE_REPRO_MISSING" is not resolvable …' }`.
3. End to end: a step with prompt `Use !SOME_UNSET_NAME` plus any `endCondition`,
   or any real CLI harness. The warning shows, then the condition or the spawn
   fails.

## Root Cause

`WorkflowExecutor.resolveGrantedSecretValues` correctly drops missing names
from the values it **returns**. But every caller keeps forwarding the full,
unfiltered grant list to code that resolves the values again through
`resolveSecretEnvironment` → `resolveSecretValues`, and that code throws on any
missing name:

- **Prompt step:** `resolvedProperties.secrets = secretNames` (search
  `secrets: secretNames,` in `WorkflowExecutor.ts`). `CliTransportCoordinator`
  then resolves the env from `resolvedProperties.secrets` for the spawn.
- **Pre-condition / end-condition:** `preSecretNames` / `secretNames` go to
  `EndConditionEvaluator.executeScript`, which calls
  `resolveSecretEnvironment(secretNames)`.
- **Script step:** `getDeclaredSecretGrants(...)` goes to `evaluateCondition`
  and `resolveScriptEnvironment`.
- **Retry prompt:** `retrySecretNames` follows the same pattern.

The warn-mode tests in `src/test/unit/WorkflowExecutor.test.ts` use
`MockHarnessIntegration` with no conditions, so the downstream re-resolution
never runs.

## Suggested Fix

Make `resolveGrantedSecretValues` also return the names that actually resolved,
for example `{ values, resolvedNames }`. Use that filtered list everywhere the
grants are forwarded: `resolvedProperties.secrets`, the pre/end-condition secret
names, the script step's secret names, and the retry prompt's secret names.

This single-sources the filtering at the one place that already decided
warn-versus-fail. An unresolved `${secret:X}` interpolation should still throw
where it is used. Fail mode is unchanged: the throw already happens inside
`resolveGrantedSecretValues`.

Tests in `src/test/unit/WorkflowExecutor.test.ts`:

- Warn mode with `!MISSING` and an `endCondition`: the condition script runs and
  passes.
- The resolved properties handed to the integration do not include the missing
  name.
- A `type: script` step variant of the same case.
