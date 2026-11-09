# Error Handling Consistency Plan (harnesses, scripts, CLI)

**Status:** Not started. Research and recommendation done; open decisions settled with the
user on 2026-11-08 (§7).

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
  - Antigravity's SYSTEM `ERROR_MESSAGE` becomes TEXT through `transcript.error`
    (`AntigravityLogParser.ts:773-787,432-439`).
  - Neither sets `metadata.error` or implements `extractErrorFromStdout`. Only Codex and
    Qwen implement it.
  - If the process exits 0 after such an error, the step **succeeds** with the error text as
    its response. If it exits non-zero, the message falls back to a stderr summary or
    "Process exited with code N".
- **H3 ✅ Interactive Codex, Qwen and Antigravity can hang forever on an API error.**
  - They have no error hook and no log signal.
  - `execution.maxPromptTimeoutSec` defaults to `-1`, which means unlimited
    (`CtrlYokeSettings.ts:628`).
  - `InteractiveTurnStartWatchdog` is cancelled as soon as a turn starts, so it cannot see a
    failure in the middle of a turn.

  Unless the TUI fires Stop after the error (🔎 not verified per harness), the step waits
  until the user cancels. If Stop does fire, the step **succeeds** silently. The
  ERROR_BEHAVIOR_PLAN listed this as "the actively-broken case" and fixed it only for the
  three harnesses with hooks.

- **H4 ✅ An error file can be missed when Copilot sends no session ID.**
  - Without a session ID, `ctrlyoke-copilot-hook.js` falls back to writing
    `errorOccurred-<ts>.json` (line 167).
  - The wildcard scan matches `/-error\.json$/` (`INotificationMonitor.ts:376-379`), and that
    name does not match it.

  🔎 Check whether current Copilot `errorOccurred` input includes `sessionId`.

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
  - The timeline `ATTEMPT_TERMINATED` payload has `{ terminalState, reason }` and no
    `failureKind` (`WorkflowTimelineTypes.ts:384-393`). History and search therefore cannot
    tell a timeout from a rate limit.
  - The dashboard step row shows `_runtime.failureMessage` only in the "Workflow continued
    after failure" case (`WorkflowStepRow.tsx:135-145`). A stopped workflow's failed step
    shows no reason on the row.
  - Stop toasts are uneven (detail in R7). Every stop into `ERROR` gets a "Workflow Failed"
    completion notification, but its body carries no failing step and no reason. The
    `unknown`/`sessionRejected` stops and the timeout guardrail also raise a second, ad hoc
    `notifyUserFeedback` toast.

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

| Harness     | Hook payload → message                                                                | Headless → message                                                             |
| ----------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Claude      | `error` (+ `error_details`, `last_assistant_message`) 🔎                              | existing `result.is_error`                                                     |
| Copilot     | `error.message` / `error` string 🔎                                                   | **new:** `session.error` → `metadata.error` (`data.message`, `data.errorType`) |
| OpenCode    | `error.data.message ?? error.message ?? error.name` (reuse `getOpenCodeErrorMessage`) | existing                                                                       |
| Codex       | n/a                                                                                   | existing `unwrapApiErrorMessage`                                               |
| Qwen        | n/a                                                                                   | existing                                                                       |
| Antigravity | n/a                                                                                   | **new:** SYSTEM `ERROR_MESSAGE` → `metadata.error`                             |

The Copilot `session.error` and Antigravity `ERROR_MESSAGE` events are session-level and were
already verified by the ERROR_BEHAVIOR_PLAN research, so they fit its detection rules. Tool
failures stay out.

### R3. Classification rules, single-sourced in `getHeadlessFailure`

1. A parsed harness error means `HARNESS_ERROR`, whatever the exit code. The exit code goes
   into `detail`. (Exit code mapping is unchanged: both kinds already map to CLI exit 1.)
2. A signal ctrlyoke sent means `USER_CANCELLED`. A signal ctrlyoke did **not** send means
   `PROCESS_EXIT` with `detail.signal`. Reuse `terminatedByManager` from `CliProcessManager`.
3. Every kind except `USER_CANCELLED` goes through `errorBehavior`. Fold `unknown` and
   `sessionRejected` into `handleHarnessFailure`; `sessionRejected` may default to stop.

### R4. Interactive coverage for the three harnesses without an error hook

Do these in order, and keep the ERROR_BEHAVIOR_PLAN's "no keyword matching" rule:

1. **Capture first.** Use the PTY probing recipe in `.github/copilot-instructions.md` to
   force an API error (an invalid key or a bogus model where accepted mid-session) in
   Codex, Qwen and Antigravity. Record (a) whether Stop fires, (b) what the session log
   writes, and (c) whether the process exits.
2. **Wherever a verified session-level log event exists** (Antigravity's SYSTEM
   `ERROR_MESSAGE` is the likely one), teach the log parser to emit a typed
   session-error event. `CliLogMonitor` resolves it as `HARNESS_ERROR` through the same path
   as the `-error.json` result.
