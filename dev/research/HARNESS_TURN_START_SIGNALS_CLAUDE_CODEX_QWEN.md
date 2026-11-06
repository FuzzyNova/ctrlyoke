# Phase 0: Claude, Codex, and Qwen turn-start signals

Probed 2026-11-06 on Windows with the interactive CLIs and cheap models. No files under `src/` were changed. PTYs ran with a fixed 40-second kill timeout. Hook commands used provider-shaped registration and appended the received native event name, timestamp, and JSON payload to a scratch capture.

Versions: Claude Code 2.1.319 (`haiku`), Codex CLI 0.166.0 (`gpt-5.6-luna`), and Qwen Code 0.26.9 (`qwen3.7-flash`). Codex and Qwen were spawned through their npm-installed JS entries with `node-pty` from ctrlyoke's `node_modules`; Claude is installed as a native `claude.exe`, so that executable was spawned directly. `TERM=xterm-256color` was set for Codex. Qwen's prompt to approve the scratch project's hooks was accepted.

For first-turn command checks, I also started a clean TUI with no initial prompt and typed `!`, the UI command, or `/init` into it. This matters: a command passed as the launch-time positional prompt is not always handled like the same text typed into the TUI. Reused checks sent a warmup prompt, waited for its Stop hook, then sent the test input to that same PTY with the focus pulses, 256-character chunks, and two Enter pulses from `CliExecutionRunner.writeTurnToLivePty`.

## Results

The candidate in each row is the native `UserPromptSubmit` hook. “First typed” means the TUI started without a prompt and the test input was the first text typed into it.

| Harness | Normal first / reused | `! echo hello` first typed / reused | UI-only command first typed / reused | Prompt-backed slash first / reused |
| --- | --- | --- | --- | --- |
| `claude-cli` | Fires once on both | Silent on both; Claude nevertheless emits `Stop` for the shell escape | `/config`: silent on both | `/init`: fires on both; Stop also arrived on both |
| `codex-cli` | Fires once on both | Silent on both | `/permissions`: silent on both | `/init`: fires on both; reused `/init` did not reach Stop before the 40-second kill |
| `qwen-cli` | Fires once on both | Silent on both when typed into the TUI | `/settings`: silent on both | `/init`: fires on both; several hook invocations occurred during the command's multi-step work |

### Answers to the Phase 0 questions

1. **Skill/prompt-backed slash command:** Yes. `/init` produced `UserPromptSubmit` for each harness on both first use and reuse. Claude's `/init` also completed with Stop in both cases. Codex's reused `/init` emitted the start hook but was still working when the fixed timeout killed it. Qwen's `/init` completed and emitted multiple `UserPromptSubmit` hooks while it worked through its prompt and tool calls (two on first use and five after the reused warmup).

2. **Shell escape and UI-only slash command:** The candidate `UserPromptSubmit` stayed silent for fresh typed and reused `! echo hello` and the selected UI commands. Claude also fired a Stop hook for `!`; Stop is not a reliable discriminator for “an AI turn began.” The UI commands left no parsed turn event in the session logs. See the parser-specific notes below.

3. **Run scoping:** Yes, in ctrlyoke's actual launch environment. Each provider receives `CTRLYOKE_RUN_ID`; `ctrlyoke-hook-utils.js` uses it for the `UserPromptSubmit` artifact name, and `HookEventMonitor` polls only `{runId}-hook-*.json`. The artifact path is:

   ```text
   <workspace>/.ctrlyoke/temp/<harness>-notifications/<runId>-hook-<timestamp>-<pid>.json
   ```

   The artifact carries `hookEvent: "userPromptSubmit"`, `nativeHookEvent: "UserPromptSubmit"`, `sessionId`, and the raw payload. Session-start and stop notifications use separate files: `{runId}-start.json` when the run ID is present, and `{sessionId}-stop.json`. The session logs themselves are session-scoped, not run-scoped; the hook artifact is the parallel-workflow-safe signal.

