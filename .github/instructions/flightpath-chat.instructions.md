---
applyTo: "src/flightpath/chat/**"
---

<purpose>
Fallback integration using direct UI automation with log-based response detection.
</purpose>

<provenTiming>
Validated in `extension.ts:testCopilotAutomation()`:
- Focus: 1000ms
- Clear: 300ms
- Type: 500ms
- Submit verification via clipboard retry (exponential backoff)
</provenTiming>

<responseDetection>
**Log-based completion detection:**

1. During initialization, discovers `GitHub Copilot Chat.log` file path (session-stable)
2. Before sending prompt, records current log file size
3. After sending prompt, monitors log file for new content
4. Looks for `finish reason: [stop]` marker indicating response completion
5. Incremental reading from last known position for efficiency

**Log file discovery (two-tier strategy):**

1. PRIMARY: Derive from `context.logUri` (handles multiple VS Code windows)
   - Path structure: `.../logs/{timestamp}/{windowN}/exthost/{extension}/`
   - Navigates from our extension's log dir to `GitHub.copilot-chat/` in same window
   - Guarantees correct log file even with multiple VS Code instances

2. FALLBACK: Search for most recently modified log file (legacy behavior)
   - Used when derived path doesn't exist (e.g., Copilot Chat not yet used)
   - Less reliable with multiple windows but works as fallback

**Key benefits:**

- Window-specific: Uses `context.logUri` to find correct log for THIS window
- Deterministic: File-based, no UI timing dependencies
- No context pollution: No tool instructions needed in prompts
- Session-stable: Log path discovered once, reused for entire session
- Platform-agnostic: Same pattern on Windows/macOS/Linux

**Timeout handling:**

- Inactivity timeout: Configurable via `chatInactivityTimeout` setting (default: 300 seconds)
- Timeout behavior: Controlled by `treatChatTimeoutAsSuccess` setting
  - When true (default): Timeout treated as successful completion (Copilot may have finished)
  - When false: Timeout treated as error, workflow stops
- Cancellation support: Checks `isCancelling` flag during polling
  </responseDetection>

<cancellation>
**cancel() method:**
- Executes `workbench.action.chat.cancel` command
- Stops Copilot from continuing to generate response
- Called by FlightPathManager.stop() when user presses stop button
</cancellation>

<pauseResumeFlow>
**State tracking:**
- Log monitoring pauses when workflow is paused
- Resumes from last position when workflow continues

**Stop behavior:**

- Execute cancel() to stop Copilot
- Stop queue
  </pauseResumeFlow>

<differenceFromCli>
- Uses log file monitoring for completion detection
- Fires response text via clipboard copy after completion
- Background polling for initialization (5s × 6 attempts)
- Stop = cancel command vs stop = kill process
</differenceFromCli>
