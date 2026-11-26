# Codex `sandbox: true` accepts an `additionalArgs` `--add-dir` that widens the writable roots

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli)
- **Area:** `src/core/harness/codex/CodexSandboxMapper.ts` (`findSandboxOverride`)
- **Resolution:** fixed in this commit

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

## Decision

**Refuse it** (2026-11-26). With `sandbox: true`, an `additionalArgs` `--add-dir`
(including `--add-dir=…`) is a sandbox override and is refused at launch, the same
way `sandbox_workspace_write.writable_roots` is, in both `workspace-write` and
`read-only` modes. The diagnostic names approved external roots as the supported
way to add a writable directory. This is a user-visible behavior change, so it
needs the `CHANGELOG.md` **Changed** entry and the `docs/harnesses/codex-cli.md`
update listed above in the same commit. Rejected alternative: documenting
`--add-dir` as an escape hatch, because it would let the dashboard report the
sandbox as On while the step writes outside the workspace.
