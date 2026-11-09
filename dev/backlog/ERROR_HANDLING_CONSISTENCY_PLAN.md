# Error Handling Consistency Plan (harnesses, scripts, CLI)

**Status:** Phase 2 implemented on 2026-11-09 (H1, H2, H4, H5, H6, R1 types, R2 hook
column, R3). Phase 0 captures completed on 2026-11-09 for every harness except OpenCode
2.x, which is not yet released (§6). Research and recommendation done; open
decisions settled with the user on 2026-11-08 (§7).

**Origin:** the "CLI error reporting in `src/cli.ts`" entry under **Deferred** in
`dev/backlog/CODE_SMELL_LEDGER.md`. While researching it, the same problem turned up in two
more places: harness errors and script errors. All three share one root cause. A failure is
detected with useful detail, and then that detail is dropped, reworded or reclassified
before it reaches the user. Each layer does this its own way.

Prior art: `dev/implemented/ERROR_BEHAVIOR_PLAN.md` added `FailureKind`, `errorBehavior` and
the interactive `{sessionId}-error.json` hook path. Its detection rules still hold and this
plan keeps them. Do not add generic keyword matching such as `error`, `429` or `timeout`
over harness logs. Use only explicit hooks, verified session-level events, parsed headless
results, process exit and timeout.

---

## 1. Do we attach an error hook by default?

**Yes, but only for three of the six harnesses, and only in interactive mode.** When no
`ctrlyokeEvents` list is passed, each monitor's `buildHookConfig` registers ctrlyoke's own
default hook set:

| Harness           | Default ctrlyoke hooks               | Native error event                                                    | Where                                                                                 |
| ----------------- | ------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `claude-cli`      | sessionStart, stop, **error**        | `StopFailure`                                                         | `ClaudeNotificationMonitor.ts:38,99`, `ctrlyoke-claude-hook.js:54-57,139-150`         |
| `copilot-cli`     | sessionStart, stop, **error**        | `errorOccurred`                                                       | `CopilotNotificationMonitor.ts:48,155`, `ctrlyoke-copilot-hook.js:152-186`            |
| `opencode-cli`    | plugin (always on)                   | `session.error` (v2: `session.execution.failed` → v1 `session.error`) | `ctrlyoke-opencode-plugin.ts:831-848`, `ctrlyoke-opencode-plugin-v2/index.ts:158-166` |
| `codex-cli`       | sessionStart, stop                   | none (`unsupportedHook`)                                              | `CodexNotificationMonitor.ts:73,120`                                                  |
| `qwen-cli`        | sessionStart, userPromptSubmit, stop | none (`unsupportedHook`)                                              | `QwenNotificationMonitor.ts:112,176`                                                  |
| `antigravity-cli` | stop (+ PreInvocation as start)      | none (`unsupportedHook`)                                              | `AntigravityNotificationMonitor.ts:61,112`                                            |

All three hooks write `{sessionId}-error.json`. `NotificationMonitorBase.monitorForCompletion`
checks that file before the stop file (`INotificationMonitor.ts:316-347`), and
`CliLogMonitor` resolves the step as `FAILURE_KINDS.HARNESS_ERROR` (`CliLogMonitor.ts:819-844`).

Headless runs never use these hooks. The ERROR_BEHAVIOR_PLAN made that choice on purpose:
headless completion is decided by process exit plus the response parser.

So your memory is right for Claude, Copilot and OpenCode. For Codex, Qwen and Antigravity
there is no error hook, and no log-based substitute either (see H3).

---

## 2. How errors reach the user today

```
detection                      classification                routing                      surfaces
─────────                      ──────────────                ───────                      ────────
interactive: -error.json   ┐                                                             dashboard: STEP_STATUS_CHANGED
             PTY exit      │   FailureKind + message         WorkflowExecutor             message, output "Error:" row,
             timeout       ├─► (CliFailureTracker,       ─►  handlePromptSendFailure  ─►  status-message row
             no-turn wdog  │    CliTransportError,           → handleHarnessFailure       step row (continue only)
headless:   parsed error   │    _runtime.failureKind/        → errorBehavior              toasts (see R7)
            exit code      │    failureMessage)              stop/retry/continue          CLI: stderr text, --json
            stderr summary ┘                                                             error, exit code (CliExitCode)
scripts:    ScriptProcessRunner → EvaluationResult{passed|errored|timeout} → onFail / errorBehavior → ScriptVerdict
```

The shape of the pipeline is fine. The defects are in what each stage drops.

---

## 3. Findings

Marked ✅ where confirmed by reading the code for this plan, and 🔎 where the code path is
confirmed but the trigger depends on harness payloads or behavior that still has to be
captured live (see §6).

### Harness errors

- **H1 ✅ The harness's error text is dropped on the interactive hook path.**
  `describeHarnessError` (`CliLogMonitor.ts:68-73`) reads only `rawHookData.message`. None of
  the three real hooks put the text there:
  - OpenCode writes `event.properties`, i.e. `{ sessionID, error: { … message … } }`
    (`OpenCodePlugin.test.ts:677` asserts `rawHookData.error.message`).
  - Claude `StopFailure` and Copilot `errorOccurred` pass the raw hook input through, and
    both carry the error under `error`. The script tests use `error: "failed"`
    (`NotificationHookScripts.test.ts:618-631`).
  - The only producer of `{ message }` is ctrlyoke's own synthetic resume-prompt failure
    (`ctrlyoke-opencode-plugin.ts:431-433`), and that is also the only case the unit test
    covers (`CliLogMonitor.test.ts:858`).

  So users see the fixed string "Harness reported an error" (`INotificationMonitor.ts:343`)
  instead of something like "rate limit exceeded".

