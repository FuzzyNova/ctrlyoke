# A sandbox enabled in Copilot's or Qwen's own settings blocks ctrlyoke

- **Found:** 2026-11-04 during the harness sandbox follow-up (design review)
- **Area:** `src/core/harness/copilot/CopilotCliProvider.ts`, `src/core/harness/qwen/QwenCliProvider.ts`, `src/core/harness/shared/SandboxCapabilities.ts`
- **Resolution:** fixed in this commit

## Symptom

A user who turned on Copilot CLI's sandbox (`/sandbox enable`, saved in
`~/.copilot/settings.json`) or Qwen Code's sandbox (`tools.sandbox` or
`QWEN_SANDBOX`) could not run ctrlyoke workflows on that harness. Phase 0
showed that Copilot's sandbox on 1.0.105 also contains ctrlyoke's MCP server and
hook scripts, which then cannot start or report completion. Qwen's sandbox wraps
the whole CLI, helpers included. ctrlyoke's `sandbox: false` passed nothing for
these harnesses, so there was no way to turn the sandbox off for a ctrlyoke run.

## Steps to Reproduce

1. Enable Copilot's sandbox in its own settings.
2. Run any ctrlyoke workflow on `copilot-cli`, with `sandbox` absent or `false`.
3. The MCP server and hooks fail inside the sandbox; the step never completes.

## Root Cause

Decision 3 of `dev/implemented/HARNESS_SANDBOX_PLAN.md` said `false` removes only
the containment ctrlyoke added and never turns off a sandbox enabled in the
harness's own settings, so the unsupported harnesses had no off switch.

## Fix

`sandbox: false` (Off, the shipped default) now passes each harness's off switch
through `UnsupportedSandboxMapper`: Copilot `--no-sandbox`, Qwen
`--sandbox=false` plus `QWEN_SANDBOX=false` (the env var outranks the flag), via
the provider's `setSandboxSpawnEnv` hook. `sandbox: null` keeps the old
behavior of passing nothing.

## Verification (2026-11-04, macOS)

Each harness's sandbox was turned on in its own user settings, and a headless
run was asked to `touch` a file in the home directory (outside the workspace):

| Harness         | Saved setting                                       | Launch                                                | Result                                  |
| --------------- | --------------------------------------------------- | ----------------------------------------------------- | --------------------------------------- |
| Copilot 1.0.105 | `sandbox.enabled: true`                             | no flag                                               | blocked (`Operation not permitted`)     |
| Copilot 1.0.105 | `sandbox.enabled: true`                             | `--no-sandbox`                                        | written; the saved setting is unchanged |
| Qwen 0.26.7     | `tools.sandbox: true` (Seatbelt, `permissive-open`) | no flag                                               | blocked                                 |
| Qwen 0.26.7     | `tools.sandbox: true`                               | `--sandbox=false`                                     | written                                 |
| Qwen 0.26.7     | `tools.sandbox: true`                               | `QWEN_SANDBOX=false`                                  | written                                 |
| Qwen 0.26.7     | `tools.sandbox: true`                               | `QWEN_SANDBOX=true --sandbox=false`                   | blocked: the env var outranks the flag  |
| Qwen 0.26.7     | `tools.sandbox: true`                               | `QWEN_SANDBOX=false --sandbox=false` (ctrlyoke's Off) | written                                 |

## Still open

- An organization policy that forces Copilot's sandbox still wins over
  `--no-sandbox`. ctrlyoke doesn't detect that case yet, so the step fails the way
  it did before this fix, without a clear message.
- Qwen's separate `tools.executionSandbox` setting can't be overridden from the
  command line.
