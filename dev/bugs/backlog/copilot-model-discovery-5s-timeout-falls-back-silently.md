# Copilot model discovery uses a 5 s timeout, short of the project's own 30 s CLI help-check policy, and falls back to the built-in list for the whole session

- **Found:** 2026-10-24 by timeout-budget bug sweep workflow (utils-git-config)
- **Area:** `src/utils/ModelRegistry.ts`
- **Severity:** low

## Symptom

`queryCopilotCliModels` runs `copilot help config` with a hard-coded 5000 ms
timeout. The project defines `CLI_VERSION_CHECK_TIMEOUT_MS = 30_000` for
exactly this kind of subprocess ("CLI version/help-check subprocesses"). It was
raised to 30 s in `a8da2a49a` because Node-based CLIs can start slowly on
Windows (cold start, antivirus scanning, update checks), and the same file
already uses that constant for the opencode and `agy --version` probes.

Discovery runs during activation, when the machine is busiest. A timeout is not
a "being used by another process" error, so `stopRetrying` ends the retries at
once and the outer catch uses `FALLBACK_COPILOT_CLI_MODELS`.
`initializeModelRegistry` queries only once, so the possibly stale fallback
list is used for the whole session, with only an info-level log line. Warm, the
command takes about 0.5 s, so this hits only slow cold starts, but then it
hides newly released Copilot models until the editor is restarted.

## Steps to Reproduce

1. On Windows, cold-boot (or have Defender scan the Copilot CLI package) so
   that `copilot help config` takes more than 5 s.
2. Open VS Code with ctrlyoke.
3. The Copilot model picker shows only the built-in fallback list, and the log
   says it is using the fallback list.

## Root Cause

- `src/utils/ModelRegistry.ts:133`: `execDiscoveryCommand("copilot help config", 5000)`.
- `:141`: `stopRetrying(error)` for every non-lock error, including a timeout.
- `:85-108`: `initializeModelRegistry` runs once per session, with no later
  refresh after a timeout.
- `src/core/harness/shared/interfaces/ICliProvider.ts:35-36`:
  `CLI_VERSION_CHECK_TIMEOUT_MS = 30_000`, already used at `ModelRegistry.ts:422`.
- `opencode models --verbose` at `:214` likewise uses a fixed 10 s.

## Suggested Fix

Use `CLI_VERSION_CHECK_TIMEOUT_MS` for both discovery commands instead of the
5000 / 10000 literals. Discovery runs in the background, so the longer wait
blocks nothing. Also, when discovery timed out (as opposed to the CLI being
absent), clear `isInitialized` for that harness or schedule a later re-query,
so one slow start does not pin the fallback list for the whole session.
