---
applyTo: "src/types/**"
---

<purpose>
Core data structures. TypeScript strict mode enforced.
</purpose>

<flightPathTypes>
**Core workflow types:**
- `PromptFile` - Root structure for `.prompt.json`/`.flightpath.json`
- `PromptItem` - Individual prompt with optional model override and end condition
- `EndCondition` - Validation script configuration
- `QueueState` - Execution state machine with progress tracking
- `PromptResult` - Per-prompt execution result with status and timestamp

**Enums:**

- `Provider` - "cli" | "chat"

**Important patterns:**

- Model override is optional (`model?: "claude-sonnet-4.5" | ...`)
- EndCondition is optional (prompts can execute without validation)
- QueueState.status is discriminated union ("idle" | "running" | "paused" | "completed" | "error")
- PromptResult.status transitions: pending → sent → completed/failed
  </flightPathTypes>

<copilotTypes>
**CLI-specific types:**
- `CopilotCliOptions` - CLI command configuration
- `CopilotCliResult` - Structured CLI output (response, statistics, error, exit code)
- `CopilotCliStatistics` - Parsed statistics (usage, durations, code changes, model)

**Chat-specific types:**

- `CopilotChatRequest` - Simple prompt wrapper
- `CopilotChatResponse` - Response with content, timestamp, success flag

**Why separate files:**

- FlightPathTypes: Core domain types (entire extension)
- CopilotTypes: Integration-specific types (isolates CLI/Chat details)
- Separation enables future strategies without polluting core types
  </copilotTypes>

<typeSafetyPatterns>
**Status constants (use instead of hardcoded strings):**
```typescript
import { EXECUTION_STATES, STEP_STATUS } from "../types/FlightPathTypes";

// Execution states for QueueState.status
if (state.status === EXECUTION_STATES.RUNNING) {
// TypeScript knows we're in running state
}

// Step status for PromptResult.status
result.status = STEP_STATUS.COMPLETED;

````

**Optional chaining:**

```typescript
const model = prompt.model || this.getConfiguredModel();
// Prompt can override model, or use default
````

**Type guards:**

```typescript
private isChatIntegration(integration: CopilotIntegration): integration is CopilotChatIntegration {
  return integration instanceof CopilotChatIntegration;
}
```

- Enables safe access to integration-specific methods
- TypeScript narrows type after guard check
  </typeSafetyPatterns>

<relatedFiles>
- `../flightpath/PromptFileParser.ts` - Validates against PromptFile structure
- `../flightpath/PromptQueue.ts` - Uses QueueState and PromptResult
- `../flightpath/cli/CopilotCommandLineIntegration.ts` - Uses CopilotCliOptions/Result
- `/schemas/prompt-schema.json` - JSON Schema mirrors TypeScript types
</relatedFiles>
