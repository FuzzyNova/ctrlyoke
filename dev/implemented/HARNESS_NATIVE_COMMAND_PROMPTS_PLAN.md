# Harness-Native Command Prompts Plan (`!` shell escapes and `/` TUI commands)

**Status:** Implemented (2026-11-06). Phases 0, 1, 2a, 3 and 4 are complete. Phase 2b remains deferred. The watchdog covers all six interactive harnesses; headless execution is unchanged.

Note for Phase 1: `HarnessIntegration.SAFE_CHARS_PATTERN` deliberately allows `!`, so today
`! echo hello` passes `isSimplePrompt` and is sent inline on spawn too, not only on reuse. The
new predicate must be checked before that pattern, and `!` stays allowed mid-prompt for every
harness except OpenCode on reuse.

Note for Phase 4: the verbatim `/command args` form reuses the mode's inline check, so it
inherits the Phase 1 OpenCode rule (`/cmd done!` on a reused OpenCode terminal takes the file
form). Phase 4 must not bypass that check.

Last reviewed against code: 2026-11-06. Authored workflow fields are unchanged. The new runtime
step status is persisted run data (see Phase 3). The editor diagnostic and the new status are user-visible,
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
  spawn. Even there it is a _session_ start. A session can start (SessionStart fires) while the
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

The watchdog in Phase 3 needs a turn-start event, including in a reused terminal. Phase 0
probed the existing notification-monitor candidates in fresh and reused interactive TUIs with a
normal prompt, `! echo hello`, `/config` or its harness equivalent, and a skill-backed slash
command. The confirmed signals and parser exclusions are below.

**Confirmed signals and parser exclusions (probed 2026-11-06):**

| Harness | Confirmed turn-start signal | Native shell / UI-only log handling |
| --- | --- | --- |
| `claude-cli` | `UserPromptSubmit` hook, once on normal first and reused turns; `/init` also fires it. | Ignore user transcript records containing `<bash-input>` / `<bash-stdout>`: Claude's parser labels these as human steers. `/config` has no parser event. |
| `codex-cli` | `UserPromptSubmit` hook; normal and `/init` fire it on first and reused turns. | Ignore `CommandExecution` events with `source: "user_shell"` and `response_item` user messages with `content_item_kinds: ["shell.user_command"]`; parser currently accepts only `event_msg:user_message`. `/permissions` has no user-message event. |
| `qwen-cli` | `UserPromptSubmit` hook; normal and `/init` fire it on first and reused turns (multi-step `/init` may fire multiple times). | Ignore `system` transcript records with `subtype: "slash_command"`; parser accepts only `type: "user"`. Typed `!` adds no user/assistant transcript event. |
| `copilot-cli` | `userPromptSubmitted` hook, normal and skill-backed `/probe` on first and reused turns. | Typed `!` and `/config` add no second `user.message` or model/tool event. |
| `opencode-cli` | V2 `session.execution.started` (mapped by ctrlyoke to `session.status.busy`), normal and `/probe` on first and reused turns. | Ignore `shell.created`, `session.shell.started`, `shell.exited`, and `session.shell.ended`; exported `type: "shell"` messages are not parser events. `/config` adds no execution or user event. |
| `antigravity-cli` | `PreInvocation`, normal and `/probe` on first and reused turns. It is per model invocation and can fire more than once in an agent turn. | Typed `!`, `/config`, and `/settings` do not add transcript turns or parser events. |

All six signals are run-correlated through `{runId}-hook-…` artifacts (OpenCode plugin artifacts included); session/conversation IDs remain stable on reuse. Claude's `Stop` also fires for typed `!`, so Stop is not evidence that an AI turn began. Launch-time positional prompts can behave differently from native commands typed into a fresh TUI and are not used to evaluate command silence.

Phase 3's log check must count only parsed turn events newer than the submit timestamp and ignore the shell/UI record types listed above. The session log is complementary to the per-turn hook, not a substitute for a signal on any harness.

**Phase 0 complete.** Full methods, versions, hook payloads, and session-log captures are recorded in `dev/research/HARNESS_TURN_START_SIGNALS_CLAUDE_CODEX_QWEN.md` and `dev/research/HARNESS_TURN_START_SIGNALS_COPILOT_OPENCODE_ANTIGRAVITY.md`.

Phase 0 questions and answers:

