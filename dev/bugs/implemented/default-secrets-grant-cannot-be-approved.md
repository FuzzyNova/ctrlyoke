# `defaults.secrets` grants prompt steps a secret that no approval flow can approve

- **Found:** 2026-11-13 by the bug-hunt workflow final step (claude-cli)
- **Area:** `src/utils/SecretResolver.ts` (`getDeclaredSecretGrants`), `src/types/ExecutionPropertyResolver.ts` (`resolveSecrets`)
- **Resolution:** fixed in this commit

## Symptom

With `defaults.secrets: ["CYHUNT_TOKEN"]` in settings and a workflow that sets no
`secrets`, every prompt step fails at start:

```
Secret grant "CYHUNT_TOKEN" has not been approved for this workspace. Approve it
with "ctrlyoke trust-secret-grants <file>" (or from the ctrlyoke panel in VS Code), then re-run.
```

But the approval it points to can't approve the name:

- `ctrlyoke trust-secret-grants <file> --yes` prints "No pending secret grants
  to approve for this workflow."
- `ctrlyoke secret check <file>` exits 0 with "all declared secrets are
  resolvable".
- The pre-run approval prompt in VS Code/dashboard doesn't list it either, since
  it uses the same grant list.

The only way out is to copy the name into the workflow's own `secrets:` list.

There is also an inconsistency between step types. A prompt step receives the
settings default, but a script step does not, and neither does the export
redaction list.

## Steps to Reproduce

1. In a scratch git repo, write `.ctrlyoke/settings.json` as
   `{ "defaults": { "secrets": ["CYHUNT_TOKEN"] } }`.
2. Write a workflow with one prompt step and no `secrets` (harness
   `opencode-cli`, model `opencode/big-pickle`, `executionMode: headless`).
3. `CYHUNT_TOKEN=x ctrlyoke trust-secret-grants wf.ctrlyoke.yaml --yes` says
   nothing is pending.
4. `CYHUNT_TOKEN=x ctrlyoke run wf.ctrlyoke.yaml --headless` fails with the
   unapproved-grant error above.

## Root Cause

There are two sources of truth for a step's secret grants:

- **Runtime (prompt steps):** `WorkflowExecutor` builds the grant list from
  `SettingsPropertyResolver.resolve(...).secrets`. That goes through
  `ExecutionPropertyResolver.resolveSecrets`, which is
  `select(prompt.secrets, workflow.secrets, defaults.secrets)`. The settings
  default is filled in by `SettingsPropertyResolver.createDefaults`
  (`secrets: ConfigurationUtils.getDefaultSecrets()`). `resolveGrantedSecretValues`
  then calls `assertSecretGrantTrust` on it.
- **Everything else:** `getDeclaredSecretGrants(step, workflow)` uses
  `step.secrets !== undefined ? step.secrets : workflow.secrets` and never falls
  back to `defaults.secrets`. It drives:
  - the pre-run approval list (`stepsAwaitingExecution` / `trust-secret-grants`)
  - the missing-value check (`secret check`)
  - script-step grants (`WorkflowExecutor`, the `getDeclaredSecretGrants` call
    in the script-step path)
  - import preview (`RunImportPreview`)
  - export redaction (`resolveRunBundleSecrets` in `RunBundleExporter.ts`)

The dashboard already treats `defaults.secrets` as an inherited value. The step
drawer's `SecretGrantsEditor` shows "Inherit (<names>)" from the resolved list.
So the runtime fallback is the intended meaning, and `getDeclaredSecretGrants`
is the outlier.

## Suggested Fix

Make the grant list single-sourced. `getDeclaredSecretGrants` should take the
same settings fallback the runtime uses: when neither the step nor the workflow
sets `secrets` (both `undefined`; an explicit `null` still clears), fall back
to `ConfigurationUtils.getDefaultSecrets()`. Ideally, derive it from
`ExecutionPropertyResolver`'s `select` so the two can't drift again. Every
caller listed above then sees the same names the prompt step is granted, and
script steps receive the default too.

Also fix `docs/workflows/secrets.md`, which says `defaults.secrets` "sets the
list for new workflows", and the `defaults.secrets` schema description
("granted to new workflows"). Both should say it is the list a workflow inherits
when it sets no `secrets` of its own. A schema description change needs
`npm run schema:update`.