3. **Wherever Stop fires after an error**, check the latest turn for that session-error event
   before accepting completion, so the step fails instead of succeeding silently.
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
- `runDecisionHook`:
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
    `ConsoleUserFeedbackSink` was one of their outputs. The CLI's status-message line and
    `--json` `error` already carry it; pin that with a CLI snapshot test.
  - Other `notifyUserFeedback` uses (settings, terminal, startup) are unaffected.
- 🔎 Confirm every workflow-stopping failure ends in `EXECUTION_STATES.ERROR`, not
  `STOPPED`, so it triggers the notification:
  - harness-failure stop,
  - script step `onFail: stopWorkflow`,
  - an errored script or condition under `onError: stop`,
  - preCondition `stopWorkflow` (`failStepForInternalError`),
  - the prompt-timeout guardrail stop (CLI exit 6).

  Any path that ends elsewhere either moves to `ERROR` or is added to
  `isWorkflowCompletionTransition` explicitly. A user-requested stop stays toast-free.

- Tests: `CompletionNotificationFactory.test.ts` (body with step and reason, redaction,
  truncation, `none`/`failuresOnly` gating); an executor test asserting exactly one
  notification per stop and none per retry or continue; a hosted-server test that the
  browser notification body matches.
- Docs: `docs/guide/notifications.md` says a "Workflow Failed" notification names the
  failing step and reason, and which settings turn it off. CHANGELOG _Changed_: failure
  notifications now include the failing step and reason, and the duplicate error popup is
  gone.

---

## 5. Implementation phases

Each phase is one or a few commits. Tests go with the code: `src/test/unit/**` for
core, harness and CLI, and `src/ui/webview-react/test/**` for the step row.

1. **Harness error text (H1, H4).** Add `describeHookError` per monitor, fix the Copilot
   no-session-ID filename, and add payload fixtures captured from real harnesses (§6).
   Highest value, smallest change, no contract impact. File a `dev/bugs/` entry for H1
   and close it in the same commit.
2. **Headless extraction and classification (H2, H5, H6).** Copilot and Antigravity get
   `metadata.error`. Add the classification rules in `getHeadlessFailure`, route
   `unknown`/`sessionRejected` through `errorBehavior`, and add `FAILURE_SOURCES`.
   _CHANGELOG Changed:_ a Copilot or Antigravity headless run that reported an error now
   fails instead of succeeding, and an external signal kill now follows `errorBehavior`.
3. **Failure record surfaces (H7).**
   - Add `failureKind`/`failureSource` to the `ATTEMPT_TERMINATED` payload. This is an
     optional field; confirm under `PersistedSchemaGuard` rules whether the timeline format
     needs a version bump.
   - Show `failureMessage` on the step row for every failed step.
   - R7: `WorkflowSummary.failure`, enrich the "Workflow Failed" notification body, and
     remove the duplicate stop-site `notifyUserFeedback` toasts.
4. **Script classification (S1–S5, S7).** Changes in the runner, evaluator, executor and
   PTY path, with fixtures for 126/127/SIGKILL/timeout. _CHANGELOG Changed:_ a missing
   command or killed script now counts as "could not run" (follows `errorBehavior`), and an
   errored script step with `onError: continue` now shows as failed.
5. **Decision hook failures (S6).** Coordinate with HOOK_DECISION_FORMAT_PLAN Phase 2 if it
   is in flight.
6. **CLI reporter (C1–C4).** Mechanical sweep of the 26 sites, plus the strict integer
   parser and the additive JSON envelope. Snapshot tests pin each command's stderr text,
   JSON shape and exit code before and after, so the sweep provably changes only what is
   listed in the CHANGELOG. _CHANGELOG Changed:_ `--json` now yields a JSON error for
   history/secret/license/dry-run, and `1e3`/`0x10` are rejected for timeout flags.
7. **Phase 7: R4 per-harness interactive coverage.** Depends on the live captures; one
   commit per harness. Update `docs/harnesses/compatibility.md` through
   `npm run check:docs`/`scripts/generate-compatibility-docs.mjs`.

When this plan ships, move the ledger's "CLI error reporting" Deferred entry into the pass log.

---

## 6. Verification to do before or during Phase 1

- Real `StopFailure` hook input from Claude Code (which field holds the text; are there
  `error_details` and `last_assistant_message`?).
- Real `errorOccurred` input from Copilot CLI ≥1.0.19 (is `error` an object; is `sessionId`
  present?).
- OpenCode `session.error` `properties.error` shape on the v1 and v2 plugin paths. Also
  confirm that the v2 bridge's immediate idle (`index.ts:165`) cannot write a stop file
  that the monitor reads before the error file. The monitor checks the error file first in
  each poll, but the two are written separately.
- Whether Codex, Qwen and Antigravity fire Stop after an API error (R4 step 1).
- Whether headless Copilot exits 0 after `session.error` (decides how bad H2 is in practice).

Capture each one into a fixture under `src/test/fixtures/` so the extraction tests use
real payloads, not synthetic `{ message }` objects.

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