- **H2 ✅ Headless Copilot and Antigravity have no error extraction.**
  - Copilot `session.error` becomes a TEXT event only (`CopilotLogParser.ts:797-806,1709`).
    The 1.0.105 live capture emitted `session.error` and `assistant.idle`, then exited 1;
    this probe did not reproduce the conditional exit-0 success case.
  - Antigravity's SYSTEM `ERROR_MESSAGE` becomes TEXT through `transcript.error`
    (`AntigravityLogParser.ts:773-787,432-439`). The agy 1.5.3 capture (§6) shows that
    entry is **not written** for an API error: the text is only in the stream-json
    `result.error`, alongside exit code 3. Phase 2's transcript-based `metadata.error`
    therefore never fires
    (`dev/bugs/backlog/antigravity-headless-error-not-parsed-from-stream-json.md`).
  - Neither sets `metadata.error` or implements `extractErrorFromStdout`. Only Codex and
    Qwen implement it.
  - If the process exits 0 after such an error, the step **succeeds** with the error text as
    its response. If it exits non-zero, the message falls back to a stderr summary or
    "Process exited with code N".
- **H3 ✅ Interactive Codex, Qwen and Antigravity can hang forever on an API error.**
  - They have no native error hook.
  - `execution.maxPromptTimeoutSec` defaults to `-1`, which means unlimited
    (`CtrlYokeSettings.ts:628`).
  - `InteractiveTurnStartWatchdog` is cancelled as soon as a turn starts, so it cannot see a
    failure in the middle of a turn.

  The 2026-11-09 captures (§6) settle the behavior. Each harness was checked against a
  positive-control turn, and in all three the process stays in the TUI after the error:
  - **Codex 0.166.0** hangs. Stop does not fire after a 401. The rollout records
    `task_complete` with a typed `error`.
  - **Qwen 0.26.7** hangs. Stop does not fire after a 401. The chat JSONL records
    `qwen-code.api_error` and a `request_lifecycle` ending `outcome: "error"`. ~558ef85
    consumes the `api_error`, but a turn that Qwen's retry recovers then fails
    (`dev/bugs/backlog/qwen-retried-api-error-fails-recovered-turn.md`).
  - **Antigravity 1.5.3** succeeds silently. Stop **does** fire, with
    `terminationReason: "ERROR"` and the text in `error`, and `ctrlyoke-antigravity-hook.js`
    writes a normal stop file.

  The ERROR_BEHAVIOR_PLAN listed this as "the actively-broken case" and fixed it only for
  the three harnesses with hooks.

- **H4 ✅ The no-session-ID fallback would be missed; the current Copilot payload includes an ID.**
  - Without a session ID, `ctrlyoke-copilot-hook.js` falls back to writing
    `errorOccurred-<ts>.json` (line 167).
  - The wildcard scan matches `/-error\.json$/` (`INotificationMonitor.ts:376-379`), and that
    name does not match it.
  - Copilot CLI 1.0.105 supplied a string `sessionId` in the captured `errorOccurred` input
    (§6); a missing-ID payload was not observed.

- **H5 ✅ Classification depends on the exit code instead of the evidence.**
  `CliResponseCollector.getHeadlessFailure` (`CliResponseCollector.ts:259-324`):
  - A parsed provider error with a non-zero exit is classed as `PROCESS_EXIT`, not
    `HARNESS_ERROR`, so it is labelled "process exited unexpectedly" and gets
    `rawTextOutput`.
  - **Any** termination signal becomes `USER_CANCELLED`, even one ctrlyoke never sent (for
    example an OOM kill). That skips `errorBehavior`. `ScriptProcessRunner` already
    distinguishes these cases with `terminatedByManager` (`ScriptProcessRunner.ts:142-147`);
    the harness path does not.
- **H6 ✅ Some failure kinds bypass `errorBehavior`.** `unknown` and `sessionRejected` always
  stop (`WorkflowExecutor.ts:5631-5698`). Every other non-cancel kind goes through
  `handleHarnessFailure`.
- **H7 ✅ The failure is recorded inconsistently.**
  - ✅ `ATTEMPT_TERMINATED` records optional `failureKind` and `failureSource`, so history
    can distinguish a timeout from a hook or process failure. Older events remain valid
    without either field.
  - ✅ Failed step rows show `_runtime.failureMessage` for stopped failures and retain the
    "Workflow continued after failure" label for failures the workflow continued past.
  - Stop toasts are uneven (detail in R7). Every stop into `ERROR` gets a "Workflow Failed"
    completion notification, but its body carries no failing step and no reason. The
    `unknown`/`sessionRejected` stops and the timeout guardrail also raise a second, ad hoc
    `notifyUserFeedback` toast.
  - **Phase 3a complete (2026-11-09):** added optional `failureKind` and
    `failureSource` to `ATTEMPT_TERMINATED`, persisted `failureSource` with step runtime
    failure metadata, and displayed stopped-step failure messages. No timeline version
    bump is needed: both fields are optional additions to an existing event, old events
    remain valid without them, and the reader treats absent optional payload fields as
    absent rather than requiring migration. The persisted store guard only blocks writes
    from older hosts when the recorded version is newer; it does not require a bump for
    additive fields that older readers can ignore. Stop notifications remain Phase 3b.

