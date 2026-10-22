# Codex rejects the `untrusted` approval policy, so the setting crashes every interactive step

- **Found:** 2026-10-22 by Claude (harness capability suite), with codex-cli 0.163.0
- **Area:** `src/core/harness/codex/CodexToolPermissionMapper.ts`, `schemas/settings-schema.json` (`permissions.codexApprovalPolicy`)
- **Resolution:** fixed in this commit

## Symptom

With `permissions.codexApprovalPolicy: "untrusted"` in settings, an interactive Codex step in
`custom` mode exits at once:

```text
error: invalid value 'untrusted' for '--ask-for-approval <APPROVAL_POLICY>'
  [possible values: on-request, never]
```

ctrlyoke reports `CLI process exited unexpectedly while waiting for SessionStart hook (exit code 2)`.

## Steps to Reproduce

1. Workspace `.ctrlyoke/settings.json`: `{"permissions":{"codexApprovalPolicy":"untrusted"}}`.
2. Workflow: `{"harness":"codex-cli","executionMode":"interactive","toolPermissions":{"mode":"custom","allowedTools":[],"deniedTools":[]},"steps":[{"prompt":"Reply OK."}]}`
3. `node out/cli.js run <file> --interactive` fails before the TUI starts.

## Root Cause

Codex 0.163.0's `--ask-for-approval` accepts only `on-request` and `never`. ctrlyoke still offers
`untrusted` in the settings schema and passes the setting through unchanged in
`CodexToolPermissionMapper.buildCodexSpecificArgs()`. Which release removed it is not yet known;
the minimum (0.129.0) may still accept it.

## Suggested Fix

Find the release that dropped `untrusted` (`npm view @openai/codex versions` plus `--help` at a
few versions). Then either map `untrusted` to the nearest current behavior for CLIs that lack it,
or remove it from the schema with a settings migration in `FormatMigrations.ts` (a narrowed enum is
a schema bump), and note it under **Changed** in `CHANGELOG.md`.
