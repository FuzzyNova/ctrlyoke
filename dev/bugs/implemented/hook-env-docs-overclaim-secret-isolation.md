# Hook `env` docs promise secret isolation the env file does not provide

- **Found:** 2026-10-12 by Claude (bug-drain review of ~33d934f87)
- **Area:** `src/core/harness/shared/UserHookEnvironment.ts`, `docs/workflows/hooks.md`, `schemas/workflow-schema.json`
- **Resolution:** fixed in this commit

## Symptom

After ~33d934f87, `docs/workflows/hooks.md` and the schema's hook `env` description say hook
values are "not available to the AI harness" and that "Resolved secret values are passed only to
the hook that declares them". That is not true:

- Resolved values, secrets included, are written as plaintext JSON to
  `<workspace>/.ctrlyoke/temp/<cli>-notifications/user-hook-env-*.json`
  (`ExecutionPlanBuilder.ts`, `UserHookEnvironment.ts:30`). That is inside the workspace the
  model is working in, and the file exists for the whole step. The model can `cat` it.
- The owner-only `0o600` mode does nothing against the harness, which runs as the same user. On
  Windows the mode is skipped entirely (`UserHookEnvironment.ts:60`) and nothing says so.

The values are no longer in the harness process environment, which was the main fix, but the docs
now describe a security boundary that does not exist.

## Root Cause

The fix moved values out of the harness env but kept them on disk where the same user (and so the
model's shell) can read them. Real isolation would need the secret resolved at hook run time by
something the model cannot invoke, which ctrlyoke's platform secret store does not currently allow
from a child process.

## Suggested Fix

1. Write the env file outside the workspace, under ctrlyoke's per-user state temp area (the same
   root `WorkflowPaths`/state home uses), so it is not sitting in the model's working tree.
2. Rewrite the hook `env` schema description and `docs/workflows/hooks.md` to state the actual
   guarantee: each hook gets only its own `env`, values are not in the harness process
   environment, and secrets are written to a per-step temp file readable by the local user, so
   they are not hidden from a model that has shell access. Run `npm run schema:update` and
   `npm run check:docs`.
3. Whether to pursue true isolation (resolve-at-run-time) is a product decision; do not attempt it
   in this fix.