### Script errors (`type: script`, pre/end conditions, hooks)

Every script spawned headlessly goes through `ScriptProcessRunner` → `CliProcessManager`. Its
`errored` flag ("could not run") is set only when spawning throws, the extension is
unsupported, there is a shell syntax error, or the run times out.

- **S1 ✅ Several "could not run" cases are scored as "returned false".**
  - Command not found under a shell (exit 127), bad interpreter (126), and an external signal
    kill (the code comes out as `code ?? 1`, `CliProcessManager.ts:257`) all come back as
    plain failures.
  - A broken endCondition therefore counts as "condition not met", so it sends retry
    prompts to the agent instead of following `errorBehavior`.
- **S2 ✅ A script step that errors with `onError: continue` is marked COMPLETED.**
  `succeeded = evalResult.errored ? true : …` (`WorkflowExecutor.ts:3137-3147`). A prompt
  step under the same policy is marked FAILED ("Workflow continued after failure").
- **S3 ✅ The verdict's action ignores the retry budget.** `getErrorConditionAction`
  (`WorkflowExecutor.ts:4010-4021`) maps `retry` to "→ retry" whether or not any retries are
  left. `handleEvaluationError` computes `canRetry` correctly (`:4044-4050`), so the verdict
  can say retry while the workflow actually stops.
- **S4 ✅ Timeouts throw away captured output.** Only chunks already streamed survive
  (`ScriptProcessRunner.ts:155-159`). Signal kills are reported as "exit code 1" with no
  record of the signal.
- **S5 ✅ Behavior differs by host.**
  - In the extension, interactive script steps run through `WorkflowInstance.spawnScriptPty`.
    A PTY spawn failure there resolves to exit 1, so it is treated as failed and follows
    `onFail`.
  - The CLI always runs the same step headless, where spawn ENOENT is errored and follows
    `errorBehavior`.
- **S6 ✅ Decision hooks fail open silently.** `runDecisionHook` (`ctrlyoke-hook-utils.js:193-215`):
  - It returns `result.status ?? 0`. A signal kill, an ENOBUFS from the 1 MB `maxBuffer`, or
    a spawn error in `result.error` (never checked) all count as exit 0.
  - Partial stdout has already been forwarded to the harness by then.
  - There is no timeout, stderr is dropped, and errors are written only to the
    diagnostics-gated debug log.

  The decision _format_ is covered by `HOOK_DECISION_FORMAT_PLAN.md`; this plan only owns
  the failure semantics.

- **S7 ✅ Severity and wording drift.**
  - A failed preCondition is a WARNING, while a failed script step or endCondition is an
    ERROR.
  - For errored runs the CLI prints both the verdict block and the separate "could not
    run" line.

### ctrlyoke CLI's own error reporting

The ledger's description was partly wrong: `handleCliError` (`CliExitCode.ts:53-61`) only
prints `Error: <message>` and exits 2. It has one call site, the top-level `parseAsync`
catch (`cli.ts:682`).

- **C1 ✅ 26 call sites print to stderr and exit directly.** They are spread across
  `runCommand`, `handleHistoryCommand`, `handleStepCommand`, `handleSecretCommand`, dry run,
  validate, commit, trust-external-roots and the flag parsers in
  `CliRunCommandDefinitions.ts`. Text prefixes vary between `Error:`, `✗` and none.
- **C2 ✅ There are four `--json` error shapes, and some commands have none.**

  | Command                                                   | JSON error shape                                                                 |
  | --------------------------------------------------------- | -------------------------------------------------------------------------------- |
  | run                                                       | `error: { step, pass, attempt, message }` (documented in `docs/cli/ci.md:72-88`) |
  | step                                                      | `error: string`                                                                  |
  | validate                                                  | `error: string` plus `errorCode`                                                 |
  | history, status, export, import, secret, license, dry run | none: plain stderr even with `--json`                                            |

- **C3 ✅ Redaction and closed-pipe handling are per-handler.**
  - Only the secret/license path redacts its error text.
  - Run, history and step JSON output is redacted, but their text-mode errors are not.
  - Only history handles EPIPE.
- **C4 ✅ Flag validation is inconsistent.**
  - `parseTimeoutSeconds` uses `Number()`, so it accepts `1e3`, `0x10` and `" 5 "`, then
    prints and exits on its own.
  - `parseScriptTimeoutSeconds` accepts the same values but throws `InvalidArgumentError`,
    so commander formats its message differently.
  - Selectors and history filters use strict `/^\d+$/` regexes.
  - `server --port ""` parses to 0 and is accepted.

Exit codes 0–6 are documented in `docs/cli/ctrlyoke.md:123-133` and `docs/cli/ci.md:55-68`.
They are a released contract and **must not change**.

---

## 4. Recommendation: the standard

