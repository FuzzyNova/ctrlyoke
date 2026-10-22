# Codex will not start in a read-only sandbox because ctrlyoke always passes `--add-dir`

- **Found:** 2026-10-22 by Claude (harness capability suite), with codex-cli 0.163.0
- **Area:** `src/core/harness/codex/CodexCliProvider.ts` (`--add-dir` assembly), `src/core/harness/codex/CodexToolPermissionMapper.ts`
- **Resolution:** fixed in this commit

## Symptom

Any interactive Codex step whose sandbox resolves to `read-only` exits before the TUI starts:

```text
Error adding directories: Ignoring --add-dir (<workspace>) because the effective permissions do not
allow additional writable roots. Switch to workspace-write or danger-full-access to allow them.
```

ctrlyoke reports `CLI process exited unexpectedly while waiting for SessionStart hook (exit code 1)`.
Two paths reach `read-only`:

- the user setting `permissions.codexSandboxMode: "read-only"` in `custom` mode;
- ctrlyoke's own fail-closed choice in `buildCodexSpecificArgs()` when a `custom` config denies a
  write-capable tool (`deniesWriteCapableTool`), which returns `--sandbox read-only`.

## Steps to Reproduce

1. Workspace `.ctrlyoke/settings.json`: `{"permissions":{"codexSandboxMode":"read-only","codexApprovalPolicy":"on-request"}}`.
2. Workflow: `{"harness":"codex-cli","executionMode":"interactive","toolPermissions":{"mode":"custom","allowedTools":[],"deniedTools":[]},"steps":[{"prompt":"Reply OK."}]}`
3. `node out/cli.js run <file> --interactive` fails at startup.

Headless (`codex exec`) was not checked.

## Root Cause

`CodexCliProvider` always adds `--add-dir` for the workspace root and every approved external root
(`CliProviderUtils.getWorkspaceDirs`). Codex 0.163.0 treats `--add-dir` as an extra writable root
and refuses it under a read-only sandbox. The workspace root is already Codex's working directory,
so passing it as `--add-dir` grants nothing.

## Suggested Fix

Skip `--add-dir` for Codex when the resolved sandbox is `read-only` (an external root there could
only be read anyway), and stop passing the cwd itself as `--add-dir`. Add a capability-suite case
for a `custom` config that denies `write`, which takes the fail-closed read-only path.
