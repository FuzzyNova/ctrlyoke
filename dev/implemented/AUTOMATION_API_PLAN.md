# Automation API & Power User Scripting Plan

> **Status: IMPLEMENTED — per-step `--json` results.** Parameterized headless
> runs and the JSON v1 result contract are implemented. SDK and MCP
> workflow-launching proposals remain deferred indefinitely; they are not part
> of this implementation.
>
> **Implementation order:**
> [`FEEDBACK_AUTOMATION_COMPATIBILITY_STAGING.md`](../active/FEEDBACK_AUTOMATION_COMPATIBILITY_STAGING.md)
> — Stage B, whole plan, five steps. Its `schemaVersion` envelope is the
> convention `ctrlyoke validate --json` follows in Stage D.

## Goal

Make `ctrlyoke run --headless --json` useful as the final operation in a shell,
Python, JavaScript, or CI script. The command must emit exactly one JSON result
to stdout after the run, with enough per-queue-step detail to decide what
happened without parsing terminal text or ctrlyoke's private storage files.

```bash
ctrlyoke run security-scan.ctrlyoke.yaml --headless --json \
  --var repoPath=/repos/service-a \
  --var reportDir=./reports/service-a
```

This remains a CLI feature. The CLI continues to own execution lifecycle,
workspace resolution, workflow locks, cancellation, and exit-code semantics.

## Current implementation audit

| Capability                                   | Status                  | Current source of truth                                                                                                       |
| -------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Headless execution and CI exit codes         | **Implemented**         | `src/cli.ts` runs the shared `WorkflowInstance` and maps terminal workflow state to exit codes.                               |
| Workflow-level `vars:` defaults              | **Implemented**         | `schemas/workflow-schema.json` and `PromptFile.vars`.                                                                         |
| Repeatable `--var key=value` overrides       | **Implemented**         | `CliRunCommandDefinitions.ts` parses assignments and `cli.ts` merges them over workflow defaults after loading.               |
| Variable substitution and script environment | **Implemented**         | `VarSubstitutor` resolves supported fields; `EndConditionEvaluator` injects `CTRLYOKE_VAR_<UPPERCASE_KEY>`.                   |
| Compact JSON result                          | **Implemented**         | `cli.ts` currently emits version, file, selected harness/model, workflow status, and aggregate completed/failed/total counts. |
| Durable attempt and output history           | **Implemented**         | `OutputHistoryManager` records a per-run JSONL timeline; `RunOutputResolver` reads it in a streaming, bounded-memory pass.    |
| Per-step JSON result                         | **Missing — this plan** | The current `--json` branch never projects queue results, runtime metadata, attempts, file events, or end-condition detail.   |

The runtime already supplies the needed data without re-running or scraping a
harness:

- queue state supplies step order, terminal status, errors, retry count, and
  workflow/step runtime timestamps;
- each executed prompt's `_runtime` records selected harness, model, session ID,
  start time, completion time, and terminal status;
- the run timeline records every attempt, structured CLI events, response output,
  script execution output, and terminal attempt state; and
- `EvaluationResult` and `ScriptExecutionReporter` contain pre-condition,
  end-condition, and script-step verdicts, stdout, stderr, exit code, duration,
  and evaluator errors.

### Existing variable caveat

Substitution runs when the loaded workflow has at least one `vars:` value or a
CLI `--var` override. A workflow containing placeholders with neither bypasses
substitution and sends the literal placeholder to the harness. This is a known
behavioral limitation, not part of the per-step JSON work.

## JSON v1 contract

`--json` replaces the current compact success payload with the versioned result
below. This is pre-release, so the current unversioned compact payload does not
need compatibility preservation. `--json` must continue to suppress all
headers, streaming chunks, status decorations, and diagnostics on stdout.

