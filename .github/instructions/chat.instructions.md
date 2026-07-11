---
applyTo: "src/core/harness/chat/**"
---

<purpose>
UI-driven Copilot Chat harness. It automates the VS Code chat UI, then treats chat session files as the source of truth for submission, completion, and structured output.
</purpose>

<architecture>
- `CopilotChatIntegration` owns UI automation, model switching, prompt assembly, temp/hook cleanup, and the settings-driven split between native attachments and categorized temp files.
- `ChatSessionMonitor` owns session discovery and completion detection. Its before-send snapshot of completed request indices is what prevents duplicate prompt text or resumed old chats from matching stale requests.
- `ChatSessionParser` is the single parser for both `.json` and `.jsonl` chat sessions and the single completion predicate; keep monitor logic delegated to it. Completion/cancellation is decided by `request.modelState.value` (mirrors VS Code's internal `ResponseModelState`: Complete/Cancelled/Failed are all terminal) when present, falling back to the legacy `result.timings.totalElapsed > 0` check for older flat `.json` sessions that predate `modelState`.
- A terminal `modelState` does not always mean the turn is truly finished: if a request ended its turn right after launching an async background tool call (`run_in_terminal` with `mode: "async"`), VS Code auto-resumes the same session with a new top-level `requests[]` entry (`isSystemInitiated: true`) once that task completes — never a continuation of the same request. `ChatSessionParser.hasPendingBackgroundWork(request)` detects this (checks the *last* tool-call round only) and `ChatSessionMonitor.isLastRequestComplete()` reports `complete: false` while it holds, so `waitForCompletion()`'s normal polling — and its existing session-file inactivity timeout — doubles as the in-flight wait/backstop; no separate watcher is needed for *that* part. See `dev/backlog/TERMINAL_FOLLOWUP_TRACKING_PLAN.md` ("Copilot Chat" section) for the full investigation.
- `NativeAttachmentHandler` only handles native `@path` / `#selection:` / `#sym:` attachment commands. Keep broader prompt-section and prior-context assembly in `CopilotChatIntegration` / `HarnessIntegration`.
- `ChatSessionParser.collectFollowUpActivity(sessionFilePath, fromResponseIndexExclusive, steerSeenThroughIndex)` is the single shared walk for everything *after* a request's own dispatched index: it classifies each new request as a genuine human steer (no `isSystemInitiated`) vs. a harness auto-resume, and extracts every already-complete request's content in order. A request's own `hasPendingBackgroundWork` does **not** gate extracting *that request's* content — it only ever means "expect a further request," never "this one isn't readable yet." Two independent cursors (`lastResponseIndex`, `steerSeenThroughIndex`) exist so a steer already surfaced isn't re-emitted once its later-completing response is finally extracted.
- Two call sites share that one walk: `CopilotChatIntegration.extractSessionOutput()` (in-flight — walks from `ChatSessionMonitor.getSendStartRequestCount()`, a stable pre-submit baseline, through the end, so a step that holds through a background-task resume captures the launch request's own text too, not just the resume's final answer) and `ChatSessionActivityWatcher` (post-completion — Chat's poll-based equivalent of the CLI harnesses' `SessionActivityWatcher`, since Chat has no raw log to tail).
- `ChatSessionActivityWatcher` only runs across workflow runs because `CopilotChatIntegration` overrides `HarnessIntegration.shouldPersistForSessionActivity()` to `true`. Chat has no PTY, so `canReuseForInject()` (CLI-specific) always returns false — without this second, separately-named hook, `WorkflowInstance` would dispose the integration (and kill the watcher) the instant a run ends, defeating "post-completion" entirely. It reuses the exact same `liveInjectIntegrations` keep-alive/dispose lifecycle already in place for CLI harnesses.
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
- JSONL replay must not assume the log starts with a `kind:0` Initial entry. VS Code trims persisted sessions (`ChatSessionStore.trimEntries`, cap 50) by deleting the backing file; a still-live in-memory `ChatModel` that writes again has no on-disk baseline to diff against and recreates the file starting directly with Set/Push entries. A real (often complete) session with no Initial line is common under ctrlyoke's session churn — treating it as unparseable silently drops completed responses and was the root cause of "prompt not found in session files" failures. Replay always starts from an empty base state instead of requiring line 0 to be kind 0.
- Output extraction upgrades generic tool calls into shared `UniversalCliOutput` event types. Preserve the normalization layer between Copilot display IDs and canonical snake_case tool names.
- `CliOutputFormatter.toPlainText()` is the final text surface for chat responses; `lastParsedOutput` is the structured payload consumed by the executor.
</parserContracts>

<entryPoints>
- `CopilotChatIntegration.ts`
- `ChatSessionMonitor.ts`
- `ChatSessionParser.ts`
- `ChatSessionActivityWatcher.ts`
- `NativeAttachmentHandler.ts`
</entryPoints>