### R1. One failure record, carried end to end

Detection produces a single structured value, and every later stage passes it on without
re-deriving or rewording it:

```ts
interface FailureRecord {
  kind: FailureKind; // existing FAILURE_KINDS
  message: string; // the harness/script's own words, redacted + sanitized
  source: FailureSource; // hook | headlessParse | processExit | signal | timeout | watchdog | spawn | ...
  detail?: {
    exitCode?: number;
    signal?: NodeJS.Signals;
    hookEvent?: string;
    errorType?: string;
  };
}
```

- Add `FAILURE_SOURCES` to `DashboardConstants.ts`, next to `FAILURE_KINDS`.
- `CliFailureTracker`, `CliTransportError`, `LogMonitorResult`, `_runtime` and the timeline
  `ATTEMPT_TERMINATED` payload all carry a `FailureRecord`, or its additive fields
  `failureKind` and `failureSource`.
- The generic strings ("Harness reported an error", "Failed to send prompt") become fallbacks
  in one helper, used only when `message` is empty, and that helper logs a warning.

### R2. Each harness owns its error extraction

Add one optional member, `describeHookError(rawHookData): string | undefined`, to the
notification monitor interface. Make sure `extractErrorFromStdout` / `metadata.error` exist
for every harness. `describeHarnessError` then asks the monitor instead of guessing a single
field:

| Harness     | Hook payload → message                                                                                                                                                           | Headless → message                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Claude      | `last_assistant_message` ✅ (2.1.319 capture: `error` is a category such as `"unknown"`; no `error_details`)                                                                     | existing `result.is_error`                                                                       |
| Copilot     | `error.message` (1.0.105 capture: `error` is an object with `message`, `name`, `stack`) ✅                                                                                       | **new:** `session.error` → `metadata.error` (`data.message`, `data.errorType`)                   |
| OpenCode    | `error.data.message ?? error.message ?? error.name` (reuse `getOpenCodeErrorMessage`) ✅ (1.19.5 capture: `{ name: "APIError", data: { message, statusCode, isRetryable, … } }`) | existing                                                                                         |
| Codex       | n/a                                                                                                                                                                              | existing `unwrapApiErrorMessage`                                                                 |
| Qwen        | n/a                                                                                                                                                                              | existing                                                                                         |
| Antigravity | n/a (but its Stop payload carries `terminationReason: "ERROR"` + `error`; see R4) ✅                                                                                             | stream-json `result` with `status: "ERROR"` → `error` ✅ (SYSTEM `ERROR_MESSAGE` is not written) |

The Claude, OpenCode and Antigravity rows now rest on real captures (§6). The Claude
monitor currently prefers the `error` category over `last_assistant_message`
(`dev/bugs/backlog/claude-stopfailure-reports-error-category-instead-of-text.md`). The
Copilot `session.error` capture confirms a session-level event with `data.message` and
`data.errorType`. All of these fit the detection rules, and tool failures stay out.

### R3. Classification rules, single-sourced in `getHeadlessFailure`

1. A parsed harness error means `HARNESS_ERROR`, whatever the exit code. The exit code goes
   into `detail`. (Exit code mapping is unchanged: both kinds already map to CLI exit 1.)
2. A signal ctrlyoke sent means `USER_CANCELLED`. A signal ctrlyoke did **not** send means
   `PROCESS_EXIT` with `detail.signal`. Reuse `terminatedByManager` from `CliProcessManager`.
3. Every kind except `USER_CANCELLED` goes through `errorBehavior`. Fold `unknown` and
   `sessionRejected` into `handleHarnessFailure`; `sessionRejected` may default to stop.

### R4. Interactive coverage for the three harnesses without an error hook

Do these in order, and keep the ERROR_BEHAVIOR_PLAN's "no keyword matching" rule:

1. ~~**Capture first.**~~ Done 2026-11-09 (§6):
   - Codex: no Stop, no exit; rollout `task_complete.error`.
   - Qwen: no Stop, no exit; `qwen-code.api_error` plus `request_lifecycle`
     `outcome: "error"`.
   - Antigravity: Stop fires with `terminationReason: "ERROR"`; no exit; no transcript
     error entry.
2. **Wherever a verified session-level log event exists**, teach the log parser to emit a
   typed session-error event that the monitor can see. `CliLogMonitor` resolves it as
   `HARNESS_ERROR` through the same path as the `-error.json` result.
   - Codex: the rollout's `task_complete` with `error`.
   - Qwen: done in ~558ef85. It must wait for the turn's final outcome, because a
     retried attempt also logs `api_error` (see the Qwen bug in H3).
3. **Wherever Stop fires after an error** (Antigravity), fail the step instead of accepting
   completion. Antigravity's Stop payload states the failure itself: have the hook treat
   `terminationReason: "ERROR"` as an error artifact carrying `error`. No log lookup is
   needed.
4. Only if neither signal exists, document the harness as "error detection: process exit /
   timeout only" in the compatibility table (`hooks.error` is already `unsupported`). Point
   users at `maxPromptTimeoutSec`. Its `-1` (unlimited) default **stays** (decided, §7); this
   plan never adds a finite default as a fallback for missing detection.

### R5. Scripts: "could not run" vs "returned false"