```json
{
  "schemaVersion": 1,
  "success": true,
  "workflowFile": "security-scan.ctrlyoke.yaml",
  "workflowKey": "security-scan-2026-07-30T10-00-00-000",
  "runRef": "run-2026-07-30T10-00-00-000Z",
  "harness": "codex-cli",
  "model": "gpt-5",
  "status": "completed",
  "startedAt": "2026-07-30T10:00:00.000Z",
  "completedAt": "2026-07-30T10:04:32.000Z",
  "durationMs": 272000,
  "varNames": ["repoPath"],
  "summary": { "total": 1, "completed": 1, "failed": 0, "skipped": 0 },
  "steps": [
    {
      "index": 0,
      "name": "scan",
      "type": "prompt",
      "enabled": true,
      "harness": "codex-cli",
      "model": "gpt-5",
      "executionMode": "headless",
      "status": "completed",
      "success": true,
      "attempts": 1,
      "lastAttempt": {
        "number": 1,
        "startReason": "initial",
        "terminalState": "completed",
        "reason": null
      },
      "startedAt": "2026-07-30T10:00:02.000Z",
      "completedAt": "2026-07-30T10:04:30.000Z",
      "durationMs": 268000,
      "sessionId": "abc-123",
      "preCondition": {
        "passed": true,
        "action": "continue",
        "script": "test -d src",
        "actual": "0",
        "actualSource": "exitCode",
        "stdout": "",
        "stderr": "",
        "exitCode": 0,
        "durationMs": 4,
        "error": null
      },
      "filesChanged": [
        {
          "path": "src/auth.ts",
          "scope": "workspace",
          "operations": ["modified"]
        },
        { "path": "src/db.ts", "scope": "workspace", "operations": ["created"] }
      ],
      "endCondition": {
        "passed": true,
        "script": "npm test",
        "actual": "0",
        "actualSource": "exitCode",
        "stdout": "all tests passed",
        "stderr": "",
        "exitCode": 0,
        "durationMs": 4210,
        "error": null
      },
      "failureKind": null,
      "error": null
    }
  ],
  "finalStep": null,
  "error": null
}
```

### Contract rules

- `success` is `true` only for workflow status `completed`; it is `false` for
  failed, stopped, interrupted, or unexpected CLI-error results.
- `status` retains the canonical execution-state value. `steps` contains every
  queue step in queue order, including disabled, pending, skipped, and failed
  steps. `enabled` distinguishes a disabled step from an enabled step that has
  not yet run. `harness`, `model`, and `executionMode` are the effective values
  used for that step, not merely workflow defaults.
- `success` on a step is `true` only for `completed`, `false` for terminal
  failure, and `null` for pending, disabled, skipped, or stopped work.
- `attempts` counts all persisted AI/script attempts for that queue step,
  including retries and resumed attempts. It is `0` when the step never began.
- Timestamps are ISO-8601 UTC strings; unavailable values are `null`.
  `durationMs` is `completedAt - startedAt` when both timestamps exist,
  otherwise `null`.
- `lastAttempt` describes the latest started attempt using a public 1-based
  number, start reason, terminal state, and terminal reason. `attempts` is the
  total count across initial, retry, and resumed attempts.
- `filesChanged` is a deduplicated list of observed `FILE_WRITE`, `FILE_EDIT`,
  and `FILE_DELETE` event paths across all attempts for a step. Each entry
  records the distinct observed operations and whether the path is inside the
  workspace or an approved external root. Workspace paths are normalized to be
  workspace-relative; external paths are explicitly marked rather than silently
  leaking an unlabelled machine-specific absolute path. This is deliberately
  **not** a Git diff or a claim of net final changes; harnesses that do not emit
  structured file events yield an empty list.
- `preCondition` is `null` when no pre-condition ran. Otherwise it contains the
  last evaluation before the step's latest attempt, including the resolved
  `continue`, `skipPrompt`, or `stopWorkflow` action. This makes a skipped or
  stopped prompt explainable without reading logs.
- `endCondition` is `null` if no end condition ran. Otherwise it contains the
  last evaluation, including an evaluator error or a failed verdict after
  retries. Both condition objects contain the script, verdict, stdout, stderr,
  exit code, duration, and error. Output is emitted exactly as produced; no
  CLI-only truncation is applied.
- Script steps use the same common fields and set `type: "script"`; their
  command, stdout, stderr, and exit code are returned in a `script` object.
  They have `sessionId: null`, `preCondition: null`, and `endCondition: null`.
- `failureKind` is the runtime failure classification (`timeout`, `processExit`,
  `harnessError`, and so on) or `null`. `error` on a step is the terminal
  failure reason or `null`. Top-level `error` is
  `{ "step": <index|"finalStep">, "loop": <number|null>, "message": <string>, "attempt": <number|null> }`
  for a workflow failure, otherwise `null`.
- `varNames` lists effective workflow-variable keys but never their values.
  Values can contain credentials and stdout is commonly retained in CI logs.
- `finalStep` is `null` when absent. Otherwise it is a separate summary rather
  than a queue row: it reports type, effective execution metadata, terminal
  status, success, total loops, total attempts, aggregate timing/file changes,
  error/failure kind, and `lastLoop`. `lastLoop` has the same attempt,
  condition, script-output, and session fields as the corresponding queue step.
  This reports final-step failures without making an unbounded loop inflate the
  ordinary queue-step array.
