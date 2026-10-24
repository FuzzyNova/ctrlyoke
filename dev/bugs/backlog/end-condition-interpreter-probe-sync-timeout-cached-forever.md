# PowerShell/Python interpreter probe blocks the extension host and caches a timeout as "not installed" for the life of the process

- **Found:** 2026-10-24 by timeout-budget bug sweep workflow (core-orchestration)
- **Area:** `src/core/EndConditionEvaluator.ts`
- **Severity:** medium

## Symptom

The first PowerShell end condition or script step on Windows (or the first Python one on Linux/macOS) runs a synchronous `pwsh -Version` (or `python3 --version`) probe with a 5 s timeout. Two things go wrong:

1. The probe uses `execSync`, so the extension host's event loop is blocked until it returns. On a cold start this can last up to 5 s, and during that time every dashboard route, hosted-server request and running workflow is frozen.
2. Any probe failure, the timeout included, is treated as "pwsh is not installed". The fallback `powershell.exe` (or `python`) is stored in a module-level map that is never cleared. Every PowerShell condition and script for the rest of the session then runs under Windows PowerShell 5.1. Scripts that use PS7-only syntax (`&&`/`||`, the ternary operator, `??`, `ForEach-Object -Parallel`) fail, and the verdict looks like the user's own script failing. Nothing says the interpreter was downgraded; it only appears in a debug-level log line.

The same thing happens when the user installs PowerShell 7 or Python 3 after the first probe: the result stays stale until VS Code, the CLI or the MCP server restarts.

## Steps to Reproduce

1. On Windows with PowerShell 7 installed, make the first `pwsh` start slow: run right after boot or resume while Defender scans `pwsh.exe` and its .NET assemblies, or on a heavily loaded machine. The probe has to take more than 5 s.
2. Run a workflow whose end condition is a `.ps1` file, or an inline PowerShell script, that uses `$a ?? $b` or `cmd1 && cmd2`.
3. The probe times out, `powershell.exe` is cached, and the condition fails with a parser error from Windows PowerShell 5.1.
4. Every later PowerShell condition in the same VS Code session also runs under 5.1, even after `pwsh` has warmed up.

Alternative: start VS Code without `pwsh` installed, run one PowerShell condition, install PowerShell 7, then run the workflow again. It still uses 5.1.

## Root Cause

- `src/core/EndConditionEvaluator.ts:59-60` declares module-level `pythonExecutables` / `powerShellExecutables` maps that are never cleared or invalidated.
- `resolvePowerShellExecutable` (`src/core/EndConditionEvaluator.ts:1032-1057`) runs `execSync("pwsh -Version", { stdio: "ignore", timeout: 5000 })` at line 1045. Its `catch` at line 1047 handles ENOENT, a non-zero exit and the timeout the same way, and line 1052 caches the fallback unconditionally.
- `resolvePythonExecutable` (`src/core/EndConditionEvaluator.ts:1001-1026`) does the same with `python3 --version` (line 1014, catch at 1016, cache at 1021).
- The callers are the script-file and condition command builders at lines 693, 712, 810 and 832. They run on the extension-host thread (and in the CLI/MCP process), so the `execSync` blocks everything else in that process.
- The fix for `dev/bugs/implemented/windows-launcher-lookup-failure-cached-for-process-lifetime.md` (`CliLauncherResolver.ts`) solved this same problem for harness launchers but did not touch this separate probe.

## Suggested Fix

The right fix is an async probe that only caches definitive results, not a larger timeout:

- Replace `execSync` with an async `execFile` (no shell) and make the resolvers return a `Promise<string>`. All the call sites are already inside async evaluation paths. Keep the in-flight promise in the map so concurrent callers share one probe, as `RetryableAsyncCache` in `src/core/harness/shared/CliProviderUtils.ts` does.
- Cache only definitive answers: a successful probe (`pwsh`), or a clean "not found" (ENOENT). On a timeout or any other error, use the fallback for that one call, delete the cache entry and log a warning that names the downgrade. The next condition then probes again.
- Optionally invalidate the cached entry when a spawn with the cached interpreter fails with ENOENT, so a later install or uninstall is picked up.
- Add a unit test that stubs the probe to time out once and then succeed, and asserts that the second resolution returns `pwsh`.
