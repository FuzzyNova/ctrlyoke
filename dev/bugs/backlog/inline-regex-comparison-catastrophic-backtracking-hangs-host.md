# Inline regex comparison can hang the host on catastrophic backtracking despite the worker guard

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/utils/ScriptComparison.ts`
- **Severity:** medium

## Symptom

A script condition can use `operator: matches` with a pattern that backtracks exponentially, meaning nested quantifiers such as `^(a+)+$` or `^(\w+\s?)+$`. If the script output is 100,000 chars or shorter and does not match, the regex runs synchronously on the host thread with no timeout. The VS Code extension host, CLI or MCP server then freezes indefinitely. The dashboard, every running workflow and all other extension features stop responding.

A worker-thread timeout guard exists for this exact case, but it only applies to output longer than 100,000 chars.

## Steps to Reproduce

1. Create a workflow with a step whose endCondition is `{ script: "echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!", compareSource: stdout, operator: matches, expected: "^(a+)+$" }`.
2. Run the workflow in the VS Code extension, or with `ctrlyoke run`.
3. When the step finishes, `EndConditionEvaluator.evaluateSuccess` calls `compareScriptOutputAsync` with the 37-char stdout.
4. The stdout is 100,000 chars or shorter, so `compareScriptOutputAsync` calls `compareScriptOutputInline` and then `compareRegex` on the main thread.
5. Backtracking on `(a+)+` takes on the order of 2^36 steps. The event loop is blocked, the extension host stops responding, and the 2s `REGEX_WORKER_TIMEOUT_MS` guard never applies.

## Root Cause

`src/utils/ScriptComparisonAsync.ts:78-84` decides whether to use the worker from the input length alone. When `actual.length <= MAX_REGEX_INPUT_LENGTH`, the input is evaluated inline. Inline evaluation runs `src/utils/ScriptComparison.ts:168-171` (`new RegExp(pattern).test(actual.slice(0, MAX_REGEX_INPUT_LENGTH))`) on the calling thread with no deadline.

The doc comment at `ScriptComparison.ts:17-20` assumes that backtracking cost depends on input length. An exponential pattern needs only a few dozen characters.

The only production caller is `src/core/EndConditionEvaluator.ts:1075`, which runs on the extension-host, CLI or MCP thread. The tests reinforce the gap: `src/test/unit/scriptComparison.test.ts:248` pins the inline path for short input, and the timeout test at line 231 only covers input longer than 100k chars.

## Suggested Fix

Stop choosing the guard by input length. Any one of these works:

- **Always use the worker.** Evaluate every `matches` comparison in the deadline-guarded worker. The cost is acceptable because this runs once per end-condition evaluation. A persistent or pooled worker would avoid starting a thread on every call.
- **Use a `vm` timeout.** Evaluate inline in a `vm` context with `runInContext(..., { timeout })`, which can interrupt a synchronous regex.
- **Use V8's linear engine.** Start Node with `--enable-experimental-regexp_engine-on-excessive-backtracks`, or compile the pattern with the `l` (linear) flag where it is supported, so V8 falls back to its linear-time engine.

After the fix, update the `ScriptComparison.ts` doc comment. Also add a test that runs `^(a+)+$` against a short (about 40-char) non-matching string and expects the timeout reason.