- `ScriptProcessRunner` marks a run `errored` for spawn errors and timeouts (as today), and
  also for:
  - a signal ctrlyoke did not send,
  - exit 126/127 when run through a shell, with a message such as "command not found:
    <first line of stderr>".
- `EvaluationResult` carries `signal` and keeps the partial output on timeout.
- `ConditionEvaluationSummary` gains `errored`/`timedOut`, which is additive.
- An errored script step with `onError: continue` ends **FAILED** (continued), matching
  prompt steps.
- The verdict's action comes from the same `canRetryErrorBehavior` decision that
  `handleEvaluationError` makes. Have `handleEvaluationError` return the action text, and
  have the verdict use it.
- PTY script spawn failures (`WorkflowInstance.spawnScriptPty`) return `errored`, not exit 1,
  so both hosts route the same way.
- ~~`runDecisionHook` (Phase 5, completed 2026-11-09):~~
  - Check `result.error` and `result.signal`.
  - Add a timeout.
  - Buffer stdout and forward it only after a clean exit.
  - On failure, write nothing to stdout and exit with the code that means "no decision" for
    that harness (decided, §7: not deny, not allow). The harness then falls back to its
    normal permission prompt, which fails safe. The per-harness code lives next to the
    decision-format normalizer in HOOK_DECISION_FORMAT_PLAN. A hook exit code must never be
    one the harness reads as blocking (Claude's 2) unless the user's own hook returned it.
  - Write a hook artifact so the failure reaches the timeline instead of only the debug log.

### R6. CLI: one reporter, one additive envelope

- Replace `handleCliError` with `reportCliError(error, { json, command, exitCode })` in
  `src/cli/CliExitCode.ts` (or a new `CliErrorReporter.ts`). It owns, in one place:
  - redaction (`secretRedactionService.redactText`) on both stdout and stderr,
  - `Error: ` prefix formatting,
  - closed-pipe handling (`exitQuietlyOnClosedPipe`),
  - the exit code.
- Every command handler and flag parser throws a typed `CliUsageError` (or calls the
  reporter). None calls `console.error` and `process.exit` directly.
- **JSON errors, additive within `schemaVersion: 1`:**
  - Commands that already have a shape keep it exactly.
  - Commands that print plain text under `--json` today (history family, secret, license,
    dry run) gain `{ schemaVersion: 1, success: false, error: { message, code? } }` on stdout.
    That is the run envelope's `error` object minus the step fields.
  - `step`'s `error: string` and validate's `error`/`errorCode` stay exactly as they are
    (decided, §7). The reporter takes a per-command envelope builder, so these two keep
    their shapes while sharing redaction, pipe handling and exit codes. No
    `schemaVersion: 2` is planned.
  - Document the general envelope in `docs/cli/ctrlyoke.md`.
- **Flag parsing:** one strict integer parser (`/^-?\d+$/` plus `isSafeInteger`, the
  `HistoryFilterParsing.ts:33` rule). It throws `InvalidArgumentError` so commander formats
  every flag error the same way. The timeout flags and `--port` use it.
- **Exit codes:** unchanged. The reporter takes them from the existing constants.

### R7. One toast per workflow-stopping failure, in every client

Decided (§7): a failure that stops a workflow shows a toast in VS Code **and** in the
hosted/standalone server's browser dashboard, unless the user's notification settings turn
it off. Retries and `continue` show no toast; the step row and output rows carry those.

**Today there are two toast channels, and both already reach VS Code and the browser:**

| Channel                  | Producer                                                                                                                                                                                                               | Delivered by                                                                                            | Gated by                                                                                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Completion notifications | `buildWorkflowCompletionNotification` (`CompletionNotificationFactory.ts:146`) fires "ctrlyoke - Workflow Failed" on every in-flight → `EXECUTION_STATES.ERROR` transition; deduped by `CompletionNotificationTracker` | VS Code toast; browser through the hosted server (connected tabs, or Web Push through `WebPushService`) | `notifications.events.workflowComplete` (`all` / `failuresOnly` / `none`), `notifications.vscode.enabled`, `notifications.browser.mode` (default `never`), `notifications.onlyWhenWindowUnfocused` (default `true`) |
| User-feedback toasts     | `notifyUserFeedback` (`src/core/UserFeedbackSink.ts:86`)                                                                                                                                                               | `VsCodeUserFeedbackSink`, `HostedWebSocketUserFeedbackSink`, `ConsoleUserFeedbackSink` (CLI stderr)     | `notifications.toastLevel`                                                                                                                                                                                          |

**The "turned off" case needs no new setting.** "Toasts off" already has a meaning:
`events.workflowComplete: none`, the per-channel switches (`vscode.enabled`,
`browser.mode: never`), and `onlyWhenWindowUnfocused` while focused. The stop toast
respects all of them because it _is_ the completion notification. `toastLevel` keeps
governing user-feedback toasts only.

**Changes:**

- The completion notification is the single stop toast. Its body (`buildWorkflowBody`,
  `CompletionNotificationFactory.ts:244`) gains the failing step label and the
  `FailureRecord.message` (R1). The message is redacted, and truncated to about 200 chars
  so OS notification bodies don't clip mid-word. Example: "Refactor auth - prompt 3 -
  Rate limit exceeded - 2 of 5 prompts - in 4m 12s".
- `WorkflowSummary` (`CtrlYokeTypes.ts:1417`) gains an optional
  `failure?: { stepLabel; kind; message }`, set when the workflow enters `ERROR`. It is
  additive, but it crosses into webview and server payloads, so keep `WebviewMessageTypes`,
  the hosted server summary publish and the dashboard sink in sync. This is the same
  summary the hosted server's notification path already reads, so both clients get the
  reason from one place.
- Remove the ad hoc stop-site `notifyUserFeedback` calls in `handlePromptSendFailure`
  (`WorkflowExecutor.ts:5638`, `unknown`/`sessionRejected`) and the guardrail warning
  (`:5882`), so a stop never produces two toasts.
  - Check first that the CLI still prints the reason on stderr without them, because
    `ConsoleUserFeedbackSink` was one of their outputs. Pin text stderr and the `--json`
    `error` field with a CLI integration test; make the CLI final-summary path own either
    output if the toast was the only source.
  - Other `notifyUserFeedback` uses (settings, terminal, startup) are unaffected.
- 🔎 Confirm every workflow-stopping failure ends in `EXECUTION_STATES.ERROR`, not
  `STOPPED`, so it triggers the notification:
  - harness-failure stop,
  - script step `onFail: stopWorkflow`,
  - an errored script or condition under `onError: stop`,
  - preCondition `stopWorkflow` (`failStepForInternalError`),
  - the prompt-timeout guardrail stop (CLI exit 6).

  **Phase 3b trace (2026-11-09):** each listed path reaches the shared error
  transition; `isWorkflowCompletionTransition` already accepts in-flight →
  `ERROR` and excludes `STOPPED`, keeping user-requested stops toast-free.

  Any path that ends elsewhere either moves to `ERROR` or is added to
  `isWorkflowCompletionTransition` explicitly. A user-requested stop stays toast-free.

  **Phase 3b complete (2026-11-09):** pinned CLI stderr and JSON `error` output in a
  test-first commit, then removed the executor stop toasts. The CLI final summary now
  prints stop/failure reasons to stderr, and the JSON error carries the same reason;
  guardrail summaries populate `WorkflowSummary.failure` so the single completion
  notification includes it. Retry and continue paths remain toast-free.

- Tests: `CompletionNotificationFactory.test.ts` (body with step and reason, redaction,
  truncation, `none`/`failuresOnly` gating); `NotificationManager.test.ts` asserts one
  completion notice per failure, while executor tests assert no feedback toast per stop,
  retry or continue; a hosted-server test that the browser notification body matches.
- Docs: `docs/guide/notifications.md` says a "Workflow Failed" notification names the
  failing step and reason, and which settings turn it off. CHANGELOG _Changed_: failure
  notifications now include the failing step and reason, and the duplicate error popup is
  gone.

---

## 5. Implementation phases

Each phase is one or a few commits. Tests go with the code: `src/test/unit/**` for
core, harness and CLI, and `src/ui/webview-react/test/**` for the step row.

**Staging (orchestrator, 2026-11-08):** the live captures in §6, including R4 step 1, run
first as their own step (Phase 0) so every later phase builds on real fixtures. Phase 3 is
split into 3a (timeline record and step row) and 3b (R7 notifications). Phase 6 is split
into 6a (reporter, sweep and JSON envelope) and 6b (strict integer flag parser).

0. **Phase 0: live captures (§6).** Fixtures and recorded findings only, no product code.

1. ~~**Harness error text (H1, H4).** Add `describeHookError` per monitor, fix the Copilot
   no-session-ID filename, and add payload fixtures captured from real harnesses (§6).
   Highest value, smallest change, no contract impact. File a `dev/bugs/` entry for H1
   and close it in the same commit.~~ At implementation time Claude and OpenCode had no real
   error-hook payload fixture, so their extraction followed the documented shapes. The
   later captures (§6) confirm the OpenCode shape. The Claude payload puts a category in
   `error`, which the extraction currently prefers (open bug, see R2). Copilot extraction
   uses the captured fixture.
2. ~~**Headless extraction and classification (H2, H5, H6).** Copilot and Antigravity get
   `metadata.error`. Add the classification rules in `getHeadlessFailure`, route
   `unknown`/`sessionRejected` through `errorBehavior`, and add `FAILURE_SOURCES`.
   _CHANGELOG Changed:_ a Copilot or Antigravity headless run that reported an error now
   fails instead of succeeding, and an external signal kill now follows `errorBehavior`.~~
   Implemented in Phase 2 on 2026-11-09.
3. **Failure record surfaces (H7).** **Phase 3 complete (2026-11-09):**
   - Add `failureKind`/`failureSource` to the `ATTEMPT_TERMINATED` payload. This is an
     optional field; confirm under `PersistedSchemaGuard` rules whether the timeline format
     needs a version bump.
   - Show `failureMessage` on the step row for every failed step.
   - R7: `WorkflowSummary.failure`, enrich the "Workflow Failed" notification body, and
     remove the duplicate stop-site `notifyUserFeedback` toasts. The failure-stop paths
     end in `ERROR`; user-requested `STOPPED` remains excluded from completion notices.
4. ~~**Script classification (S1–S5, S7).**~~ Implemented 2026-11-09: runner and evaluator classify external signals and shell 126/127 as run errors, preserve timeout output, PTY startup errors share `errorBehavior`, and continued errored script steps remain failed. Verdict action follows retry exhaustion; the CLI folds the action into the verdict. Docs and changelog updated. The 126/127 shell heuristic also classifies scripts that deliberately return those codes. Tests cover signal, manager cancellation, timeout output, shell 126/127, and PTY spawn failure.
   ~~Changes in the runner, evaluator, executor and
   PTY path, with fixtures for 126/127/SIGKILL/timeout. _CHANGELOG Changed:_ a missing
   command or killed script now counts as "could not run" (follows `errorBehavior`), and an
   errored script step with `onError: continue` now shows as failed.~~
5. ~~**Decision hook failures (S6).**~~ Implemented 2026-11-09. Decision hooks now buffer
   stdout until a clean exit, treat spawn errors, signals, timeouts and output overflow as
   no decision, log stderr, and emit a visible error artifact for the run timeline. No-decision
   exit codes live beside the future format normalizer in
   `src/scripts/ctrlyoke-hook-decision-format.js`.
6. **CLI reporter (C1–C4).** Split into 6a and 6b. Phase 6a is complete: the shared
   reporter routes history/status/export/import, step, secret, license and dry-run errors
   through one path and documents the JSON error envelope. **Phase 6b complete
   (2026-11-09):** added a shared strict safe-integer parser for timeout flags and
   `server --port`; `1e3`, `0x10`, whitespace-padded and blank values are rejected with
   Commander argument errors. The broader command-wide baseline snapshots and direct-exit
   sweep remain open.
7. **Phase 7: R4 per-harness interactive coverage.** Depends on the live captures; one
   commit per harness. Update `docs/harnesses/compatibility.md` through
   `npm run check:docs`/`scripts/generate-compatibility-docs.mjs`.

When this plan ships, move the ledger's "CLI error reporting" Deferred entry into the pass log.

---

## 6. Live capture findings (2026-11-09)

Findings below use real local CLI runs. Fixtures are redacted under
`src/test/fixtures/harness-errors/`; README files record capture versions and methods.
The second pass (also 2026-11-09) used a local stub server bound to 127.0.0.1 that returns
provider-shaped, **non-retryable** errors at once. Earlier probes had stalled on
connection errors that the CLIs retry for minutes. Every probe ran from a fresh scratch
workspace with an isolated config home or scratch-only hooks, and the user's global
configs were not modified. Interactive Stop results are backed by a positive-control
turn in the same setup.

- **Claude Code `StopFailure` — captured; Phase 1.** Claude Code 2.1.319, with an isolated
  `CLAUDE_CONFIG_DIR` and the stub answering `400 invalid_request_error`.
  - `StopFailure` fired within a second, and `Stop` did not fire. The TUI stayed open.
  - In the payload, `error` is a category string (`"unknown"`), and the provider text is in
    `last_assistant_message` (`"API Error: 400 …"`). There is no `error_details` field.
  - The current `describeHookError` returns the category
    (`dev/bugs/backlog/claude-stopfailure-reports-error-category-instead-of-text.md`).
  - A 401 is retried (`attempt N/10`, with backoff), which is why the earlier probe never saw
    `StopFailure`.
  - Fixture: `src/test/fixtures/harness-errors/claude/stopfailure-hook-input.json`.
- **Copilot CLI `errorOccurred` — captured; Phase 1 / H4.** GitHub Copilot CLI 1.0.105
  (≥1.0.19) supplied `sessionId` as a string and `error` as an object with `message`,
  `name`, and `stack`. Fixture:
  `src/test/fixtures/harness-errors/copilot/erroroccurred-hook-input.json`. This resolves
  the current-shape question in H4; the no-ID fallback filename remains a possible edge
  case, not observed in this capture.
- **OpenCode v1 `session.error` — captured; Phase 1.** OpenCode 1.19.5, with a scratch
  `opencode.json` custom provider and the stub answering an OpenAI-shaped 401
  (`isRetryable: false`).
  - `properties.error` is `{ name: "APIError", data: { message, statusCode, isRetryable,
responseHeaders, responseBody, metadata } }`. `getOpenCodeErrorMessage`'s
    `error.data.message` reads it correctly.
  - On the bus, `session.error` came first, then `session.status` idle and `session.idle` in
    the same millisecond.
  - ctrlyoke's real v1 plugin wrote `<session>-error.json` 2 ms before `<session>-stop.json`.
    The process stayed in the TUI.
  - Fixtures: `opencode/v1-session-error-event-order.jsonl` and
    `opencode/v1-session-error-artifact.json`.
- **OpenCode v2 `session.error` and immediate idle — unavailable; Phase 1.**
  `npm view opencode-ai versions` still lists no 2.x release (latest 1.19.5), so the v2
  plugin path and its idle/error write ordering remain unexercised.
- **Codex interactive API error — captured; Phase 7.** Codex CLI 0.166.0, with an isolated
  `CODEX_HOME` whose custom `model_provider` points at the stub (retries off, workspace
  pre-trusted). Hooks were inline `-c hooks.*` overrides trusted by ctrlyoke's own builder.
  - Positive control: Stop fired on a successful stub turn.
  - On a 401: `SessionStart` and `UserPromptSubmit` fired, **Stop did not**, and the process
    stayed in the TUI until the 45-second cap. Codex hangs (H3).
  - The rollout writes `event_msg` `task_complete` with `last_agent_message: null` and
    `error: { message, codex_error_info: { http_connection_failed: { http_status_code } } }`.
    That is a typed session-level signal for R4 step 2.
  - Fixtures: `codex/interactive-rollout-task-error.jsonl` and
    `codex/interactive-pty-excerpt.txt`.
- **Qwen interactive API error — captured; Phase 7.** Qwen Code 0.26.7, with an isolated
  `HOME`, `openai` auth pointing at the stub, and hooks passed through
  `QWEN_CODE_SYSTEM_SETTINGS_PATH`.
  - Positive control: Stop fired.
  - On a 401: **Stop does not fire**, and the TUI stays open. The chat JSONL records
    `request_lifecycle` started, `qwen-code.api_error`, then `request_lifecycle` ended with
    `outcome: "error"`. Fixture: `qwen/interactive-401-lifecycle-session-log.jsonl`.
  - One 429, then success: the OpenAI SDK retried internally and **no `api_error` was
    written**. One lifecycle ended `success`. Fixture:
    `qwen/interactive-sdk-retried-429-session-log.jsonl`.
  - Four 429s, then success: the attempt that surfaced past the SDK **was** logged as
    `api_error` with a lifecycle ending `error`. Qwen's outer retry then started a new
    lifecycle (new `executionId`, same `promptId`) that ended `success`, and Stop fired.
    Fixture: `qwen/interactive-outer-retried-429-session-log.jsonl`.
  - So `api_error` marks one failed attempt, not the turn's outcome, and the detection added
    in ~558ef85 fails such a recovered turn
    (`dev/bugs/backlog/qwen-retried-api-error-fails-recovered-turn.md`).
  - The original DashScope fixtures (`qwen/interactive-session-log.jsonl`, `…-pty-excerpt.txt`)
    are unchanged.
- **Antigravity headless error — captured; Phase 2.** agy 1.5.3 is installed as `agy`; the
  earlier probe looked for `antigravity`. It ran with
  `--settings '{"modelProvider":"gemini"}'`, a dummy `GEMINI_API_KEY`, and
  `GOOGLE_GEMINI_BASE_URL` pointing at a stub returning a Gemini-shaped 401.
  - The process exited 3.
  - stdout's last stream-json event is `result` with `status: "ERROR"` and the text in
    `error`. The error step appears only as a textless `step_update` with
    `step_type: "error_message"`.
  - stderr has `error: …` plus an `AGY_ERROR: {…}` JSON line (`status`, `error_code`,
    `retryable`).
  - **No SYSTEM `ERROR_MESSAGE` entry is written to the transcript** (nor found in any
    existing transcript), so Phase 2's transcript extraction never fires
    (`dev/bugs/backlog/antigravity-headless-error-not-parsed-from-stream-json.md`).
  - The synthesized `antigravity/headless-system-error.jsonl` was removed. Fixtures:
    `antigravity/headless-stream-json-error.jsonl` and `antigravity/headless-stderr.txt`.
  - A bogus `--model` fails client-side validation (exit 1, before any request) and is not
    a provider error.
- **Antigravity interactive API error — captured; Phase 7.** Same stub, with hooks in the
  scratch workspace's `.agents/hooks.json` (trusted through `--settings`).
  - Positive control: Stop fired with `terminationReason: "NO_TOOL_CALL"` and `error: ""`.
  - On the 401, **Stop fires** with `terminationReason: "ERROR"` and the provider text in
    `error`. The TUI showed `⚠ agent executor error …` and the process did not exit.
  - The transcript again holds only the user input. With today's hook script the step
    succeeds silently, which R4 step 3 addresses.
  - Fixtures: `antigravity/interactive-stop-hook-error.json`,
    `antigravity/interactive-stop-hook-success.json` and
    `antigravity/interactive-pty-excerpt.txt`.
- **Copilot headless `session.error` — captured; Phase 2.** With Copilot CLI 1.0.105 and a
  local OpenAI-compatible provider forced to refuse the connection, stdout contained
  `session.error` (`data.errorType: "query"`, with `data.message`) followed by
  `assistant.idle`; the process exited 1. Fixture:
  `src/test/fixtures/harness-errors/copilot/headless-session-error.jsonl`. In this captured
  case the process did not exit 0; this does not establish behavior for every error class.

## 7. Decisions (settled with the user, 2026-11-08)

1. **Default prompt timeout:** keep `execution.maxPromptTimeoutSec: -1` (unlimited).
   Interactive hangs are fixed by detection (R4), never by a finite default.
2. **Toasts:** a failure that stops a workflow shows a toast in every client, VS Code and
   the hosted/standalone browser dashboard, unless the user's notification settings turn
   it off. Retry and continue show none. Implemented as the existing completion
   notification with the reason added (R7).
3. **Decision-hook failures:** "no decision". The hook emits nothing and the harness asks
   the user as normal; never deny, never allow (R5).
4. **`step` and `validate` JSON error shapes:** leave as is; no `schemaVersion: 2` (R6).
