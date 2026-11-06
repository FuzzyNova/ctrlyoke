# Harness-Native Command Prompts Plan (`!` shell escapes and `/` TUI commands)

**Status:** Not started.

Last reviewed against code: 2026-11-06. The workflow schema doesn't change. The new step status
is persisted run data (see Phase 3). The editor diagnostic and the new status are user-visible,
so they need a **Changed** entry in `CHANGELOG.md` when they ship.

**Scope: interactive mode only.** In headless mode the process is the turn: it starts when the
process starts and ends when the process exits, so a missing start or stop signal can't happen.
Headless runs may honor a leading `!`, but they have no menus for `/config`-style commands to
open, and either way the step still ends when the process exits. Phases 1 and 2 still apply in
headless mode, because ctrlyoke doesn't support `!` in steps at all. Phase 3 is interactive-only.

## Problem

All six harness TUIs read two kinds of prompt text natively, and in interactive mode both can
leave a step waiting forever:

1. **`!` shell escapes.** In every harness, a prompt that starts with `!` (`! echo hello`) runs a
   shell command in the TUI. No AI turn starts, so no Stop hook fires. The command runs and the
   step never completes.
2. **`/` TUI commands.** Some slash commands start a real turn (`/handoff`, which runs a saved
   skill, behaves like a normal step). Others only open a view (`/config`, `/usage`), so no
   turn starts and no Stop hook fires. Those steps also never complete. They also leave a view
   open that the next step's keystrokes would type into.
3. **OpenCode only: a `!` anywhere in a typed prompt.** When ctrlyoke reuses a live OpenCode
   session, a `!` anywhere in the prompt can turn it into a shell command.
   "thank you for helping me test opencode support in ctrlyoke!" was shown as `$ thank you…`
   and run in pwsh. The cause: `CliExecutionRunner.writeTurnToLivePty` writes the prompt in
   256-byte chunks with no bracketed paste, so OpenCode handles the whole chunk as one burst of
   keypresses. OpenCode's `!` → shell-mode binding (`packages/tui/src/component/prompt/index.tsx`,
   the `Keymap.createLayer` with `bind: "!"`) is only active while `visualCursor.offset === 0`.
   It is re-checked through a `cursorVersion` signal, which apparently has not updated by the
   time the trailing `!` arrives. A person typing at normal speed never hits this. The other
   five harnesses only react to a `!` at the start of the prompt (tested manually 2026-11-06).

What ctrlyoke does today:

