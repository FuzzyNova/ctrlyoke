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
**Hybrid approach:**
1. Language Model Tool (`flightpath_response_complete`) fires when LLM thinks done
2. Tool callback triggers clipboard polling (500ms intervals)
3. Requires 3 consecutive stable checks (1.5s) to confirm
4. Only polls AFTER tool signals near-completion
</responseDetection>

<llmLoopPrevention>
- `toolCalledForCurrentPrompt` flag prevents duplicate events
- Second call executes `workbench.action.chat.cancel`
- Two-layer defense: integration flag + manager flag
</llmLoopPrevention>

<differenceFromCli>
- Tool registered AFTER Copilot activation
- Prepends `TOOL_INSTRUCTION` XML before user prompt
- Fires empty response text (no direct content access)
- Background polling for initialization (5s × 6 attempts)
</differenceFromCli>
