# A failed Windows launcher lookup is cached for the life of the process, so the harness keeps failing with ENOENT

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/core/harness/shared/CliLauncherResolver.ts`
- **Resolution:** fixed in this commit

## Symptom

On Windows, if the first launcher lookup for an npm-installed harness CLI (`codex`, `qwen`, `opencode`) fails, that failure is cached until the process exits. The lookup fails when the CLI isn't installed yet, or when the `Get-Command` PowerShell probe times out or errors.

The cached fallback is a bare-name `direct` launcher. Every later availability check, version/help probe, headless run and interactive spawn then fails with `ENOENT`. The harness reports as not installed even after the user installs it, and stays that way until VS Code or the CLI/MCP process restarts.

## Steps to Reproduce

1. On Windows, make sure the codex CLI is not installed globally (no `codex.cmd` on `PATH`).
2. Open a workspace in VS Code with ctrlyoke so harness availability detection runs. This calls `CliProviderUtils.runVersionCommand('codex --version')`, which calls `resolveCliCommand('codex', ...)`.
3. `Get-Command` returns nothing, so `resolveWindowsLauncher` returns `{ kind: "direct", command: "codex" }`, and that result is stored in `launcherCache`.
4. Without restarting VS Code, run `npm install -g @openai/codex` in a terminal.
5. Run a workflow step with harness `codex-cli`, or trigger a re-detection. `RetryableAsyncCache` re-runs the version probe, but `resolveCliCommand` returns the cached direct launcher. `execFile('codex', ...)` fails with `ENOENT`, so the harness stays unavailable or the step fails with `HARNESS_NOT_INSTALLED`.

Alternative trigger: on a loaded machine where the first `powershell -NoProfile -Command Get-Command codex` takes longer than 5 s, the same bad launcher is cached even though the CLI is installed.

## Root Cause

- `src/core/harness/shared/CliLauncherResolver.ts:45` declares a module-level `launcherCache` that is never cleared.
- `getCliLauncher` (lines 88-109) caches every resolution promise unconditionally at line 107. That includes the fallback results `resolveWindowsLauncher` returns when the metadata lookup fails (lines 117-126) or yields no path (lines 128-135).
- `getWindowsCommandMetadata` (lines 358-395) turns "not found" (empty stdout, line 383), the 5 s timeout (line 379) and any probe error (catch at line 389) into `undefined` without telling them apart.
- Spawn callers pass the bare command name to `execFile`/`node-pty` with no shell, and that can't resolve `.cmd` shims on Windows. The callers are `CliProviderUtils.ts:188-197`, `CliTransportCoordinator.ts:801-802` and `OpenCodeLogParser.ts:65`.
- This also defeats `RetryableAsyncCache` (`CliProviderUtils.ts:81-102`, used by the version/help caches at lines 159-167). That cache drops failed probes on purpose so that "a newly installed CLI" is detected (comment at lines 76-79). But its retry goes back through `resolveCliCommand` and gets the same bad launcher.

## Suggested Fix

Cache only successful, definitive resolutions:

- In `getCliLauncher`, keep the in-flight promise so concurrent callers still share one probe. When it settles to a fallback `direct` launcher with no `resolvedPath`, delete the cache entry so the next call probes again. Either have `resolveWindowsLauncher` return `{ launcher, cacheable: boolean }`, or check `launcher.kind === "direct" && !launcher.resolvedPath` after awaiting and call `launcherCache.delete(cacheKey)`, but only if the entry is still the same promise, as `RetryableAsyncCache` does.
- Also delete the entry if the promise rejects.
- Optionally export `invalidateCliLauncher(commandName)` and call it when a spawn fails with `ENOENT`.
- Add a unit test that stubs the metadata probe to fail once and then succeed, and asserts that the second `resolveCliCommand` call returns the resolved launcher.
