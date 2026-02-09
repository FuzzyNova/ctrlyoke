---
applyTo: "src/flightpath/chat/**"
---

<purpose>
UI automation-based integration for GitHub Copilot Chat. Serves as fallback when CLI integration is unavailable or unsuitable.
</purpose>

<architecture>
Five classes:
- **CopilotChatIntegration**: UI automation orchestration, model switching, session management
- **ChatSessionMonitor**: Session file monitoring for 100% reliable completion detection
- **ChatSessionParser**: Converts session files to UniversalCliOutput format
- **ChatLogMonitor**: Log-based completion detection (legacy fallback)
- **NativeAttachmentHandler**: File attachment via VS Code commands (`#file:`, `#sym:` references)
</architecture>

<keyFeatures>
- Session file monitoring (100% reliable completion detection)
- Structured output with UniversalCliOutput format (events, metadata, tool calls)
- Model switching always happens before sending prompt (consistency with CLI)
- Native attachments via `chatUseNativeAttachments` setting
- Agent mode via `forceAgentModeForChat`
- Dynamic queue instructions inherited from base class
- VS Code variant support (Code, Code - Insiders, VSCodium)
</keyFeatures>

<completionDetection>
**Primary: Session File Monitoring (ChatSessionMonitor)**

Monitors VS Code's internal `chatSessions/*.json` files - 100% reliable completion detection.

**Session file locations:**

- Windows: `%APPDATA%\Code\User\workspaceStorage\<hash>\chatSessions\*.json`
- macOS: `~/Library/Application Support/Code/User/workspaceStorage/<hash>/chatSessions/*.json`
- Linux: `~/.config/Code/User/workspaceStorage/<hash>/chatSessions/*.json`

**Performance optimization:**

- Session cache persists across ALL workflows (entire VS Code session)
- First prompt: Parse all ~100 files (~100ms one-time cost)
- Subsequent prompts: Only parse NEW/MODIFIED files (~5ms)
- Cache automatically cleared on VS Code restart

**Detection algorithm:**

1. **Before send**: Enumerate existing session files and cache completed request indices
2. **Monitoring**: Poll for NEW session files or modified times (500ms intervals)
3. **Completion check**: Parse session file, check if latest request is complete
4. **Timeout**: Configurable inactivity timeout with success/failure behavior

**Completion indicators in session JSON:**

- Request has `response` array with content
- No `errorDetails` present
- Tool calls marked `isComplete: true`
- Thinking blocks have `vscodeReasoningDone: true`

**Timeout handling:**

- `chatInactivityTimeout` setting (default: 300s, range: 30-3600s)
- `treatChatTimeoutAsSuccess` setting (default: true)
  - When true: Timeout treated as completion (Copilot may have finished silently)
  - When false: Timeout treated as error, workflow stops

**Fallback: Log File Monitoring (ChatLogMonitor)**

Used if session file monitoring fails. Less reliable (~70%) but better than nothing.

- Monitors `.../exthost/GitHub.copilot-chat/` log files
- Completion markers: `finish reason: [stop]`, `| cancelled |`
- Two-tier discovery: Derived from `context.logUri` → Fallback search
  </completionDetection>

<sessionParser>
**ChatSessionParser** converts session files to UniversalCliOutput:

- **Events**: Text, thinking blocks, tool calls, errors
- **Metadata**: sessionId, model, harness (always "copilot-chat")
- **Tool calls**: Extracted from `toolCallRounds` with thinking content
- **Structured output**: Consistent with CLI harnesses for unified processing

**Response extraction:**

```typescript
extractResponse(sessionFilePath: string, requestIndex: number = -1): UniversalCliOutput
```

Default uses last request (-1). Returns events array with typed data.
</sessionParser>

<uiAutomationTiming>
**Direct Automation Timing (validated):**
- Focus chat window: 1000ms (chatPanel), 1500ms (newTab/newWindow)
- Clear input: 300ms (PROVEN required for selectAll)
- Type prompt: 500ms (PROVEN required after type command)
- Submit: Exponential backoff retry (500ms → 5s)

**Submit Verification:**

- Session file-based verification (compares request count before/after)
- Up to 15 retry attempts with exponential backoff (~18s total)
- Handles race conditions when Copilot is still responding
- 100% reliable vs old clipboard approach
  </uiAutomationTiming>

<nativeAttachments>
- Parses `#file:` and `#sym:` references, calls appropriate VS Code attach commands
- 200ms delay between attachments prevents race conditions
- Keeps references in prompt text for LLM context
- Symbol resolution via `resolveSymbol()` utility
</nativeAttachments>

<initialization>
Background polling: 5s intervals, 6 attempts max (30s total). Checks command availability. Session monitor initialized after Copilot ready.
</initialization>

