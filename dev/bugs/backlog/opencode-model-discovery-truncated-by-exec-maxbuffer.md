# OpenCode model discovery uses exec's 1 MiB maxBuffer and parses the truncated output as the full model list

- **Found:** 2026-10-24 by timeout-budget bug sweep workflow (utils-git-config)
- **Area:** `src/utils/ModelRegistry.ts`
- **Severity:** medium

## Symptom

`queryOpenCodeModels` runs `opencode models --verbose` through
`execDiscoveryCommand` (`promisify(exec)`) with no `maxBuffer`, so Node's 1 MiB
default applies. The verbose output is about 1.3 KB per model (an ID line plus
a JSON block) and grows with every configured provider. On the dev machine it
is already 695,061 bytes. Adding a provider with hundreds of models (OpenRouter
alone lists several hundred) pushes it over 1 MiB.

On overflow Node kills opencode and rejects with
`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`. The error carries the first 1 MiB of
stdout. The catch block, written to recover output from opencode's occasional
non-zero exit, sees that `execError.stdout` is non-empty and parses it. The
model list then silently stops partway through: providers late in the output
disappear from the model picker and from `cachedOpenCodeContextWindows`, the
last JSON block is cut off, and the result is logged as a complete
`OpenCode reports N models`. The fixed 10 s timeout has the same shape: on a
timeout the partial stdout is also parsed as if it were complete.

## Steps to Reproduce

1. Configure enough opencode providers that `opencode models --verbose | wc -c`
   exceeds 1,048,576.
2. Start ctrlyoke (activation calls `initializeModelRegistry`).
3. Models from providers listed last are missing from the OpenCode model
   picker. The log shows "exited non-zero but stdout has content — attempting
   parse" and gives no sign of truncation.

Verified: a promisified `exec` writing 1.2 MB rejects with
`ERR_CHILD_PROCESS_STDIO_MAXBUFFER` and a 1,048,576-byte cap.

## Root Cause

- `src/utils/ModelRegistry.ts:36`: `const execAsync = promisify(exec);`. At
  `:46-51`, `execDiscoveryCommand` calls `execAsync(command, { timeout, cwd: DISCOVERY_CWD })`
  with no `maxBuffer`.
- `:214-228`: the catch takes `execError.stdout` for any failure, including
  `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` and a timeout kill (`killed: true`), not
  only for a genuine non-zero exit, and parses it at `:230`.

## Suggested Fix

- Pass an explicit, generous `maxBuffer` (for example 32 MB) in
  `execDiscoveryCommand`, or stream the output and parse it incrementally.
- In the catch, recover partial stdout only for a real non-zero exit
  (`typeof error.code === "number"` and not `killed`). For a maxBuffer overflow
  or a timeout, treat the result as failed, or at least drop the trailing
  incomplete block and log that the list is truncated.
