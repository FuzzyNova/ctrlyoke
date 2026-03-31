---
applyTo: "src/flightpath/harness/chat/**"
---

<purpose>
UI automation-based integration for GitHub Copilot Chat. Serves as fallback when CLI integration is unavailable or unsuitable.
</purpose>

<architecture>
Four classes:
- **CopilotChatIntegration**: UI automation orchestration, model switching, session management, prompt building
- **ChatSessionMonitor**: Session file monitoring for 100% reliable completion detection
- **ChatSessionParser**: Converts session files to UniversalCliOutput format (supports .json and .jsonl)
- **NativeAttachmentHandler**: File attachment via VS Code commands (`#file:`, `#sym:` references)
</architecture>

<keyFeatures>
- Session file monitoring (100% reliable completion detection)
- Structured output with UniversalCliOutput format (events, metadata, tool calls)
- Model switching always happens before sending prompt (consistency with CLI)
- Two prompt-building strategies: native attachments (`chatUseNativeAttachments`) or temp file wrapping (default)
- Agent mode via `forceAgentModeForChat`; agent-specific chat windows via `openAgentSpecificChat`
- Dynamic queue instructions inherited from base class
- VS Code variant support (Code, Code - Insiders, VSCodium) and WSL support
</keyFeatures>

<completionDetection>
**Session File Monitoring (ChatSessionMonitor)**

Monitors VS Code's internal `chatSessions/*.json` and `*.jsonl` files — 100% reliable completion detection.

**Session file locations:**

- Windows: `%APPDATA%\Code\User\workspaceStorage\<hash>\chatSessions\*.json|*.jsonl`
- macOS: `~/Library/Application Support/Code/User/workspaceStorage/<hash>/chatSessions/`
- Linux: `~/.config/Code/User/workspaceStorage/<hash>/chatSessions/`
- WSL: `/mnt/c/Users/<winuser>/AppData/Roaming/Code/User/workspaceStorage/<hash>/chatSessions/`
  (VS Code UI runs on the Windows host; session files land in Windows AppData, not Linux `~/.config`)

**Performance optimization:**

- Session cache persists across ALL workflows (entire VS Code session)
- First prompt: Parse all session files (~100ms one-time cost)
- Subsequent prompts: Only parse NEW/MODIFIED files (~5ms) via mtime-based cache invalidation
- Directory listing cache (2s TTL) avoids re-scanning on every 500ms poll

**Detection algorithm:**

1. **Before send**: `recordPositionBeforeSend()` enumerates session files and caches completed request indices
2. **Submit**: `submitWithRetry()` calls `workbench.action.chat.submit` and verifies via `findSessionFileByPromptText()`
3. **Monitoring**: `waitForCompletion()` polls 500ms intervals; inactivity clock resets on each session file mtime change
4. **Completion**: `isSessionComplete()` — request is complete when `result.timings.totalElapsed > 0`
5. **Cancellation**: Detected via `result.errorDetails.message.includes("cancel")`

**Timeout handling:**

- Inactivity-based (not wall-clock): timer resets on each VS Code write to the session file
- `chatInactivityTimeout` setting (default: 300s)
- `treatChatTimeoutAsSuccess` setting (default: true): when true, timeout is treated as completion
  </completionDetection>

<sessionParser>
**ChatSessionParser** converts session files to UniversalCliOutput.

**File format support:**

- `.json`: Standard JSON, parsed directly
- `.jsonl` (VS Code switched ~Feb 2026): Delta/patch log replayed in order:
  - `kind 0` — base snapshot: `{"kind":0,"v":{...session without result/response...}}`
  - `kind 1` — set: `{"kind":1,"k":["requests",0,"result"],"v":{...}}`
  - `kind 2` — append: `{"kind":2,"k":["requests",0,"response"],"v":[...items...],"i":N}`

**Response extraction:**

```typescript
extractResponse(sessionFilePath: string, requestIndex: number = -1): UniversalCliOutput
```

Default uses last request (-1). Returns typed events array.

**Event types produced:**

- `TEXT` — from response items with no `kind` and a `value` field (code-fence-only items filtered out)
- `THINKING` — from `kind: "thinking"` items (encrypted base64 content silently dropped)
- `TOOL_CALL` — from `kind: "toolInvocationSerialized"` items, arguments populated from `metadata.toolCallRounds`
- `inlineReference` items emitted as backtick text (filename only)
- Structural items (`prepareToolInvocation`, `mcpServersStarting`, `textEditGroup`, `codeblockUri`, `undoStop`) are skipped

**Tool call upgrades** — generic `TOOL_CALL` events are upgraded to specific typed events:

| Canonical name                 | Upgraded event type  |
| ------------------------------ | -------------------- |
| `create_file`                  | `FILE_WRITE`         |
| `replace_string_in_file`       | `FILE_EDIT`          |
| `multi_replace_string_in_file` | Multiple `FILE_EDIT` |
| `run_in_terminal`              | `BASH_COMMAND`       |
| `read_file`                    | `FILE_READ`          |
| `delete_file`                  | `FILE_DELETE`        |

**Copilot tool ID normalization** — maps Copilot Chat display IDs to canonical names before upgrade (e.g. `copilot_createFile` → `create_file`). Falls back to ID-based matching for unknown tools.

