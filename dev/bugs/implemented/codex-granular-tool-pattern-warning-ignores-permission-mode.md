# Codex "does not support granular tool patterns" warning fires on every spawn, even when tool lists don't apply

- **Found:** 2026-10-19 by Claude Code (log review)
- **Area:** `src/core/harness/codex/CodexToolPermissionMapper.ts`
- **Resolution:** fixed in this commit

## Symptom

Every Codex step logs the same warning, even when the workflow's permission mode ignores tool lists entirely. Across `.ctrlyoke/logs/` it appears 104 times. In `ctrlyoke-1792245054191.log` it appears once per Codex step:

```
[2026-10-17T13:53:54.469Z] INFO: [WorkflowExecutor] Executing prompt 1/5
[2026-10-17T13:53:54.639Z] INFO: [CodexCliProvider] Starting new session
[2026-10-17T13:53:54.642Z] WARN: [CodexToolPermissionMapper] Codex CLI does not support granular tool patterns (cliAllowedTools/cliDeniedTools). Use Codex-specific sandbox/approval settings for custom control.
[2026-10-17T14:15:55.022Z] INFO: [WorkflowExecutor] Executing prompt 2/5
[2026-10-17T14:15:55.372Z] WARN: [CodexToolPermissionMapper] Codex CLI does not support granular tool patterns ...
... (steps 3/5, 4/5, 5/5, 6/6 likewise)
```

The user's `~/.ctrlyoke/settings.json` has `defaults.toolPermissions.mode: "dangerouslyAllowAll"` with non-empty `allowedTools`/`deniedTools`. Those lists only matter for the other harnesses in `custom`/`allowAll` modes. In this mode no harness applies them, so the warning does not apply to anything the user configured. The shared, mode-aware compatibility diagnostic correctly stays silent: there are no `[PermissionCompatibility]` lines in that log.

## Steps to Reproduce

1. Set `defaults.toolPermissions.mode` to `dangerouslyAllowAll` (or any mode other than `custom`), and keep non-empty `allowedTools`/`deniedTools`. These are typically kept for other harnesses.
2. Run any multi-step workflow on `codex-cli`.
3. Each step's spawn logs the WARN above.

## Root Cause

`CodexToolPermissionMapper.buildCodexSpecificArgs` (`CodexToolPermissionMapper.ts:155-159`) warns whenever `config.allowedTools.length > 0 || config.deniedTools.length > 0`. It never checks `config.mode`. It runs once per spawn from `prepare()` (`:113-128`), so the message repeats on every step of every run.

The same `prepare()` also returns `getToolTranslationDiagnostics(config, HARNESS_IDS.CODEX_CLI)` (`shared/interfaces/IToolPermissionMapper.ts:114-150`). That is the shared fidelity diagnostic, and it already:

- skips lists the current mode does not apply (`permissionModeAppliesToolList`, `src/types/DashboardConstants.ts:4286-4295`: allowed tools only in `custom`; denied tools only in `allowAll`/`custom`), and
- is logged as `[PermissionCompatibility] …` and passed to `reportCompatibilityDiagnostics` by `CliIntegration` (`src/core/harness/CliIntegration.ts:1298-1319`).

So the Codex-specific `Log.warn` is a legacy duplicate of the structured diagnostic. It is the only one of the two that ignores the permission mode.

## Suggested Fix

- Remove the ad-hoc `Log.warn` from `buildCodexSpecificArgs` and rely on `getToolTranslationDiagnostics`, which is mode-aware and reaches the UI. If Codex's capability declaration (`CODEX_PERMISSION_CAPABILITIES`) does not yet give a diagnostic code for unsupported tool lists, fix the declaration rather than keeping the log line.
- If a log line is still wanted, guard it with `permissionModeAppliesToolList(config.mode, …)`, and consider logging it once per workflow run rather than once per spawn.
- Add a mapper unit test: `dangerouslyAllowAll` with non-empty lists produces no warning or diagnostic, and `custom` with lists produces exactly one diagnostic.