- A setup/parse/unexpected error that prevents a queue state from being built
  emits the same versioned envelope with `success: false`, `status: "error"`,
  `steps: []`, and `error: { "step": null, "message": ..., "attempt": null }`.
  The existing exit code `2` remains unchanged.

`responseText`, raw CLI event streams, diffs, token usage, agent/skill/hook/MCP
configuration, full tool-permission configuration, expanded `priorContext`, and
complete final-step loop history are intentionally excluded from JSON v1. They
can be large, configuration-oriented, or privacy-sensitive. `ctrlyoke_read_output`
remains the supported MCP surface for selected response text.

## Design and implementation plan

> **Build order.** The sections below are numbered by concern, not by
> implementation order. Section 1's builder consumes the projection type from
> section 2 and the condition-summary types from section 3, so the producers land
> first: **3 → 2 → 1 → 4**, with tests written alongside each (see section 5).
> `FEEDBACK_AUTOMATION_COMPATIBILITY_STAGING.md`'s queue table is the
> authoritative step sequence.

### 1. Define a CLI-only result contract and builder

Add `src/cli/CliJsonResultBuilder.ts` with exported TypeScript interfaces and a
single `buildCliJsonResult(...)` entry point. Keep these types CLI-local: this
is an external command-output contract, not a dashboard/webview contract.

Inputs:

- final `QueueState` and loaded `PromptFile` (for effective vars);
- resolved CLI harness/model and original workflow-file reference;
- workspace root; and
- the promoted run's `workflowKey` and `runRef`, when available.

The builder owns ISO timestamp conversion, nullable-field policy, effective
execution metadata, scoped file-path shaping, common per-step/final-step
shaping, summary counts, and the top-level error selection. It must never write
workflow files or mutate queue state.

### 2. Add a one-pass queue-attempt projection

Extend `src/core/orchestration/RunOutputResolver.ts` with a focused read-only
projection for selected queue and final-step targets. It must consume its
existing `stream()` API in one pass and return, per target:

- total attempt count, latest public attempt number/start reason/terminal state;
- observed, scope-classified file-change paths aggregated across all attempts;
- latest pre-condition, end-condition, and script-step output where relevant;
  and
- the final-step loop count and latest loop summary without materializing every
  loop in the public result.

Do not call `TimelineRecorder.readEvents()` or resolve each step separately:
that would materialize or rescan a potentially large JSONL history. Reuse
`normalizeCliEvents()` and the existing file-event types for path extraction.

`resolveLatestAttempts()` in the same file is the pattern to follow — one
`stream()` walk, keyed by `getTargetKey()`, retaining only the reduction. Two
differences the new projection must handle that it does not:

- It ignores `streamingEvents`, but file events arrive **both** as
  `streamingEvents` during an attempt and again inside the completed attempt's
  `output.events`. Aggregate from both and deduplicate by path, or a single edit
  is counted twice.
- It keeps only the latest attempt, whereas `attempts` and `filesChanged` are
  aggregates across every attempt for a target.

Skip file events carrying `success === false`; a failed write did not change the
file. `FileWriteData.status` is a lifecycle stage, so the same path legitimately
appears more than once per attempt — dedupe on `(path, operation)`.

If the run manifest/history cannot be read after a workflow terminal state,
the builder must log a diagnostic and return the state-derived result with
`attempts: 0` and empty file lists. JSON reporting must never convert an
otherwise valid workflow completion into a CLI error.

### 3. Preserve effective runtime and final condition evaluations

Add typed pre-condition and end-condition summaries to `PromptResult` in
`src/types/CtrlYokeTypes.ts`; do not overload the existing boolean
`endConditionResult` or `scriptOutput` fields. Add narrow `PromptQueue` methods
to update those summaries so result mutation remains queue-owned. Add the
matching final-loop condition summary to `FinalStepRuntimeState`.

Have `WorkflowExecutor` record every pre-condition report from
`ScriptExecutionReporter`, including its resolved action, evaluator error, and
the final report before a retry or terminal decision. Have
`EndConditionHandler`/`WorkflowExecutor` similarly record every end-condition
evaluation, including pass, failed verdict, retry result, evaluator error, and
the final post-retry verdict. The builder exposes only the final record of each
kind for a step. This is required because the current code records successful
end-condition stdout only and does not retain pre-condition output in the queue
result. Persist the actual effective `executionMode` with the existing prompt
runtime harness/model metadata so JSON reports what ran, not a later-resolved
default.

