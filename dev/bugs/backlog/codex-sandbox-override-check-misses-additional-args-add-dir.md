# Codex `sandbox: true` accepts an `additionalArgs` `--add-dir` that widens the writable roots

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli)
- **Area:** `src/core/harness/codex/CodexSandboxMapper.ts` (`findSandboxOverride`)
- **Severity:** medium

## Symptom

A Codex step with `sandbox: true` is refused at launch when `additionalArgs`
would widen the sandbox ctrlyoke sets. That covers
`-c sandbox_workspace_write.writable_roots=[…]`, which `docs/harnesses/codex-cli.md:114`
rejects because it "can add writable roots". But `additionalArgs: "--add-dir /some/dir"`
adds the same writable root and is accepted without a diagnostic. The run starts
with `-s workspace-write` and the dashboard reports the sandbox as On. Codex can
then write to `/some/dir`, which is outside the workspace and is not an approved
external root.

Under `sandboxMode: read-only` the same argument is not a widening problem but a
launch failure: interactive Codex exits with "Error adding directories" for any
`--add-dir` (0.163–0.166). `CodexHarnessAdapter.ts:567-580` drops ctrlyoke's own
`--add-dir` entries in read-only mode for exactly that reason, but passes the
user's through unchanged at line ~607.

## Steps to Reproduce

1. Workflow step on `codex-cli` with `sandbox: true`, `sandboxMode: workspace-write`
   and `additionalArgs: "--add-dir /tmp/outside"`.
2. Run it. No `sandboxOverriddenDiagnostic` is raised. The command line contains
   `-s workspace-write … --add-dir /tmp/outside`, and the step can write under
   `/tmp/outside`.
3. Replace the args with `-c sandbox_workspace_write.writable_roots=["/tmp/outside"]`:
   the step is refused at launch with "sandbox: true cannot be applied on Codex …".

## Root Cause

`findSandboxOverride` (`CodexSandboxMapper.ts:67-79`) checks only the bypass
flags, `-s/--sandbox`, and `-c` keys that match `CODEX_SANDBOX_CONFIG_KEY`.
`--add-dir` (`CODEX_EXEC_ARGUMENTS.ADD_DIR` in `CodexProtocolConstants.ts:46`) is
not in the list, even though it does the same thing as the refused
`sandbox_workspace_write.writable_roots` override.

## Suggested Fix

Treat `--add-dir` in `additionalArgs` as a sandbox override when `request === true`,
using `hasCliFlag(additionalArgs, ["--add-dir"])` (it also catches `--add-dir=…`).
Point the diagnostic to approved external roots (`docs/workflows/permissions.md`
"External roots and the sandbox") as the supported way to add a writable directory.
Update the refused-forms list in `docs/harnesses/codex-cli.md:114`, extend
`src/test/unit/SandboxMappers.test.ts`, and add a **Changed** entry to
`CHANGELOG.md`, because a workflow that runs today would be refused at launch.

**Needs a decision:** the fix is a behavior change, since a currently accepted
`additionalArgs` value starts failing at launch. The alternative is to document
`--add-dir` as an intentional escape hatch, and still drop or refuse it under
`read-only`, where it only ever crashes interactive Codex.
