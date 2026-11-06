# Turn-start signal probes: Copilot, OpenCode, Antigravity

**Date:** 2026-11-06
**Scope:** Phase 0 of `dev/backlog/HARNESS_NATIVE_COMMAND_PROMPTS_PLAN.md`
**CLI versions:** Copilot 1.0.106; OpenCode 2.2.5; Antigravity 1.5.2

## Method

Ran each CLI in a fresh PTY using `node-pty` from ctrlyoke's `node_modules`, with its installed entry point/binary and a fixed 16-second per-case cutoff. Inputs were a plain `Reply with exactly OK.`, `! echo hello`, `/config` (Antigravity also checked `/settings`), and a custom `/probe` skill/command. Each input was sent in a fresh TUI and after a normal turn in a reused TUI. Reused input used the focus pulses and double Enter from `CliExecutionRunner.writeTurnToLivePty`; OpenCode used bracketed paste for prompts that its provider would send inline. The model choices were Copilot `claude-haiku-4.5`, OpenCode `opencode/deepseek-v4.1-flash-free`, and Antigravity `gemini-3.8-flash-low`.

For captures, Copilot used the `.github/hooks` JSON shape produced by `CopilotNotificationMonitor`; OpenCode used a temporary V2 plugin in the `OPENCODE_CONFIG_CONTENT` `plugins` list, matching the provider's inline plugin registration; Antigravity used the `~/.gemini/config/hooks.json` group shape from `AntigravityNotificationMonitor`. Each handler wrote the native event name, local timestamp, and stdin payload to a JSONL file in a scratch workspace outside the repo. The Antigravity hooks file was restored to `{}` after each case. Session exports/transcripts were read after the PTY stopped.

### Results

