# An unapproved grant of a secret that has no value fails the workflow instead of warning

- **Found:** 2026-10-03 by Nathan, investigating run `bug-drain1-2026-10-03T21-29-10-807/run-2026-10-03T21-29-40-257Z` with Claude
- **Area:** `src/core/WorkflowExecutor.ts` (`resolveGrantedSecretValues`), `src/utils/SecretResolver.ts` (`assertSecretGrantTrust`)
- **Resolution:** fixed in this commit

## Symptom

A bug-drain workflow's final step appended a step whose prompt quoted a bug
report's test scenario, including a bang-prefixed secret name `B` inside
single backticks. Inline code is not masked, so that became a real grant of
secret `B`. No secret named `B` exists anywhere: not in the store and not in
the environment. The step still failed at dispatch and stopped the whole
workflow:

> Secret "B" is missing for scope "Fix secret check exit codes"
> (workspace/user or environment) — this grant has not been approved for this
> workspace. Approve it with "ctrlyoke trust-secret-grants <file>" ...

Granting `B` could never have given the step anything, so there was nothing
for the approval check to protect. Under the default
`execution.contextResolutionFailure: "warn"`, a granted secret with no value
only adds a warning status row and the step runs. This run should have done
the same.

## Steps to Reproduce

1. Use a workflow with no secret named `B` in the secret store or environment,
   and `execution.contextResolutionFailure` left at its default (`warn`).
2. While the workflow runs, append a step (e.g. via MCP `append_step`) whose
   prompt contains a bang followed by `B` outside a fenced block.
3. When that step starts, it fails with the unapproved-grant error and the
   workflow stops in ERROR. The harness is never launched.

## Root Cause

`WorkflowExecutor.resolveGrantedSecretValues` calls `assertSecretGrantTrust`
on every granted name before `findMissingSecretNames` runs. The trust check
throws for any unapproved name, whether or not that name resolves to a
value. The warn-mode path for missing names (status row, then drop the name
from the returned map) is therefore never reached for an unapproved name.

Steps appended mid-run make this likely. The workflow-start preflight
(`WorkflowStartupPipeline.preflightSecrets` → `approveSecretGrants`) only sees
the steps that exist at start. A step appended later reaches its first trust
check at dispatch, with no approval prompt, and the agent that wrote it is
never told.

The error text also mixes "is missing" with "has not been approved". That
wording is covered by `cli-secret-check-stops-at-first-step-and-misattributes-scope.md`.

## Suggested Fix

- In `resolveGrantedSecretValues`, find the missing names first, then call
  `assertSecretGrantTrust` only on names that actually resolve. Names that
  don't resolve go down the existing missing-secret path: a warning in `warn`
  mode, `MissingSecretError` in `fail` mode. Security is unchanged, because a
  name with no value grants nothing. The retry-prompt path calls the same method (the
  `retrySecretValues` call site), so it is covered by the same change.
- The warning should say that the grant was also unapproved, so the user
  knows to approve it once they add a value.
- Secondary: have MCP `append_step` (and the CLI `append`) report unapproved
  grants when a step is added, so the appending agent can fix its prompt
  right away rather than failing later at dispatch.
- Coordinate with the `cli-secret-check-stops-at-first-step-and-misattributes-scope.md`
  fix. It replaces message-text classification with typed errors
  (`MissingSecretsError`, `UnapprovedSecretGrantsError`), and this change
  should build on those types.
- Tests: an unapproved grant with no value warns and the step runs in `warn`
  mode; it throws `MissingSecretError` in `fail` mode; an unapproved grant
  whose value resolves still hard-fails.
