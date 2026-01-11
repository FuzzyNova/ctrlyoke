---
applyTo: "src/flightpath/chat/**"
---

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
