# Qwen headless API errors are reported as a successful step

- **Found:** 2026-10-21 by Claude (harness version-support review), reproduced with Qwen Code 0.25.3
- **Area:** `src/core/harness/qwen/`, `src/core/harness/shared/CliResponseCollector.ts`
- **Severity:** high

## Symptom

A headless Qwen step whose request the API rejects (an unknown model, a bad API key) finishes as
`✓ Workflow completed successfully` with empty output. The user never sees the error, and an
end condition or a later step runs as if the step had worked.

## Steps to Reproduce

1. Workflow: `{"harness":"qwen-cli","model":"none","additionalArgs":"--model no-such-model","steps":[{"prompt":"Reply with OK."}]}`
2. `node out/cli.js run <file> --headless`
3. The run reports success after a few seconds with no output.

Running the same request directly shows why:

- `qwen "Reply with OK." --model no-such-model --output-format stream-json` exits **1**.
- With `--input-format stream-json` and stdin closed (how ctrlyoke runs it,
  `QwenCliProvider.buildHeadlessArgs()`), Qwen exits **0**. Its stdout still ends with
  `{"type":"result","subtype":"error_during_execution","is_error":true,"error":{"message":"[API Error: 401 …]"}}`
  and an assistant message whose only text is that `[API Error: …]` string.

## Root Cause

`CliResponseCollector.getHeadlessFailure()` treats a run as failed only on a non-zero exit, a
termination signal, or stderr that looks like an invocation error. Qwen's stream-json input mode
reports API failures only in-band, with exit code 0, and nothing maps `result.is_error` to a
failure.

## Suggested Fix

Have the Qwen parser (or a provider hook alongside `ICliProvider.extractErrorFromStdout`) set
`metadata.error` from a `result` event with `is_error: true`, and let the collector treat a
parsed error as a `HARNESS_ERROR` failure even when the exit code is 0. Add a parser fixture from
the captured stdout above. Check whether Claude's stream-json `result.is_error` has the same gap.