Confirmed against the current code: `EndConditionHandler.recordPassingEvaluation()`
writes `endConditionResult`/`scriptOutput` on the **passing** path only, so a
failed or errored end condition leaves no queue-visible record; the pre-condition
report at `WorkflowExecutor.ts:532` is consumed for the action decision and then
discarded. `CliPromptRuntimeCoordinator` persists `harness`/`model`/`agent`/
`skills` into `_runtime` but never `executionMode`, even though
`PromptRuntimeMetadata extends ExecutionProperties` already declares the field —
this is a missing write, not a missing type.

### 4. Wire the builder into the CLI success and error paths

Replace the `options.json` branch in `src/cli.ts` with the builder and one
`process.stdout.write(JSON.stringify(result) + "\n")` call. Continue to
calculate and use the existing exit code; JSON does not change exit semantics.

Use the same result factory in the surrounding `catch` path so consumers never
need two unrelated JSON shapes. Keep diagnostics in `Log.initializeCli()` and
never write a formatting/log line to stdout in JSON mode.

### 5. Tests

Add focused tests rather than requiring installed harnesses. **Each group ships
in the same step as the behavior it covers**, per the repo rule that tests
accompany the behavior change; there is no trailing test-only step. The final
step is instead a live end-to-end verification, because every group below is a
mock and none of them proves the timeline a real harness actually writes.

1. `CliJsonResultBuilder` unit tests for a completed prompt, failed prompt,
   pre-condition-skipped/pending step, script step, per-step overrides, null
   timestamps, top-level error, external file paths, final-step summary, and
   JSON-safe error envelope.
2. `RunOutputResolver` unit tests with timeline fixtures proving that retries
   count correctly, the latest terminal attempt is selected, file paths are
   deduplicated and scope-classified across `FILE_WRITE`/`FILE_EDIT`/`FILE_DELETE`,
   final-step loops reduce to the required summary, and history is streamed once
   rather than loaded wholesale.
3. Core tests for recording pre-condition output/action and the final
   end-condition evaluation on pass, failure, retry exhaustion, and evaluator
   error, plus script-step stdout/stderr/exit code projection.
4. CLI integration coverage that invokes the JSON writer with a fixture state
   and asserts stdout is exactly one parseable JSON document with no decorative
   output.
5. One live verification pass driving the built CLI against a real multi-step
   workflow — a prompt step with pre/end conditions, a script step, and a
   `finalStep` — asserting the emitted document against the v1 contract. Use the
   `opencode-cli` harness with model `opencode/big-pickle`; it is free, so this
   costs nothing and is not part of the paid `npm run test:harness` suite.

Run `npm run compile:extension`, `npm run typecheck`, the focused unit/integration
tests, and `npm run format:check` before moving this plan to `dev/implemented/`.

## Explicitly deferred or rejected scope

| Proposal                                 | Decision                            | Rationale                                                                                                             |
| ---------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Python or JavaScript SDK                 | **Deferred indefinitely**           | The CLI is sufficient for scripted execution; there is no standalone workflow-control server API to wrap.             |
| `ctrlyoke_run_workflow` MCP tool         | **Deferred indefinitely**           | It would create a second lifecycle, locking, cancellation, and workspace control plane.                               |
| `ctrlyoke_get_step_output` MCP tool      | **Implemented under a better name** | `ctrlyoke_read_output` already reads selected queue-step output from promoted runs.                                   |
| `ctrlyoke_set_var` on a running workflow | **Rejected**                        | Variables are launch-time configuration; mutation mid-run makes resolved prompts and persisted definitions ambiguous. |
| YAML `if`/`when`/`loop` language         | **Rejected**                        | Callers should use their shell, Python, JavaScript, or CI system for control flow.                                    |

## Completion criteria

- `ctrlyoke run --headless --json` produces the JSON v1 contract for successful,
  failed, stopped, and unexpected-error runs.
- Every queue step has a stable row; retries, known file paths, session IDs,
  effective execution metadata, timing, failure classification, errors,
  pre-condition results/actions, script details, and final end-condition
  evaluation are accurately represented when available. Final-step terminal
  state and latest-loop detail are represented separately.
- JSON mode remains clean stdout and retains existing exit codes.
- The implementation uses current queue/runtime/timeline sources only and does
  not add an MCP execution path, SDK, workflow DSL, or new persistence format.