<cancellation>
Calls `workbench.action.chat.cancel`, fires completion event regardless of success. `lastFailureWasUserCancellation` flag tracks user vs system cancels.
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
| File attachments    | Native commands or inline expansion | Always inline expansion                      |
| Session management  | UI-based (new chat commands)        | Process lifecycle                            |
| Cancellation        | `workbench.action.chat.cancel`      | Kill process                                 |
| UI visibility       | Always visible in chat UI           | Optional terminal (interactive vs. headless) |
| Harness identifier  | `copilot-chat`                      | `copilot-cli`, `claude-cli`, `codex-cli`     |

</differenceFromCli>

<terminology>
**Harness** (not "provider"): Execution strategy for AI interactions (copilot-chat, copilot-cli, claude-cli, codex-cli). The term "provider" is deprecated throughout the codebase in favor of "harness".
</terminology>

<purpose>
UI automation-based integration for GitHub Copilot Chat. Serves as fallback when CLI integration is unavailable or unsuitable.
</purpose>

<architecture>
Three classes:
- **CopilotChatIntegration**: UI automation orchestration, model switching, session management
- **ChatLogMonitor**: Log-based completion detection via `finish reason: [stop]` and `| cancelled |` markers
- **NativeAttachmentHandler**: File attachment via VS Code commands (`#file:`, `#sym:` references)

<keyFeatures>
- Model switching always happens before sending prompt (consistency with CLI)
- Native attachments via `chatUseNativeAttachments` setting (cleaner UI than inline expansion)
- Agent mode via `forceAgentModeForChat`
- Dynamic queue instructions inherited from base class

<provenTiming>
**Direct Automation Timing (validated):**
- Focus chat window: 1000ms (chatPanel), 1500ms (newTab/newWindow)
- Clear input: 300ms (PROVEN required for selectAll)
- Type prompt: 500ms (PROVEN required after type command)
- Submit: Exponential backoff retry (500ms → 5s)

**Submit Verification:**

- Clipboard-based verification (compares chat before/after)
- Checks chat content grew AND prompt appears
- Up to 10 retry attempts with exponential backoff
- Handles race conditions when Copilot is still responding
  </provenTiming>

<responseDetection>
**Log-based completion detection (ChatLogMonitor):**

1. **Initialization**: Discovers log file path once per session
2. **Pre-send**: Records current log file size via `recordPositionBeforeSend()`
3. **Monitoring**: Polls log file incrementally for new content (500ms intervals)
4. **Completion markers**:
   - Success: `finish reason: [stop]`
   - User cancelled: `| cancelled |`
5. **Response extraction**: `getChatContent()` via clipboard copy (preserves original clipboard)

**Log file discovery (two-tier strategy):**

1. PRIMARY: Derive from `context.logUri` (handles multiple VS Code windows)
   - Path: `.../logs/{timestamp}/{windowN}/exthost/GitHub.copilot-chat/`
   - Navigates from extension's log dir to Copilot Chat in same window
   - Guarantees correct log even with multiple instances

2. FALLBACK: Search for most recently modified log file
   - Used when derived path doesn't exist
   - Less reliable with multiple windows

**Timeout handling:**

- Inactivity timeout: `chatInactivityTimeout` setting (default: 300s, range: 30-3600s)
- Timeout behavior: `treatChatTimeoutAsSuccess` setting (default: true)
  - When true: Timeout treated as completion (Copilot may have finished silently)
  - When false: Timeout treated as error, workflow stops
- Progress logging every 10 seconds during monitoring
- Cancellation support via `isCancelledFn()` callback
  </responseDetection>

<nativeAttachments>
- Parses `#file:` and `#sym:` references, calls appropriate VS Code attach commands
- 200ms delay between attachments prevents race conditions
- Keeps references in prompt text for LLM context

<initialization>
Background polling: 5s intervals, 6 attempts max (30s total). Checks command availability. Log monitor starts after Copilot ready.

<cancellation>
Calls `workbench.action.chat.cancel`, fires completion event regardless of success. `lastFailureWasUserCancellation` flag tracks user vs system cancels.

<differenceFromCli>
**Chat vs. CLI key differences:**

| Aspect              | Chat Mode                           | CLI Mode                                     |
| ------------------- | ----------------------------------- | -------------------------------------------- |
| Completion detect   | Log file monitoring                 | Process exit / streaming                     |
| Response extraction | Clipboard copy after completion     | Direct output capture                        |
| Initialization      | Background polling (5s × 6)         | Sync availability check                      |
| Model switching     | VS Code command                     | Command-line flag                            |
| File attachments    | Native commands or inline expansion | Always inline expansion                      |
| Session management  | UI-based (new chat commands)        | Process lifecycle                            |
| Cancellation        | `workbench.action.chat.cancel`      | Kill process                                 |
| UI visibility       | Always visible in chat UI           | Optional terminal (interactive vs. headless) |

</differenceFromCli>
