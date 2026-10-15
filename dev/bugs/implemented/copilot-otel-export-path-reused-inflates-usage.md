# Copilot OTel export path is reused per step index, so leftover spans can be counted into a new invocation's usage

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/core/harness/copilot/CopilotCliProvider.ts`
- **Resolution:** fixed in this commit

## Symptom

Copilot step token usage is inflated: input, output, cache read and cache write tokens, the total, and the cost estimates built from them. The totals include chat spans from earlier invocations that wrote the same OTel export file. That can be an earlier retry attempt of the step, an earlier final-step pass, an earlier run at the same step index, or a concurrent Copilot workflow. When two workflows run at the same step index at the same time, the live context-window reading can also show the other workflow's numbers.

Stale `ctrlyoke-otel-workflow-p<N>.jsonl` files also pile up in `.ctrlyoke/temp/`. This workspace already has p2, p3, p5 and p6, and p2 holds output from two processes ten days apart (records from 2026-08-28 and 2026-09-07).

## Steps to Reproduce

1. Create a Copilot (`copilot-cli`) workflow with at least two steps. Give step 0 an end condition that fails once so the step retries, or use a `finalStep` with several passes.
2. Run it. Attempt 1 of step 0 exports chat spans to `<workspace>/.ctrlyoke/temp/ctrlyoke-otel-workflow-p0.jsonl`.
3. The retry calls `planCliArgs` again with the same `promptIndex` and gets the identical path. `setOtelFilePath` resets the read offset to 0, and Copilot appends attempt 2's spans to the existing file.
4. Look at attempt 2's reported usage in the dashboard, or in `events.jsonl` / `_runtime` usage. Its input and output tokens equal attempt 1 plus attempt 2.
5. After the run, `.ctrlyoke/temp` still holds `ctrlyoke-otel-workflow-p0.jsonl`; only the last step's file was deleted. Run any Copilot workflow again and its step 0 also counts the previous run's spans.

## Root Cause

- `src/core/harness/copilot/CopilotCliProvider.ts:991-1003`: `buildOtelFileName` takes the stem from the working file's basename. That basename is always `workflow.ctrlyoke.json` (`WORKING_FILE_NAME`, `src/utils/WorkflowPaths.ts:23`, used by `draftFilePath` at :300-305 and `runFilePath` at :318-327). The name therefore collapses to `ctrlyoke-otel-workflow-p<promptIndex>.jsonl` and is not unique per invocation, despite the docblock at :986 ("unique OTel export filename") and the comment at :278 ("fresh per-invocation OTel export path").
- `CopilotCliProvider.ts:281-291` builds the path, and :438-439 stores it and hands it to the parser. Neither deletes nor truncates an existing file at that path, and Copilot's exporter appends to it.
- `src/core/harness/copilot/CopilotLogParser.ts:287-298`: `setOtelFilePath` resets `otelReadPosition` to 0 and zeroes the counters. `readNewOtelLines` (:301-323) and `pollOtelContextWindow` (:369 onward) then read the whole file from the start and add up every old chat span. `getFinalOtelUsage` (:467), called after exit by `augmentParsedOutput`, reports those totals.
- `CopilotCliProvider.ts:831-843`: `getAdditionalCleanupFilePaths` returns only the last `this.otelFilePath`, so earlier steps' files are never deleted. (Hook files and status-line snapshots are tracked in lists; the OTel path is not.)
- `CopilotLogParser.ts:308-311`: when truncation is detected, the parser resets only the read offset and line state, not the cumulative counters, so a truncated-and-rewritten file is double-counted.

## Suggested Fix

- Give each invocation a truly unique OTel path, e.g. `ctrlyoke-otel-<workflowKey or runRef>-p<promptIndex>-<randomUUID()>.jsonl`. `planCliArgs` already generates a UUID for `statusLineToken` (:277). Alternatively, unlink any existing file at that path in the prompt-runtime mutation before spawning.
- Track every OTel path created during the workflow in a list, the same way `hookFilePaths` is tracked, and return all of them from `getAdditionalCleanupFilePaths`. Ideally delete each one as soon as its invocation's usage has been read.
- In `readNewOtelLines`, reset the cumulative counters too when truncation is detected, or treat truncation as a fresh file.
- Add a unit test that sets the same path twice on a file that already holds spans and asserts the second invocation's usage excludes the earlier spans.

## Decision

Each OTel export filename adds the invocation UUID already created by planCliArgs to the Step 1 run-specific stem. This keeps concurrent invocations isolated while preserving the workflow/run identity in temp filenames.

## Follow-up (review)

The provider clears its tracked OTel paths after workflow artifact cleanup, preventing the list from growing when the provider is reused across workflows.
