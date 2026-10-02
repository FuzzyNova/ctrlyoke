# `ctrlyoke secret check` stops at the first failing step and blames it for every unapproved grant

- **Found:** 2026-10-01 by bug-hunt final step (claude-cli), reproduced with the built CLI in a scratch workspace
- **Area:** `src/utils/SecretResolver.ts` (`preflightWorkflowSecrets`, ~428-480), `src/cli/SecretCommands.ts` (~205-214)
- **Severity:** low (medium confidence that the current behaviour is unintended)

## Symptom

The workflow declares workflow-level `secrets: [A]`, a prompt that uses `!B`,
and a script step with `secrets: [C]`.

- **Before approval:** `ctrlyoke secret check` lists A, B and C, all under
  scope "step 1", although C belongs to step 2. Each is reported as "missing"
  even when its environment variable is set, because the real problem is that
  the grant is unapproved.
- **After `trust-secret-grants --yes`, with no variables set:** it reports only
  A and B. C appears only after A and B are exported.
- **Exit codes:** `secret check` exits 1 for an unapproved grant, while `run`
  exits 2 for the same condition.

## Root Cause

- `failOnMissing` defaults to true, so the loop throws inside the first step
  that has missing grants.
- The unapproved-grant check runs on the whole workflow, but the error uses the
  current step's scope label.
- `formatUnapprovedSecretGrantError` reuses the "is missing" wording, and
  `isMissingSecretPreflightError` classifies errors by matching that message
  text.

## Suggested Fix

Collect missing names across all steps, then report them once. Report
unapproved grants separately with no step scope. Use a typed error, not
message-text matching, so `secret check` and `run` use the same exit code. Not
queued: this needs a decision on the intended exit-code contract for
`secret check`.
