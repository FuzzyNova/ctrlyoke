---
applyTo: "src/types/**"
---

<purpose>
Core data structures and constants for FlightPath extension. TypeScript strict mode enforced. Three primary files:
- **FlightPathTypes.ts** - Core workflow and integration types
- **CopilotTypes.ts** - Integration-specific types (CLI and Chat)
- **DashboardConstants.ts** - Shared constants (SINGLE SOURCE OF TRUTH for all string literals, enums, and UI values)
</purpose>

<flightPathTypes>
**File: FlightPathTypes.ts**

**Core types:** `PromptFile`, `PromptItem` (id, prompt, provider?, model?, agent?, newChatSession?, allowDynamicExtension?, endCondition?), `EndCondition`, `QueueState` (completedIds, timing, extensions, workingFilePath), `PromptResult`, `WorkingFile`, `WorkingFileRuntime`, `DynamicQueueConfig`

**Harness enum:** "copilot-cli" | "copilot-chat" | "claude-cli" | "codex-cli"

**Key patterns:** Harness/model/agent per-prompt overrides optional, `allowDynamicExtension` for queue extension, WorkingFile extends PromptFile with runtime metadata
**File: CopilotTypes.ts**

Integration-specific types: `CopilotChatRequest/Response`, `CopilotIntegration` interface, `CopilotCliOptions` (tool permissions, logging, MCP), `CopilotCliResult`, `CopilotCliStatistics`

**Separation:** FlightPathTypes = core domain, CopilotTypes = integration details (isolates CLI/Chat implementation)
**File: DashboardConstants.ts - SINGLE SOURCE OF TRUTH**

ALL shared constants for extension ↔ webview. **NO HARDCODED STRINGS.**

**Key objects:** `MESSAGE_TYPES` (50+ extension/webview messages), `EXECUTION_STATES` (QueueState.status), `STEP_STATUS` (PromptResult.status), `ACTION_TYPES`, `HARNESS_IDS`, `HARNESS_INFO`, `DEFAULT_MODELS`, `CLAUDE_CLI_MODELS`, `CODEX_CLI_MODELS`, `HARNESS_STATUS_STRINGS`, `UI_STRINGS`, `QUEUE_POSITION`, `PROMPT_PROPERTIES`, `END_CONDITION_PROPERTIES`

**Type helpers:** `MessageType`, `ExecutionState`, `StepStatus`, `HarnessId`, etc. (derived from const objects)
**Import constants from DashboardConstants (NEVER hardcode strings):**

```typescript
import { EXECUTION_STATES, STEP_STATUS, MESSAGE_TYPES } from "../types/DashboardConstants";

// Execution states for QueueState.status
if (state.status === EXECUTION_STATES.RUNNING) {
// TypeScript knows we're in running state
}

// Step status for PromptResult.status
result.status = STEP_STATUS.COMPLETED;

// Message types for extension ↔ webview communication
this.postMessage({ type: MESSAGE_TYPES.PROGRESS_UPDATE, data: { ... } });

```

**Use type helpers for function signatures:**

```typescript
import { ExecutionState, StepStatus } from "../types/DashboardConstants";

function updateState(status: ExecutionState) { ... }
function getStepResult(status: StepStatus) { ... }
```

**Optional chaining and provider overrides:**

```typescript
const provider = prompt.provider || ConfigurationUtils.getHarness();
const model = prompt.model || ConfigurationUtils.getModel();
const agent = prompt.agent; // CLI mode only
```

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
**Core workflow:**
- `../flightpath/PromptFileParser.ts` - Validates against PromptFile structure
- `../flightpath/PromptQueue.ts` - Uses QueueState and PromptResult
- `../flightpath/WorkflowExecutor.ts` - Uses DynamicQueueConfig for queue extension
- `../utils/PromptIdentity.ts` - Hash-based prompt identity for deduplication
- `/schemas/prompt-schema.json` - JSON Schema mirrors TypeScript types

**Integrations:**

- `../flightpath/cli/CopilotCommandLineIntegration.ts` - Uses CopilotCliOptions/Result
- `../flightpath/chat/CopilotChatIntegration.ts` - Uses CopilotChatRequest/Response

**UI:**

- `../ui/FlightPathDashboardProvider.ts` - Uses MESSAGE_TYPES for webview communication
- `../ui/FlightPathSettingsProvider.ts` - Uses HARNESS_IDS, DEFAULT_MODELS
- `../ui/webview/dashboard.js` - JavaScript code imports constants via inline script

**Documentation:**

- `docs/QUEUE_APPEND_FEATURE.md` - Working file system and append segments
- `docs/DYNAMIC_QUEUE_ARCHITECTURE.md` - Dynamic queue extension
  </relatedFiles>

<criticalRules>
1. **NO HARDCODED STRINGS** - All shared string literals MUST be defined in DashboardConstants.ts
2. **Single Source of Truth** - Each constant has exactly ONE definition location
3. **Type Safety** - Use ExecutionState, StepStatus, MessageType, etc. instead of raw strings
4. **Import Consistency** - Always import from DashboardConstants for shared values
5. **When adding new constants:**
   - Add to appropriate constant object in DashboardConstants.ts
   - Export as const with `as const` assertion
   - Add type helper if needed (e.g., `type NewType = typeof NEW_CONST[keyof typeof NEW_CONST]`)
   - Update this instruction file if adding new constant category
</criticalRules>
