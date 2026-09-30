# Step-granted secret values are written to the extension host's global `process.env`, leaking to concurrent steps and outliving the step

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli); traced in code and reproduced with an overlapping-action script
- **Area:** `src/core/harness/shared/CliTransportCoordinator.ts` (`withProcessEnvOverrides` ~795-823, used at ~172, ~350, ~768), `src/core/harness/shared/CliProviderUtils.ts` (`buildProcessEnv` copies `process.env`), `src/utils/SecretResolver.ts` (`resolveSecretValues` checks the environment first)
- **Severity:** high (security: secrets reach steps and workflows that were not granted them)

## Symptom

`withProcessEnvOverrides` sets each resolved secret in the global `process.env` for the
whole `action()` (for headless and standalone-interactive runs, the harness process
lifetime) and restores the value it captured beforehand when the action ends. Secrets
are already passed to the child through its `env` option, so the global write is
unnecessary for the child and harmful for everything else in the host:

- Any other process spawned meanwhile (a parallel-group sibling, a concurrent workflow,
  a script step, a hook) inherits the secret via `buildProcessEnv()`.
- Overlapping steps restore in the wrong order. Step A (granted `API_TOKEN=secret-A`)
  starts; step C (granted `API_TOKEN=secret-C`) starts while A runs and captures
  `secret-A` as the "previous" value; A ends and restores `undefined`; C ends and
  restores `secret-A`. After both finish, `process.env.API_TOKEN` is still `secret-A`.
- Because `resolveSecretValues` checks the environment first, later runs silently use
  that leftover value with source `environment`, even after the stored secret is changed
  or deleted.

## Steps to Reproduce

1. A parallel group with two AI steps, each granted `API_TOKEN` resolving to different
   stored values, where the first-started step finishes first.
2. After the group, run a script step with no grants printing `$API_TOKEN` (or
   `ctrlyoke secret check`), in the same extension host: the value is still present.

## Root Cause

Using process-global state for a per-process concern, with save/restore that isn't safe
under concurrency.

## Suggested Fix

Remove `withProcessEnvOverrides` and pass secrets only through the spawned child's `env`
(already done at each call site: `{ ...interactiveEnv, ...env, ...secretEnv }`). If any
provider reads `process.env` while building its command/config during `action()`, give
it the explicit env object instead (grep the providers for `process.env` reads in
command/config building). Tests: after an overlapping pair of actions `process.env`
is unchanged; a sibling spawn during a granted step does not see the secret.
