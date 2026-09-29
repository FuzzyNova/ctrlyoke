# A secret-grant "deny" can never be undone, and the CLI's recovery advice is a no-op

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/cli/SecretCommands.ts` (`trustSecretGrantsCommand`, around lines 250-285), `src/config/SecretGrantsTrustStore.ts` (`getPendingGrants`)
- **Severity:** high

## Symptom

Running `ctrlyoke trust-secret-grants <file>` without `--yes` in a non-interactive shell (CI, a
script, an agent) records every requested grant as **denied**. It then prints "They remain
blocked — rerun with --yes or approve interactively." Rerunning with `--yes` prints "No pending
secret grants to approve for this workflow." and changes nothing. `ctrlyoke run` then fails at
`preflightWorkflowSecrets` with "Approve it with `ctrlyoke trust-secret-grants <file>`", which is
the command that just did nothing. Nothing in the CLI or the VS Code prompt can reset the decision,
so the only way out is hand-editing the user-local trust file. An interactive "N" answer is stuck
the same way.

## Steps to Reproduce

Verified by an agent with the real `SecretGrantsTrustStore` on a temp store path and a workflow
declaring `DEPLOY_TOKEN`:

1. Non-interactive, no `--yes` → decision stored as `deny`, exit 0.
2. Same command with `--yes` → "No pending secret grants…", decision still `deny`.

## Root Cause

- `trustSecretGrantsCommand` stores `"deny"` whenever `confirmMutation` returns false. That
  includes the non-interactive case, where nobody was asked.
- `getPendingGrants` treats only grants with no recorded decision as pending, so a denied grant is
  never offered again. `SecretGrantsTrustPrompt` (VS Code) also works only from
  `getPendingGrants`.

## Suggested Fix

- When the run is non-interactive and there's no `--yes`, record nothing: report the grants and
  exit non-zero.
- Make `trust-secret-grants` offer every requested grant that isn't `allow` (pending **or**
  denied), so `--yes` or an interactive "y" re-approves a previous deny. The trust store needs a
  query for non-allowed grants, next to `getPendingGrants`.
- Keep the preflight error's advice true: after this fix the named command must actually work.
- Tests: the two-call scenario above ends with `allow`; the non-interactive no-`--yes` run leaves
  no decision recorded and exits non-zero.
