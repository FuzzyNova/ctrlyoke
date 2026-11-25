# `secret check --json` reports `missingNames: []` when grants are unapproved and values are missing

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude subagent, reproduced with `node out/cli.js`)
- **Area:** `src/cli/SecretCommands.ts` (`checkSecretsCommand` catch ~271-281)
- **Severity:** low (CI scripts reading `--json` get a result that contradicts its own error message)

## Symptom

When a workflow's secret grant has not been approved and the secret's value is also
missing, `ctrlyoke secret check --json` exits 2 with an error message that names the
missing secret, but `missingNames` is empty.

## Steps to Reproduce

1. A workflow `sec.ctrlyoke.yaml` declaring `secrets: [MY_TOKEN]`, no grant approved,
   `MY_TOKEN` not set anywhere.
2. `ctrlyoke secret check sec.ctrlyoke.yaml --json`
3. Output (exit 2):

```json
{
  "schemaVersion": 1,
  "success": false,
  "error": {
    "message": "Secret check failed: Secret grant \"MY_TOKEN\" has not been approved ... Secret \"MY_TOKEN\" is missing for scope \"workflow\" ..."
  },
  "filesChecked": ["..."],
  "missingNames": []
}
```

## Expected

`missingNames: ["MY_TOKEN"]`. `docs/cli/ctrlyoke.md` (~572-579) says that when grants are
unapproved and values are also missing "both problems are shown", and that JSON
"reports the checked file and missing secret names"; `docs/cli/ci.md` (~149) says the
same.

## Root Cause

The catch in `checkSecretsCommand` fills `missingNames` only for `MissingSecretsError`
and hardcodes `[]` otherwise. `UnapprovedSecretGrantsError`
(`src/utils/SecretResolver.ts` ~82-100) carries the missing values in `missingSecrets`.

## Suggested Fix

For `UnapprovedSecretGrantsError`, emit
`missingNames: error.missingSecrets.map(({ name }) => name)` (deduplicated). Keep exit
code 2. Optionally add an additive `unapprovedGrants: error.secretNames` field to the
envelope (additive within `schemaVersion: 1`) and document it.

Test: a `checkSecretsCommand` case with an unapproved grant and a missing value asserts
exit 2 and `missingNames` equal to `["MY_TOKEN"]`; an unapproved grant whose value is
present asserts `missingNames: []`.
