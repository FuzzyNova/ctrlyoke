---
applyTo: "src/flightpath/chat/**"
---

<purpose>
Fallback integration using direct UI automation with hybrid response detection.
</purpose>

<provenTiming>
Validated in `extension.ts:testCopilotAutomation()`:
- Focus: 1000ms
- Clear: 300ms
- Type: 500ms
- Submit verification via clipboard retry (exponential backoff)
</provenTiming>

<responseDetection>
**Two-stage detection:**

**Stage 1: Tool fires (primary path - fast)**

1. LLM calls `flightpath_response_complete` tool when it thinks it's done
2. Tool callback fires `responseCompleteEmitter` event
3. FlightPathManager receives event → calls `waitForStreamingComplete()`
4. Clipboard polling (500ms intervals) waits for 3 stable checks (1.5s)
5. Result: Completion confirmed in ~2-5 seconds

**Stage 2: Tool never fires (fallback path - slow)**

- Runs in parallel with Stage 1 (started after submit)
- Polls clipboard every 2s, needs 2 minutes stability (60 checks)
- Bails early if tool fires (checks `toolCalledForCurrentPrompt` flag)
- If timeout (5min): Cancels chat, returns false
- If stable: Fires `responseCompleteEmitter` manually
- Result: Completion detected in ~2-5 minutes (or timeout)

**Edge cases handled:**

- Tool fires early/late → Stage 1 handles via streaming detection
- Tool never fires → Stage 2 detects via stability
- Multiple tool calls → First call wins (duplicate protection)
- Stuck/broken → Stage 2 timeout cancels chat

**Why this works:**

- 99% cases: Stage 1 completes in seconds
- 1% cases: Stage 2 catches failures in minutes
- No user interaction needed in either path
  </responseDetection>

<llmLoopPrevention>
- `toolCalledForCurrentPrompt` flag prevents duplicate events
- Second call executes `workbench.action.chat.cancel`
- Two-layer defense: integration flag + manager flag
</llmLoopPrevention>

<cancellation>
**cancel() method:**
- Executes `workbench.action.chat.cancel` command
- Stops Copilot from continuing to generate response
- Called by FlightPathManager.stop() when user presses stop button
- Also used in LLM loop prevention to stop duplicate tool calls
</cancellation>

<pauseResumeFlow>
**State tracking:**
- `isWaitingForResponse`: Tracks if prompt sent but tool callback not yet fired
- `pendingResponseResolver/Text`: Stores response when tool fires while paused

**Pause behavior (does NOT cancel current response):**

- Press pause: Queue state = "paused", Copilot keeps responding
- Tool callback fires: Check if paused
- If paused: Wait for streaming, set `isWaitingForResponse = false`, store resolver + response, DON'T resolve
- Promise remains pending = workflow stays at current prompt

**Resume behavior (three cases):**

1. **Tool callback already fired while paused:**
   - `pendingResponseResolver` exists → Resolve immediately to continue workflow
2. **Still waiting for response (tool callback not fired yet):**
   - `isWaitingForResponse = true` → Do nothing, let response complete naturally
   - When tool fires, sees queue is "running" → resolves normally → continues workflow
3. **Not waiting (paused between prompts):**
   - Call `startWorkflowExecution()` to send next prompt

**Stop behavior (cancels AND clears all state):**

- Execute cancel() to stop Copilot
- Clear `pendingResponseResolver`, `pendingResponseText`, `isWaitingForResponse`
- Stop queue
  </pauseResumeFlow>

<differenceFromCli>
- Tool registered AFTER Copilot activation
- Prepends `TOOL_INSTRUCTION` XML before user prompt
- Fires empty response text (no direct content access)
- Background polling for initialization (5s × 6 attempts)
- Stop = cancel command vs stop = kill process
</differenceFromCli>