**Static helpers (used by ChatSessionMonitor):**

- `ChatSessionParser.parseSessionFile(path)` — parses .json or .jsonl, returns `ChatSessionFile | null`
- `ChatSessionParser.isSessionComplete(path, index?)` — `totalElapsed > 0` check
- `ChatSessionParser.getRequestCount(path)` — returns `session.requests.length`
  </sessionParser>

<uiAutomationTiming>
**Direct Automation Steps (validated timing):**

1. Focus chat window: 1000ms (chatPanel), 1500ms (newTab/newWindow)
2. Clear input: `editor.action.selectAll` + 300ms (PROVEN required)
3. Paste prompt: clipboard write + `editor.action.clipboardPasteAction` + 500ms (PROVEN required)
   - **IMPORTANT**: Do NOT use `type` command for large prompts — it fires per-character input events and deadlocks VS Code for 230KB+ context. Clipboard paste is instant regardless of size.
4. Submit: `submitWithRetry()` — exponential backoff, 60 attempts over ~84s (VS Code can take 45+ seconds to write session files)

**Chat window locations** (configured via `getChatWindowLocation()`):

| Location    | Focus command                             | New session command                     |
| ----------- | ----------------------------------------- | --------------------------------------- |
| `chatPanel` | `workbench.panel.chat.view.copilot.focus` | `workbench.action.chat.newLocalChat`    |
| `newTab`    | `workbench.action.chat.openInEditor`      | `workbench.action.chat.newChat`         |
| `newWindow` | `workbench.action.chat.openInNewWindow`   | `workbench.action.chat.openInNewWindow` |

</uiAutomationTiming>

<promptBuilding>
**Two strategies controlled by `chatUseNativeAttachments` setting:**

**Native attachments (`true`, opt-in):**

- File/symbol references attached via VS Code native commands (`github.copilot.chat.attachFile`, `github.copilot.chat.attachSelection`, `workbench.action.chat.attachFolder`)
- Agent handled by opening agent-specific chat window (`workbench.action.chat.open<FrontmatterName>`)
- Skills NOT supported in this mode
- Raw prompt text is typed into chat input

**Temp file wrapping (`false`, default):**

- Fully expanded prompt (agent instructions + skills + context + user prompt) written to temp `.prompt.md` file(s) in workspace
- Each file attached via `workbench.action.chat.attachFile`
- Short instruction typed into chat: `"Follow instructions in prompt1.md"` (or multiple files)
- Context and prompt written to separate files to prevent Copilot's auto-summarizer from stripping the prompt text (which always appears at the end of context)
- Simple prompts (short, no special chars) bypass temp file I/O — sent inline as fast path
- Temp files cleaned up after each execution (success or failure)
- Split limits: 8000 tokens / 600 lines per file with attachment-boundary awareness
  </promptBuilding>

<nativeAttachments>
**NativeAttachmentHandler** (used when `chatUseNativeAttachments=true`):

- Parses `#file:` and `#sym:` references from prompt via `parseAllFileReferences()`
- Symbol references resolved to file locations via `resolveSymbol()` before attaching
- Directories: `workbench.action.chat.attachFolder`
- Files: open in editor (beside, preview) → `github.copilot.chat.attachFile` → close editor
- Line ranges: open → set selection → `github.copilot.chat.attachSelection` → close editor
- 200ms delay between attachments prevents race conditions
- References kept in prompt text for LLM context
  </nativeAttachments>

<initialization>
Background polling: 5s intervals, 6 attempts max (30s total). First poll passive; second+ attempts activate extensions. Checks that `type`, `workbench.action.chat.submit`, `editor.action.selectAll`, and at least one chat-opening command are available. Session monitor initialized after Copilot ready.
</initialization>

<cancellation>
`isCancelling` flag checked during submit retry and session monitoring loops. Cancellation detected in session file via `errorDetails.message.includes("cancel")`. `lastFailureWasUserCancellation` flag distinguishes user cancels from system failures.
</cancellation>

<differenceFromCli>
**Chat vs. CLI key differences:**

| Aspect              | Chat Mode                           | CLI Mode                                     |
| ------------------- | ----------------------------------- | -------------------------------------------- |
| Completion detect   | Session file monitoring (100%)      | Process exit / streaming                     |
| Response extraction | Session file parsing                | Direct output capture                        |
| Output format       | UniversalCliOutput (structured)     | UniversalCliOutput (structured)              |
| Initialization      | Background polling (5s × 6)         | Sync availability check                      |
| Model switching     | VS Code command                     | Command-line flag                            |
| File attachments    | Native commands or temp file attach | Always inline expansion                      |
| Session management  | UI-based (new chat commands)        | Process lifecycle                            |
| Cancellation        | `isCancelling` flag + session check | Kill process                                 |
| UI visibility       | Always visible in chat UI           | Optional terminal (interactive vs. headless) |
| Harness identifier  | `copilot-chat`                      | `copilot-cli`, `claude-cli`, `codex-cli`     |

</differenceFromCli>

<terminology>
**Harness** (not "provider"): Execution strategy for AI interactions (copilot-chat, copilot-cli, claude-cli, codex-cli). The term "provider" is deprecated throughout the codebase in favor of "harness".
</terminology>