- `HarnessIntegration.extractLeadingSlashCommand` takes the leading `/^(\/\w+)/` of the prompt
  (skipping ctrlyoke's own `/skill:`/`/mcp:` tokens). `CliPromptPreparer` then uses it two ways:
  - **Bare command** (`/^\/\w+\s*$/`, `isPureSlashCommand`): instruction assembly is skipped and
    the text is sent verbatim (`createInlinePlan`). This is what lets `/handoff` work.
  - **Command plus more text:** the normal categorized prompt file is built, and the command is
    put in front of the instruction line: `/handoff using these … follow the instructions in
    @prompt.1.md`. The prompt file still contains the full original text.
- **Bug: names with hyphens are cut short.** `\w` excludes `-`, so `/run-tests ui` is read as the
  command `/run`. It isn't a bare command, so the outgoing line becomes `/run follow the
  instructions in @prompt.1.md` and runs the wrong command. A plugin-namespaced command
  (`/plugin:cmd`) is cut short the same way. Fixed in Phase 4.
- When the terminal is reused, `HarnessIntegration.canSendToRunningTerminal` sends any prompt
  without control characters inline, so `! echo hello` and mid-prompt `!` are typed raw.
- When the terminal is reused, ctrlyoke waits only for the Stop notification
  (`CliExecutionRunner.monitorLogFile`). The start wait in
  `NotificationMonitorBase` (`getStartHookEvents`, `{runId}-start.json`) applies only to a fresh
  spawn. Even there it is a *session* start. A session can start (SessionStart fires) while the
  first input is a `!` or `/config` that never produces a turn.

## Decision

Handle the two prefixes differently, because they are different kinds of problem:

- **`!` is always a shell escape, so remove it before it reaches the TUI.** ctrlyoke does not
  support harness shell escapes in steps. Running a command already has a first-class form, the
  script step, which records the exit code and output and works with end conditions and
  `$previous`. Supporting `!` would mean detecting when the command finishes in six TUIs that
  give no turn, no hook and possibly no log entry. That would be a second, worse version of
  script steps. **Rejected.**
- **`/` can't be classified ahead of time, so keep passing it through and handle the
  no-turn case at run time.** Which slash commands start a turn depends on the harness, its
  version and the user's installed skills and commands. A hard-coded list of UI-only commands
  would keep going stale. **Rejected** as the main mechanism. A turn-start watchdog
  settles it at run time instead.

## Phase 0 — Find a per-turn start signal for each harness

The watchdog in Phase 3 needs an event that fires **once per submitted turn**, including in a
reused terminal. The candidates below already exist in the notification monitors. Each one needs
checking in an interactive capture (see "Probing a harness CLI's interactive log format" in
`.github/copilot-instructions.md`): a normal prompt, `! echo hello`, `/config` and a skill-backed
slash command. For each, record whether the signal fires on a first turn and on a reused turn.

| Harness         | Candidate per-turn signal                  | Where it's named today                              |
| --------------- | ------------------------------------------ | --------------------------------------------------- |
| claude-cli      | `UserPromptSubmit` hook                    | `ClaudeNotificationMonitor` (`userPromptSubmit`)    |
| codex-cli       | `UserPromptSubmit` hook                    | `CodexNotificationMonitor`, `CodexProtocolConstants` |
| qwen-cli        | `UserPromptSubmit` hook                    | `QwenNotificationMonitor` (already a start event)   |
| copilot-cli     | `userPromptSubmitted` hook                 | `CopilotNotificationMonitor`                        |
| opencode-cli    | `session.status.busy` plugin event         | `OpenCodeNotificationMonitor` (`userPromptSubmit`)  |
| antigravity-cli | `PreInvocation` hook (check it's per turn) | `AntigravityNotificationMonitor.getStartHookEvents` |

Questions to answer for each harness:

1. Does the signal fire for a skill-backed slash command (it should, since that is a real turn)?
2. Does it stay silent for `!` and for UI-only slash commands (it must, or the watchdog can never
   trigger)?
3. Is it written to a run-scoped file (`{runId}-…json`) so parallel workflows can't see each
   other's turns? If not, does the session ID scoping hold up in reuse mode?

The session log is the second signal for every harness, not only a fallback for one that lacks a
hook. During a turn, `CliLogMonitor` already streams the session log for this session ID (the
path is in `lastInteractiveContext.logPath`). Any parsed event dated after the submit shows that
a turn started. Phase 0 should also confirm that `!` and UI-only slash commands write nothing
the log parser turns into an event. If they do (for example, a "shell command ran" record), the
Phase 3 log check must ignore that event type. Record the results in this doc before starting
Phase 3.

Note on what exists today: the start wait that has a timeout
(`NotificationMonitorBase`, `{runId}-start.json`) runs only on a fresh spawn and waits for a
*session* start. The log-file fallbacks in the log parsers find the session ID and log file;
they don't detect the start of a turn. So when a terminal is reused, nothing currently detects
"this turn started". Phase 3 adds that, built from the hook plus the log stream described above.

Users can't switch off ctrlyoke's hooks. ctrlyoke passes them to the harness inline at launch,
and the Stop hook that every interactive prompt already depends on is configured the same way.
A harness-level kill switch (Claude's own `disableAllHooks`, say) would already break completion
for every prompt. Phase 3 doesn't need its own guard for that.

## Phase 1 — Never type a `!` that the harness would treat as a shell escape

1. Add one shared predicate in `src/utils/`, e.g. `isHarnessShellEscape(promptText)`, which is
   true when the trimmed text starts with `!`. Make the `!` a named constant, not a repeated
   literal.
2. In `HarnessIntegration.isSimplePrompt` and `canSendToRunningTerminal`, return `false` when the
   predicate matches. The prompt then always goes through the prompt-file path, and the TUI sees
   only "follow the instructions in @prompt.1.md". The step is an ordinary AI turn: hooks fire,
   it completes, and if the model runs `echo hello` the output appears as a normal tool call.
3. **OpenCode mid-prompt `!`:** override `canSendToRunningTerminal` in the OpenCode integration
   to return `false` whenever the text contains `!` anywhere. Better if it works: send the
   reused-terminal prompt wrapped in bracketed paste (`\x1b[200~` … `\x1b[201~`) so OpenCode
   receives one paste event instead of separate keypresses. First check that OpenCode's input
   enables bracketed paste through the PTY. Also check whether a long paste turns into a
   "[pasted text]" placeholder, which would change what the model receives. Keep any
   paste-wrapping as a per-harness hook on `writeTurnToLivePty`, not a global change. Copilot's
   focus-pulse handling shows these TUIs differ.
4. Check the instruction line itself: no generated categorized instruction
   (`CliIntegration.formatCategorizedInstruction`) may contain a `!`. A workspace path containing
   `!` could put one there. Either quote it or take the file path.

Tests (`src/test/unit/`): the predicate; `isSimplePrompt` and `canSendToRunningTerminal` reject a
leading `!`; the OpenCode override rejects a mid-prompt `!`; `CliPromptPreparer` produces a
file-based plan for `! echo hello` in both spawn and reuse modes.

## Phase 2a — Lint rule and dashboard fix for a leading `!`

1. **Rule.** Add a `PROMPT_DIAGNOSTIC_CODES` entry and a rule in `src/utils/PromptDiagnosticRules.ts`
   that warns when a prompt step's text starts with `!` (after trimming whitespace). Underline
   only the `!`. Suggested message: "A leading `!` is a harness shell escape, which steps don't
   support. This text is sent to the AI as a prompt. To run a command, use a script step."
   Because the rules are shared, the warning shows in both the dashboard prompt editor and VS
   Code's `PromptDiagnosticsProvider` with no extra wiring.
2. **Dashboard fixes.** `toCodeMirrorPromptDiagnostic` (`promptDiagnosticCodeMirror.ts`) already
   offers diagnostic actions, including a host callback (`defineVariable` → "Add "x" to workflow
   vars"). Add two actions for this code:
   - **Convert to script step:** a new host callback in `PromptDiagnosticActionOptions` that calls
     `editorStore.setStepType(STEP_TYPES.SCRIPT)` and sets the script command to the text after
     the `!` (trimmed). Like every editor change, it is saved to the working file right away. It
     is reversible: `setStepType` keeps the prompt text and the script command when the type
     changes, so switching back to a prompt step restores the original text.
   - **Remove "!":** a plain text replacement that deletes the `!` and the whitespace after it,
     for when the text really was meant as a prompt.
3. **Docs:** add a short note to the hand-written prompt/steps docs page explaining that `!` isn't
   a shell escape in ctrlyoke and pointing to script steps.

Tests: the rule (leading `!`, leading whitespace then `!`, `!` mid-text → no warning, script
step → no warning); both actions in the dashboard (Vitest), including that switching back to a
prompt step restores the original text.

## Phase 2b — VS Code lightbulb fix (deferred)

Only do this if people actually write `!` steps by hand in workflow files. Phase 2a already
shows the warning in VS Code.

- No `CodeActionProvider` exists anywhere in ctrlyoke yet, so this is new infrastructure: a
  provider registered for ctrlyoke workflow files that offers a fix for this diagnostic code.
- The fix rewrites the step in place. From
  `{ name, prompt: "! npm run test:ui", harness, model, … }` to
  `{ name, type: script, script: "npm run test:ui" }`. Keep the fields the script schema accepts
  (`name`, `enabled`, `color`, `errorBehavior`, `secrets`, …), and remove prompt-only fields
  (`harness`, `model`, `skills`, `agent`, …). The result must pass schema validation;
  `$defs/scriptStep` requires `type` and `script`.
- It must keep the user's comments and formatting, and work for every workflow file kind
  (YAML, JSON, and the Markdown prompt format, which may not support script steps — if it doesn't,
  offer no fix there). Use the same document-location helpers that `PromptDiagnosticsProvider`
  uses (`WorkflowDocumentLocation`) to find the step's range.

## Phase 3 — Turn-start watchdog for every interactive send

This covers `/config`-style commands, any `!` that still gets through, and dropped Enter
presses, which are why `writeTurnToLivePty` sends Enter twice.

The rule: **the step is interactive, at least 20–30 s have passed since the prompt was
submitted, and neither the per-turn start hook nor the session log has shown anything for this
turn.**

1. After the prompt is submitted (fresh spawn: once the TUI is ready and the prompt is sent;
   reuse: after the submit pulses in `writeTurnToLivePty`), start a **turn-start timer**. Either
   signal cancels it: the Phase 0 per-turn hook, or the first parsed log event for this session
   dated after the submit. A Stop notification also cancels it. A real turn that then runs for
   20 minutes is unaffected.
2. If the timer runs out with no signal of either kind, end the step with a **new terminal
   status**, e.g. `noTurnStarted`. Add the name to `DashboardConstants.ts`, with no bare string
   literals. Show a notice in the output pane naming the likely cause ("the harness handled this
   input itself, e.g. a TUI command like `/config`, so no AI turn started"). It isn't a failure:
   `errorBehavior` and retry loops must not run, end conditions are skipped and noted as skipped,
   and the workflow goes on to the next step.
   - **Compatibility:** the status is stored in `_runtime.terminalStatus`, written to
     `events.jsonl` and run manifests, and included in CLI `--json` output. Follow the
     persisted-state rules in `CLAUDE.md`: bump each affected format's `schemaVersion`, and keep
     reading older files. A new enum value is additive for `--json`, but check that consumers
     with a `switch` over statuses (run summary, history search, status badges, CLI exit-code
     mapping) handle it explicitly instead of falling into a failure default.
   - Give it its own badge and history filter label, built from the same place as the other
     status labels.
3. **Don't reuse that terminal again.** A UI-only command may have left a view open (`/config`).
   The next step's keystrokes would land in it, and what Escape does differs by TUI. Mark the
   live context as not reusable so the next step starts a fresh process with the same session ID
   (the existing `resumeSession` path). Optionally send Escape first as best effort, but don't
   rely on it.
4. Timeout: a per-harness default of roughly 20–30 s, because the turn-start hooks fire within a
   second or two of submit. Add a setting only if a real case needs one. If one is added, it goes
   in `schemas/settings-schema.json` and `CtrlYokeSettings.ts`, not `package.json`.
5. Fresh spawn: the existing SessionStart wait is not enough (a session can start without a
   turn). Run the same turn-start timer after the session-start wait succeeds.
6. Headless runs never start this timer (see **Scope**).

Tests: neither the hook nor the log signals → step ends with the new status, the reuse context is
cleared, and neither retry nor `errorBehavior` runs; only the log signals (hook missing) → normal
completion; only the hook signals → normal completion; a signal arrives late but in time →
normal completion; Stop arrives with no start signal → normal completion; headless → no timer.

## Phase 4 — Slash commands with arguments

Goal: `/run-tests ui` and `/handoff short note` reach the harness verbatim, so the TUI parses the
arguments the way a person typing them would. Long or multi-line text after a command still
goes through the prompt file.

1. **Fix the name match.** Change `extractLeadingSlashCommand`'s `/^(\/\w+)/` to match a whole
   command token, up to the first whitespace. Harness command names use hyphens and
   `plugin:command` namespaces. Keep the existing check that skips ctrlyoke's own `/skill:` and
   `/mcp:` tokens. Put the pattern in one named constant shared with `isPureSlashCommand`. Then
   a bare `/run-tests` is also treated as a bare command.
2. **Send `/command args` verbatim when it's simple enough.** Add a third case alongside "bare"
   and "command plus file". The whole prompt is sent unchanged, with no instruction assembly,
   when all of these hold:
   - it is one line (no newlines);
   - it passes the existing inline check for the current mode (`isSimplePrompt` on spawn,
     `canSendToRunningTerminal` on reuse), so quotes, backslashes and length are handled by
     the rules that already exist, not new ones;
   - the step attaches nothing that would need a file: no prior context, no ctrlyoke reference
     tokens to expand (`@`, `#`, `~`, `$`, `!SECRET`), no agent, no skills and no secrets.
     Otherwise that context would be silently dropped, the way a bare command drops it today.
3. **Otherwise, keep today's form:** `/command follow the instructions in @prompt.1.md`, with
   the full text in the prompt file. Paragraphs, quotes and attached context reach the model
   intact. The trade-off is that the command's argument becomes the instruction line, not the
   user's text. That suits skills (the model reads the file), but a command that parses its
   arguments strictly would get the wrong ones. Note this in the docs. For strict-argument
   commands the user should keep the arguments short and on one line.
4. Docs: a short section on how a leading `/command` is sent in each of the three forms.

Tests: `extractLeadingSlashCommand` on `/run-tests ui`, `/plugin:cmd x` and `/skill:commit`
(still `null`); verbatim pass-through for a simple single line with arguments; the file form
for multi-line text, for a quoted argument that fails the inline check, and for a step with
prior context; a bare `/run-tests` is a bare command.

## Decisions (2026-11-06)

1. **Outcome shape:** a new terminal status (Phase 3), not `completed` with a warning.
2. **Headless mode:** out of scope for the watchdog. The process boundary is the turn boundary
   (see **Scope**).
3. **`/` with arguments:** pass verbatim when simple, otherwise the file form (Phase 4). The
   strict-argument trade-off in Phase 4 step 3 is accepted for now.
4. **Hook disabling:** not a separate risk. Hooks are set inline and can't be switched off, and
   the watchdog requires both the hook and the log stream to stay silent before it acts.