## Session logs and parser behavior

Session logs were read after the captures. Their location patterns were:

- Claude: `~/.claude/projects/<workspace-slug>/<sessionId>.jsonl` (`transcript_path` in hook input).
- Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<sessionId>.jsonl` (`transcript_path` in hook input).
- Qwen: `~/.qwen/projects/<workspace-slug>/chats/<sessionId>.jsonl` (`transcript_path` in hook input).

**Claude.** The typed shell escape was recorded in the transcript as `user` messages containing `<bash-input> echo hello</bash-input>` and `<bash-stdout>hello</bash-stdout>…`, followed by Claude's explanation. These records have no tool-result block or `isMeta: true`; `ClaudeLogParser.classifyUserEvent` therefore classifies them as `human-steer`. A log-based start check must not treat these shell records as evidence that an AI turn began. `/config` left only the warmup user/assistant records and no command record for the parser. `/init` logged its command message, prompt body, and model/tool activity.

The launch-time positional `! echo hello` behaved differently from typed input: Claude treated it as a model prompt, emitted `UserPromptSubmit`, and then used PowerShell to run `echo hello`. That is not the TUI shell escape case; use the typed/reused result above when evaluating native command behavior.

**Codex.** Native `! echo hello` runs as a Codex TUI shell command. Its rollout contained an `event_msg:item_completed` `CommandExecution` with `source: "user_shell"` and a `response_item:role=user` shell-result message with `content_item_kinds: ["shell.user_command"]`. `CodexLogParser.classifyUserEvent` only accepts `event_msg:user_message`, so those shell records do not become parsed user-steer events. `/permissions` opened the permission selector and produced no user-message event. `/init` produced a real user-message event and model/tool log activity.

Passing `/permissions` as Codex's launch-time prompt did fire `UserPromptSubmit`; the fresh-TUI typed probe and the reused probe did not. As with `!`, launch-time positional input is not interchangeable with typing a native command into the TUI.

**Qwen.** `/settings` appears in the transcript as `system` records with `subtype: "slash_command"`; `QwenLogParser.classifyUserEvent` ignores those because it only classifies `type: "user"` records. The reused `!` produced no additional user/assistant transcript entry beyond the warmup. `/init` produced slash-command records followed by real user/assistant/tool-result records, and the hook fired again for internal submissions during the command's work. The first-turn launch-time `-i "! echo hello"` emitted `UserPromptSubmit`; typed-first and reused shell escapes stayed silent.

## Hook wiring and files

The probe mirrored each provider's interactive hook configuration:

- **Claude:** `--settings` JSON with `SessionStart`, `UserPromptSubmit`, and `Stop` command hooks. The monitor maps `userPromptSubmit` to native `UserPromptSubmit`. A fast ordinary turn produced `SessionStart`, `UserPromptSubmit`, and `Stop`; the TUI-native `/config` case produced only `SessionStart`.
- **Codex:** `--enable hooks`, inline `-c hooks.<Event>=...` overrides, and the trusted hash state generated by `CodexInlineHooksBuilder`. A normal turn produced `SessionStart`, `UserPromptSubmit`, and `Stop`. A fresh TUI with no submitted prompt did not emit `SessionStart` in this installed build; the typed native `!` and `/permissions` cases emitted no hook event.
- **Qwen:** project `.qwen/settings.json` entries for `SessionStart`, `UserPromptSubmit`, and `Stop`, approved in the TUI as Qwen requires for project hooks. Fast normal turns emitted `UserPromptSubmit` and `Stop`, but no `SessionStart`, matching `QwenNotificationMonitor`'s comment that `SessionStart` can be fire-and-forget. `/settings` emitted no hook event.

Scratch scripts, hook captures, and PTY transcripts are under `C:\Users\natha\AppData\Local\Temp\ctrlyoke-native-command-probe\`; none were added to the repository.