1. Does the signal fire for a skill-backed slash command (it should, since that is a real turn)?
2. Does it stay silent for `!` and for UI-only slash commands (it must, or the watchdog can never
   trigger)?
3. Is it written to a run-scoped file (`{runId}-…json`) so parallel workflows can't see each
   other's turns? If not, does the session ID scoping hold up in reuse mode?

The session log is the second signal for every harness, not only a fallback for one that lacks a
hook. During a turn, `CliLogMonitor` already streams the session log for this session ID (the
path is in `lastInteractiveContext.logPath`). Any parsed turn event dated after the submit shows
that a turn started. The per-harness shell/UI parser exclusions above are part of the Phase 3
log check; raw shell lifecycle records and native slash-command records do not count as turn starts.

Note on what exists today: the start wait that has a timeout
(`NotificationMonitorBase`, `{runId}-start.json`) runs only on a fresh spawn and waits for a
_session_ start. The log-file fallbacks in the log parsers find the session ID and log file;
they don't detect the start of a turn. So when a terminal is reused, nothing currently detects
"this turn started". Phase 3 adds that, built from the hook plus the log stream described above.

Users can't switch off ctrlyoke's hooks. ctrlyoke passes them to the harness inline at launch,
and the Stop hook that every interactive prompt already depends on is configured the same way.
A harness-level kill switch (Claude's own `disableAllHooks`, say) would already break completion
for every prompt. Phase 3 doesn't need its own guard for that.

## Phase 1 — Never type a `!` that the harness would treat as a shell escape

- [x] Add one shared predicate in `src/utils/`, e.g. `isHarnessShellEscape(promptText)`, which is
   true when the trimmed text starts with `!`. Make the `!` a named constant, not a repeated
   literal.
- [x] In `HarnessIntegration.isSimplePrompt` and `canSendToRunningTerminal`, return `false` when the
   predicate matches. The prompt then always goes through the prompt-file path, and the TUI sees
   only "follow the instructions in @prompt.1.md". The step is an ordinary AI turn: hooks fire,
   it completes, and if the model runs `echo hello` the output appears as a normal tool call.
- [x] **OpenCode mid-prompt `!`:** the OpenCode provider rejects terminal reuse whenever the
   text contains `!`. OpenCode 2.2.5's interactive PTY enabled bracketed paste (`?2004h`). A
   70-repeat prompt sent inside `\x1b[200~` / `\x1b[201~` appeared in the composer as its full
   text and was submitted; no `[pasted text]` placeholder appeared. Reused OpenCode prompts now
   use a provider hook from `writeTurnToLivePty` for this wrapping.
- [x] Check the instruction line itself: no generated categorized instruction
   (`CliIntegration.formatCategorizedInstruction`) may contain a `!`. A workspace path containing
   `!` could put one there. Either quote it or take the file path.

- [x] Tests (`src/test/unit/`): the predicate; `isSimplePrompt` and `canSendToRunningTerminal` reject a
  leading `!`; the OpenCode provider rejects a mid-prompt `!`; `CliPromptPreparer` produces a
  file-based plan for `! echo hello` in both spawn and reuse modes.

## Phase 2a — Lint rule and dashboard fix for a leading `!`

- [x] Warn on a leading `!` in prompt text, underlining only the prefix; script steps are not warned.
- [x] Add dashboard actions to convert to a script step or remove `!` and following whitespace.
- [x] Document the behavior and add extension and dashboard tests, including switch-back restoration.

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

1. [x] After the prompt is submitted (fresh spawn: once the TUI is ready and the prompt is sent;
   reuse: after the submit pulses in `writeTurnToLivePty`), start a **turn-start timer**. Either
   signal cancels it: the Phase 0 per-turn hook, or the first parsed log event for this session
   dated after the submit. A Stop notification also cancels it. A real turn that then runs for
   20 minutes is unaffected.
2. [x] If the timer runs out with no signal of either kind, end the step with a **new terminal
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
   - [x] Add its badge and shared history/status label. Runtime status is included in run files,
     timeline events, manifests, and CLI `--json`; run-file and timeline schema versions are
     incremented, with read migrations, while prior versions remain readable.
3. [x] **Don't reuse that terminal again.** A UI-only command may have left a view open (`/config`).
   The next step's keystrokes would land in it, and what Escape does differs by TUI. Mark the
   live context as not reusable so the next step starts a fresh process with the same session ID
   (the existing `resumeSession` path). Optionally send Escape first as best effort, but don't
   rely on it.
   - [x] Expose the no-turn completion entry point and mark the live interactive context as
     non-reusable while retaining its session ID for the next `resumeSession` spawn.
4. [x] Timeout: a per-harness default of 25 s, because the turn-start hooks fire within a
   second or two of submit. Add a setting only if a real case needs one. If one is added, it goes
   in `schemas/settings-schema.json` and `CtrlYokeSettings.ts`, not `package.json`.
5. [x] Fresh spawn: the existing SessionStart wait is not enough (a session can start without a
   turn). Run the same turn-start timer after the session-start wait succeeds.
6. [x] Headless runs never start this timer (see **Scope**).

Tests: [x] neither signal → new status, reuse context cleared, no retry/errorBehavior;
[x] log-only → normal completion; [x] hook-only → normal completion;
[x] late-but-in-time signal → normal completion; [x] Stop without start → normal completion;
[x] headless → no timer.

**Phase 3 complete (2026-11-06):** status, executor outcome handling, skipped end-condition
record, output notice, persistence projections, CLI/dashboard labels, terminal reuse invalidation,
per-turn hook/log arbitration, and the per-harness watchdog are implemented. Reused TUI hooks read a
mutable run/prompt context file so their artifacts stay scoped to the current submission.

## Phase 4 — Slash commands with arguments

Goal: `/run-tests ui` and `/handoff short note` reach the harness verbatim, so the TUI parses the
arguments the way a person typing them would. Long or multi-line text after a command still
goes through the prompt file.

- [x] **Fix the name match.** Change `extractLeadingSlashCommand`'s `/^(\/\w+)/` to match a whole
   command token, up to the first whitespace. Harness command names use hyphens and
   `plugin:command` namespaces. Keep the existing check that skips ctrlyoke's own `/skill:` and
   `/mcp:` tokens. Put the pattern in one named constant shared with `isPureSlashCommand`. Then
   a bare `/run-tests` is also treated as a bare command.
- [x] **Send `/command args` verbatim when it's simple enough.** Add a third case alongside "bare"
   and "command plus file". The whole prompt is sent unchanged, with no instruction assembly,
   when all of these hold:
   - it is one line (no newlines);
   - it passes the existing inline check for the current mode (`isSimplePrompt` on spawn,
     `canSendToRunningTerminal` on reuse), so quotes, backslashes and length are handled by
     the rules that already exist, not new ones;
   - the step attaches nothing that would need a file: no prior context, no ctrlyoke reference
     tokens to expand (`@`, `#`, `~`, `$`, `!SECRET`), no agent, no skills and no secrets.
     Otherwise that context would be silently dropped, the way a bare command drops it today.
- [x] **Otherwise, keep today's form:** `/command follow the instructions in @prompt.1.md`, with
   the full text in the prompt file. Paragraphs, quotes and attached context reach the model
   intact. The trade-off is that the command's argument becomes the instruction line, not the
   user's text. That suits skills (the model reads the file), but a command that parses its
   arguments strictly would get the wrong ones. Note this in the docs. For strict-argument
   commands the user should keep the arguments short and on one line.
- [x] Docs: a short section on how a leading `/command` is sent in each of the three forms.

- [x] Tests: `extractLeadingSlashCommand` on `/run-tests ui`, `/plugin:cmd x` and `/skill:commit`
(still `null`); verbatim pass-through for a simple single line with arguments; the file form
for multi-line text, for a quoted argument that fails the inline check, and for a step with
prior context; a bare `/run-tests` is a bare command.
- [x] Changelog: document whole hyphenated/namespaced names and verbatim simple arguments.

## Decisions (2026-11-06)

1. **Outcome shape:** a new terminal status (Phase 3), not `completed` with a warning.
2. **Headless mode:** out of scope for the watchdog. The process boundary is the turn boundary
   (see **Scope**).
3. **`/` with arguments:** pass verbatim when simple, otherwise the file form (Phase 4). The
   strict-argument trade-off in Phase 4 step 3 is accepted for now.
4. **Hook disabling:** not a separate risk. Hooks are set inline and can't be switched off, and
   the watchdog requires both the hook and the log stream to stay silent before it acts.
