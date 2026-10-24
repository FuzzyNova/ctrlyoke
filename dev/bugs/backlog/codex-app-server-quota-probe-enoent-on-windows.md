# Codex quota probe spawns bare `codex` without the launcher resolver and always fails with ENOENT on Windows

- **Found:** 2026-10-24 by timeout-budget bug sweep workflow (harness-cli)
- **Area:** `src/core/harness/codex/CodexAppServerClient.ts`
- **Severity:** medium

## Symptom

On Windows, when Codex is installed through npm (`%APPDATA%\npm\codex.cmd`), the Codex app-server
quota probe never succeeds. Every refresh returns `CODEX_APP_SERVER_PROBE_FAILED`. Codex quota
appears only when rollout-log `rate_limits` happen to be pushed by `CodexLogParser`.

## Steps to Reproduce

1. On Windows, install Codex with npm. `where codex` lists `...\npm\codex` and `...\npm\codex.cmd`.
2. Let ctrlyoke refresh harness usage, or run
   `node -e "require('child_process').spawn('codex',['--version'],{stdio:['pipe','pipe','ignore']}).on('error',e=>console.log(e.code))"`.
3. The spawn fails at once with `ENOENT`, as it did during verification. Running `codex --version`
   through a shell works.

## Root Cause

- `src/core/harness/codex/CodexAppServerClient.ts:51-58`: `defaultSpawnProcess` calls
  `spawn(command, [...args], { stdio: [...] })` with no shell and no launcher resolution. It is called
  at :90-94 with the bare name `"codex"`. On Windows, libuv does not resolve a bare name to a `.cmd`
  shim.
- `src/core/harness/shared/usage/providers/CodexUsageProvider.ts:80` builds the client with no
  `spawnProcess` override. The version gate before the probe (`defaultGetVersion` →
  `CliProviderUtils.getCliVersion`, which calls `resolveCliCommand` in `CliProviderUtils.ts:190`)
  passes. The probe then fails, and :95-108 catches the error and returns
  `unsupportedQuota(CODEX_APP_SERVER_PROBE_FAILED)`.
- The equivalent Copilot probe already does this correctly:
  `src/core/harness/copilot/CopilotQuotaClient.ts:194` uses `resolveCliCommand` from
  `src/core/harness/shared/CliLauncherResolver.ts:61`. `OpenCodeLogParser.ts:71-78` does the same
  for `opencode export`.

## Suggested Fix

Route the spawn through `resolveCliCommand("codex", ["app-server", "--listen", "stdio://"])`. Spawn
`resolved.command` / `resolved.args` with `windowsVerbatimArguments: resolved.requiresShellVerbatimArgs`
and `windowsHide: true`, the way `CopilotQuotaClient` and `OpenCodeLogParser` do. Inject the resolver
through `CodexAppServerClientOptions` so tests can stub it. Add a test that asserts the resolver is
used.