| Harness | Fresh TUI: normal / `!` / UI command / `/probe` | Reused TUI: target input after normal Stop | Run correlation |
| --- | --- | --- | --- |
| **Copilot** | `userPromptSubmitted` fired for normal and skill `/probe`; silent for `! echo hello` and `/config`. | Same: normal and `/probe` fired; `!` and `/config` did not. | Hook artifact is `{runId}-hook-{timestamp}-{pid}.json`; payload includes `sessionId`. Session log is `.copilot/session-state/{sessionId}/events.jsonl`, with the same session ID reused. |
| **OpenCode** | V2 `session.execution.started` fired for normal and custom `/probe` (translated to `session.status.busy` by ctrlyoke's plugin); silent for the native `!` shell command and `/config`. | Same: normal and `/probe` fired; `!` and `/config` did not. | Plugin hook artifact is run-scoped (`{runId}-hook-…json`) and carries `sessionID`. Reused turns keep that session ID. |
| **Antigravity** | `PreInvocation` fired for normal and skill `/probe`; silent for raw-TUI `!` and `/config`. A normal turn had one `PreInvocation`. | Same: normal and `/probe` added a `PreInvocation`; `!` and `/config` did not. | Hook artifact is run-scoped (`{runId}-hook-{timestamp}-{pid}.json`) and carries `conversationId`; transcript is under `.gemini/antigravity-cli/brain/{conversationId}/…/transcript_full.jsonl`. |

The three Phase 0 questions therefore resolve as follows:

1. **Skill-backed slash command:** yes for all three. Copilot `/probe` expanded the `.github/skills/probe/SKILL.md` skill; OpenCode `/probe` expanded a project command in `.opencode/commands/probe.md`; Antigravity `/probe` used `.agents/skills/probe/SKILL.md`. Each produced its candidate start signal in both fresh and reused turns.
2. **Native shell escape and UI-only slash command:** the candidate stayed silent for both in fresh and reused TUIs. OpenCode's `!` shell path emitted shell lifecycle records (described below), but no busy/start event. Copilot `/config` opened its configuration UI. Antigravity `/config` ran its local `agy config list` command and did not start a model turn; `/settings` was also silent when typed into the reused TUI.
3. **Isolation:** each harness can write the hook candidate to a run-scoped file. Copilot and Antigravity also put the session/conversation ID in the payload; OpenCode's plugin event includes `sessionID`. Their session log sources remain scoped to the same session/conversation when the TUI is reused.

## Session-log findings

### Copilot

The hook payloads for a normal prompt included `sessionId`, `timestamp`, `cwd`, and `prompt`; the skill case included the expanded skill context. The project skill produced `skill.invoked` in the Copilot `events.jsonl` session log. In reused `!` and `/config` cases, the log contained the initial normal turn but no second `user.message` or model/tool event for the target input. A fresh native `!` ran `echo hello` in the TUI without `userPromptSubmitted`; `/config` opened the configuration view without a submit event.

The probe explicitly registered `userPromptSubmitted` alongside the normal session-start and stop hooks so the proposed candidate could be observed. Its native name is `userPromptSubmitted`; ctrlyoke's logical mapping is `userPromptSubmit` in `CopilotNotificationMonitor.EVENT_MAP`.

### OpenCode

For normal prompts and `/probe`, the V2 plugin captured `session.execution.started` followed by `session.execution.succeeded`; the `/probe` inbox text was the expanded command template. Native `! echo hello` produced `shell.created`, `session.shell.started`, `shell.exited`, and `session.shell.ended`, and its session export contained one `{ "type": "shell", "command": " echo hello", … }` message. It produced no `session.execution.started`. `OpenCodeLogParser.extractNewEventsFromExport` does not map the V2 shell message to a parser event. `/config` produced no session execution or exported user message, so there is no parser event to ignore.

**Mid-prompt `!` and Phase 1 check:** in the reused OpenCode PTY, the prompt `Thanks for the help! It worked.` was sent with the provider's bracketed-paste wrapper, focus pulses, and two Enter pulses. The session inbox recorded that full text, followed by `session.execution.started` and `session.execution.succeeded`; no shell lifecycle event appeared. Phase 1's paste fix holds on OpenCode 2.2.5.

One launch-path difference matters: OpenCode's `--prompt` startup option does not exercise the TUI's `!` key binding the same way as typing into the fresh TUI. The fresh-turn shell probe therefore started OpenCode with no prompt and typed `! echo hello` into its composer.

### Antigravity

`PreInvocation` payloads contained `conversationId`, `invocationNum`, `lastUserInput`, `modelName`, `transcriptPath`, and `workspacePaths`. A normal prompt and `/probe` each produced a single start invocation before Stop in the typed-TUI cases. The native `!` escape and `/config` UI command did not produce `PreInvocation` and left no transcript turn for the parser. The `/probe` transcript contained `USER_INPUT` and planner entries; ordinary model tool work is represented by `transcript.tool` events in `AntigravityLogParser`.

`PreInvocation` is per model invocation, not a durable once-per-user-turn marker: when `/config` or `! echo hello` was passed as `--prompt-interactive` text instead of typed as a native TUI command, the model processed it and emitted repeated `PreInvocation` events (six for `/config`, two for `!`). This is a launch-path artifact: use raw TUI input to probe native slash/shell commands. The `--prompt-interactive` form of `/config` produced an AI transcript, unlike the native `/config` command.

## Harness-specific signal assessment

- **Copilot:** `userPromptSubmitted` is a good per-turn start candidate. It fires for normal and skill turns, stays silent for native shell/UI commands, has the session ID, and ctrlyoke's hook artifact writer can give it a run-scoped filename.
- **OpenCode:** `session.status.busy` is a good candidate. OpenCode 2.2.5 exposes the corresponding V2 `session.execution.started`; it fires on normal/skill turns, not on shell lifecycle or UI-only commands. The plugin's run ID and session ID cover workflow isolation and reused sessions.
- **Antigravity:** `PreInvocation` is useful as a turn-start candidate for actual model turns and remains silent for native shell/UI commands. Treat it as an invocation signal: an agent turn with multiple model invocations can emit it more than once. The session log remains the complementary signal, and the event payload has the conversation ID and transcript path.

## Surprises and limits

- Copilot `/probe` was initially unknown until the test skill was installed in `.github/skills/probe/SKILL.md`; the valid skill invocation then produced the expected hook and log events.
- Antigravity's native `/config` maps to a local `agy config list` command on 1.5.2; it is silent to `PreInvocation` when typed into the TUI even though the command's local output/error is visible there.
- The tests used short, low-cost prompts and a fixed cutoff. Cases that produced a candidate event were stopped after the signal was captured; the probes were for turn-start behavior, not response-quality or long-running-turn behavior.
