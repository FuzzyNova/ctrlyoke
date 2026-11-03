# Codex additionalArgs can override sandbox: true

- **Found:** 2026-11-03 by the harness sandbox follow-up review
- **Area:** `src/core/harness/codex/CodexSandboxMapper.ts`, `src/core/harness/codex/CodexCliProvider.ts`
- **Severity:** medium

## Symptom

A Codex step with `sandbox: true` is meant to fail closed whenever ctrlyoke
cannot guarantee containment (decision 4 in
`dev/implemented/HARNESS_SANDBOX_PLAN.md`). The sandbox mapper never looks at
`additionalArgs`, so the user's own flags can contradict the `-s` ctrlyoke
emits. Dry Run still reports "Sandboxed: Codex workspace-write, network off":

- `--dangerously-bypass-approvals-and-sandbox` together with `-s workspace-write`.
- A second `-s danger-full-access` / `--sandbox danger-full-access`.
- `-c sandbox_mode="danger-full-access"`, or a `-c sandbox_workspace_write.*`
  override, for example `network_access=true`, which would make the documented
  "network off" untrue.

The Claude equivalent (a user `--settings` replacing the sandbox settings) was
fixed in the same review: `ClaudeSandboxMapper` now reports an error diagnostic
and the launch is refused.

## Steps to Reproduce

1. Create a Codex step with `sandbox: true` and
   `additionalArgs: "--dangerously-bypass-approvals-and-sandbox"`.
2. Run Dry Run and look at the command and the Sandbox line.
3. Run it (opt-in harness test) and ask the agent to write a file outside the
   workspace. **Unprobed:** depending on how Codex 0.166.0 resolves the
   conflict, it either rejects the arguments (safe) or runs unsandboxed
   (unsafe).

## Root Cause

`CodexCliProvider` adds `additionalArgs` before the permission arguments, and
`ExecutionPlanBuilder` appends the sandbox mapper's `-s` after them. Nothing
checks for conflicting containment flags. `SandboxContext.additionalArgs` is
passed to the mapper but `CodexSandboxMapper.prepare` ignores it.

## Suggested Fix

First probe Codex 0.166.0 with each conflicting form: duplicate `-s`, bypass
plus `-s`, and the `-c` overrides. Then, in `CodexSandboxMapper.prepare`, when
`request === true`, return an error diagnostic (same shape as Claude's
`SANDBOX_SETTINGS_OVERRIDDEN`) for every form that widens containment. Use
`hasCliFlag` from `src/utils/CliArgParser.ts`. For `-c`, match the
`sandbox_mode` and `sandbox_workspace_write.` key prefixes. Add the cases to
`src/test/unit/SandboxMappers.test.ts` and the bypass case to
`src/test/harness/sandbox.harness.test.ts`.
