---
applyTo: "src/flightpath/harness/chat/**"
---

<purpose>
UI-driven Copilot Chat harness. It automates the VS Code chat UI, then treats chat session files as the source of truth for submission, completion, and structured output.
</purpose>

<architecture>
- `CopilotChatIntegration` owns UI automation, model switching, prompt assembly, temp/hook cleanup, and the settings-driven split between native attachments and categorized temp files.
- `ChatSessionMonitor` owns session discovery and completion detection. Its before-send snapshot of completed request indices is what prevents duplicate prompt text or resumed old chats from matching stale requests.
- `ChatSessionParser` is the single parser for both `.json` and `.jsonl` chat sessions and the single completion predicate (`result.timings.totalElapsed > 0`); keep monitor logic delegated to it.
- `NativeAttachmentHandler` only handles native `@path` / `#selection:` / `#sym:` attachment commands. Keep broader prompt-section and prior-context assembly in `CopilotChatIntegration` / `HarnessIntegration`.
</architecture>

<submissionAndDetection>
- Always call `recordPositionBeforeSend()` before submit, then verify the send by searching session files for the prompt text. That snapshot is the reason resumed sessions and repeated prompts work reliably.
- Completion is inactivity-based on session-file mtime, not wall-clock. `chatInactivityTimeout` controls the idle window; `treatChatTimeoutAsSuccess` decides whether an idle timeout is still considered success.
- Session-file lookup must keep VS Code variant and WSL handling intact. In WSL, the files still live under the Windows host AppData path because the UI process writes them there.
- `sessionFilePath` is per active conversation, but the session-cache and directory-cache intentionally persist for the whole VS Code session for performance.
</submissionAndDetection>

<promptBuilding>
- Default path (`chatUseNativeAttachments = false`) mirrors CLI behavior: build prompt sections, optionally omit agents/skills on resumed sessions, serialize prior context, write typed temp files, attach them, then send a short “follow instructions in …” stub.
- In that non-native path, direct `@file` refs are attached as real workspace files; only agent, skills, prior context, excerpt blocks, and prompt text become typed temp files.
- Native attachments are narrower: resolve `@path`, `#selection:`, and `#sym:` into VS Code attach commands, open agent-specific chat windows when possible, and attach skills via temp file. Workflow prior-context assembly and the “omit agents/skills on resume” behavior currently live only in the non-native categorized-file path.
- Keep the simple-prompt fast path conservative. Large or syntax-heavy prompts should fall back to the file-based path to avoid Copilot auto-summarizing attachments or hanging on large inline input.
</promptBuilding>

<automation>
- Paste through the clipboard plus `editor.action.clipboardPasteAction`; do not switch large prompts back to the `type` command.
- The small focus/select/paste/attach delays are empirical stability requirements, especially for `newTab` and `newWindow`.
- `forceAgentModeForChat` only applies on the non-native path. Native attachments prefer agent-specific chat commands and should not be overridden by the generic agent-mode toggle.
- User hooks are still written to `.github/hooks`, but chat completion remains session-file-driven. Do not add notification-file completion logic here.
</automation>

<parserContracts>
- Keep JSONL replay support in `ChatSessionParser`; VS Code no longer guarantees monolithic `.json` session files.
- Output extraction upgrades generic tool calls into shared `UniversalCliOutput` event types. Preserve the normalization layer between Copilot display IDs and canonical snake_case tool names.
- `CliOutputFormatter.toPlainText()` is the final text surface for chat responses; `lastParsedOutput` is the structured payload consumed by the executor.
</parserContracts>

<entryPoints>
- `CopilotChatIntegration.ts`
- `ChatSessionMonitor.ts`
- `ChatSessionParser.ts`
- `NativeAttachmentHandler.ts`
</entryPoints>
