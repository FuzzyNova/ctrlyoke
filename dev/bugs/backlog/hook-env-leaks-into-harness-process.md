# A hook's `env` is merged into the whole harness process, secrets included

- **Found:** 2026-10-12 by Claude while writing `docs/workflows/hooks.md`
- **Area:** `src/core/harness/shared/CliExecutionRunner.ts`
- **Severity:** high

## Symptom

The schema describes a hook's `env` as the "Environment map consumed by the hook process"
(`schemas/workflow-schema.json:1811`). In practice, ctrlyoke merges the `env` of every hook on
the step into the environment of the harness process itself. As a result:

- The AI harness and every shell or tool call the model makes can read every hook's variables.
  That includes values expanded from `${secret:NAME}`, so a secret granted only to a `stop` hook
  can be read with `echo $NAME` (or sent anywhere) by the model.
- Every hook sees every other hook's `env`, not just its own.
- Two hooks that set the same key silently overwrite each other. The last hook in the resolved
  list wins, and the value is applied to all hooks.

`docs/workflows/hooks.md` now documents the shared environment, but the schema contract and the
secrets model both imply a per-hook scope.

## Steps to Reproduce

1. Store a secret `DEPLOY_TOKEN` and approve the grant.
2. Run a Claude Code step with:
   ```yaml
   hooks:
     - event: stop
       command: node ./scripts/notify.js
       env:
         TOKEN: "${secret:DEPLOY_TOKEN}"
   ```
   and the prompt "Run `node -e "console.log(process.env.TOKEN.length)"` in the shell".
3. The model's shell command prints the token's length. The token is in the harness
   environment, not only in the hook's environment. (Output redaction masks the literal value
   in the transcript, but the model can still use or transform it.)
4. Add a second hook with `env: { TOKEN: other }`. Both hooks now receive `other`.

## Root Cause

`WorkflowExecutor` expands `${secret:...}` in each hook's `env` into plaintext
(`src/core/WorkflowExecutor.ts:2229-2243`, and again for retries at `:4566-4580`). Then
`CliExecutionRunner.buildHookProcessEnv` (`src/core/harness/shared/CliExecutionRunner.ts:580-588`)
flattens every hook's `env` into one object with `Object.fromEntries(...flatMap(...))`, so
duplicate keys collapse. `buildHarnessProcessEnv` spreads that object into the env for the
harness process (`:508-512`), and the transports pass it to the spawned CLI
(`src/core/harness/shared/CliTransportCoordinator.ts:180`, `:706`). Nothing else consumes
`hook.env`. No harness hook entry is written with its own environment (see
`ClaudeNotificationMonitor.ts:69-80`, `CopilotNotificationMonitor.ts:67-83`,
`QwenCliProvider.ts:684-706`, `CodexCliProvider.ts:653-673`, `AntigravityNotificationMonitor.ts:141-149`).

## Suggested Fix

Scope each hook's environment to that hook's command, and keep it out of the harness env:

- Wrap each user hook command in a small ctrlyoke launcher (like the notification scripts),
  for example `node ctrlyoke-hook-run.js <id>`. The launcher reads that hook's env from a
  per-step temp file (owner-only permissions, deleted with the step's other hook files),
  applies it, and execs the real command with stdin/stdout passed through. This keeps the
  stdin payload and the `permissionRequest` stdout contract intact on every harness.
- Better still, resolve `${secret:...}` inside the launcher at hook run time, so a plaintext
  secret is never written to disk or placed in the harness environment.
- Where a harness's hook format supports a per-hook `env` field natively, that can replace the
  wrapper for that harness.

Then remove `buildHookProcessEnv` from `buildHarnessProcessEnv`, add a test that one hook's
env reaches neither the harness env nor another hook, and update the "Environment" section of
`docs/workflows/hooks.md`.
