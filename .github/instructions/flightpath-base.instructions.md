---
applyTo: "src/flightpath/base/**"
---

<purpose>
Abstract base for all integrations (Strategy pattern). Defines contract, provides common functionality (prompt building, context expansion, event emitters).
</purpose>

<architecture>
**Hierarchy:** `CopilotIntegration` (abstract base) → two implementations:
- `CliIntegration` (composition-based, works with any CLI harness via `ICliProvider`)
- `CopilotChatIntegration` (UI automation)

**Abstract methods (MUST implement):**

- `initialize()` - Setup integration
- `sendPrompt()` - Execute prompt (returns false on failure, MUST set `lastFailureReason`)
- `getStatus()` - Current availability status
- `isIntegrationAvailable()` - Availability check
- `getIntegrationMode()` - Harness identifier (copilot-cli, claude-cli, codex-cli, copilot-chat)
- `getInitializationStatus()` - CopilotStatus enum
- `isReady()` - Ready for execution
- `cancelImplementation()` - Harness-specific cancellation

**Event emitters:** `statusChangeEmitter`, `responseCompleteEmitter`, `streamingChunkEmitter`, `streamingEventsEmitter`, `promptReadyEmitter` (all disposable)
</architecture>

<harnessTerminology>
**"Harness"** = AI framework/tool used for execution (copilot-cli, claude-cli, codex-cli, copilot-chat)

**NOT** the model provider - harnesses can use different models (e.g., copilot-cli can use claude-sonnet-4.5 or gpt-5)

See `Harness` enum in `src/types/FlightPathTypes.ts`
</harnessTerminology>

<promptBuilding>
**Pipeline:**
1. `buildPromptText()` - Expand context via `ContextExpander` (@file, #file:path:lines, #sym:symbol → XML attachments)
2. `buildPromptWithInstructions()` - Inject MCP tool instructions if `allowDynamicExtension` enabled
3. Subclass sends to harness (CLI or Chat)

**Dynamic queue:** Controlled by `allowDynamicExtension` (per-prompt) + `enableDynamicQueue` (global). Wraps MCP tool instructions in `<criticalInstruction>` XML tags (hidden in UI, processed by AI).

**Context expansion:** Delegated to `ContextExpander`. Auto-attachment controlled by `flightpath.autoAttachFiles` setting.
</promptBuilding>

<failureTracking>
**Contract:** If `sendPrompt()` returns `false`, MUST set `this.lastFailureReason` before returning.

Retrieved via `getLastFailureReason()` (resets to `null` after reading). Default fallback: "Failed to send prompt".
</failureTracking>

<cancellation>
`cancel()` sets `isCancelling = true`, calls `cancelImplementation()`. Use `resetCancellationFlag()` before new operations.
</cancellation>

<optionalMethods>
**CLI-specific** (default: `undefined`):
- `getLastResult()` - CliResult with response, statistics, exit code
- `getLastParsedOutput()` - UniversalCliOutput with tool calls, thinking blocks, metadata
- `getLastCliCommand()` - Executed command string
- `getLastFullPrompt()` - Complete prompt with context/instructions
- `parseTokenCounts()` - Extract prompt/completion tokens
- `isCli()` - Returns true for CLI integrations (override)

**Diagnostics** (safe defaults provided):

- `testAutomation()` - Test capability (Chat sends test message, CLI returns isReady())
- `retryDetection()` - Re-run initialization
- `getCapabilities()` - Integration capabilities
- `getDetailedStatus()` - Extended status information
- `wasLastFailureUserCancellation()` - Chat-specific failure type
  </optionalMethods>

<designPrinciples>
- Strategy pattern (polymorphic harnesses)
- Template method (common logic in base, harness-specific in subclasses)
- Single responsibility (ContextExpander for attachments, separate PropertyResolver/SessionResolver)
- Event-driven (loose coupling via EventEmitter)
- Graceful degradation (safe defaults for optional methods)
- Composition over inheritance (CliIntegration uses ICliProvider instead of abstract base)
</designPrinciples>

<propertyResolution>
Uses `PropertyResolver` for three-tier precedence: prompt-level → workflow-level → global settings

Resolved properties include: `harness`, `model`, `agent`, `newChatSession`, `allowDynamicExtension`

See `ResolvedProperties` type in `src/utils/PropertyResolver.ts`
</propertyResolution>

<sessionManagement>
`sendPrompt()` receives `workflowContext.resolvedProperties.sessionId` from `SessionResolver`

Three session ID formats:

- Numeric references: `sessionId: 1` → Reuse session from prompt 1
- Exact IDs: `sessionId: "uuid"` → Resume specific session
- Auto-resume: `newChatSession: false` → Continue from previous

Session IDs tracked in `_runtime` metadata, persisted via `PromptQueue`

See `docs/SESSION_MANAGEMENT.md` for details
</sessionManagement>

<purpose>
Abstract base for all integrations (Strategy pattern). Defines contract, provides common functionality (prompt building, context expansion, event emitters).
</purpose>

<architecture>
**Hierarchy:** `CopilotIntegration` (base) → `BaseCliIntegration` (CLI abstract) → 3 CLI impls + `CopilotChatIntegration`

**Abstract methods (MUST implement):** `initialize()`, `sendPrompt()`, `getStatus()`, `isIntegrationAvailable()`, `getIntegrationMode()`, `getInitializationStatus()`, `isReady()`, `cancelImplementation()`

**Event emitters:** `statusChangeEmitter`, `responseCompleteEmitter`, `streamingChunkEmitter`, `promptReadyEmitter` (all disposable)
</architecture>

<promptBuilding>
**Pipeline:** `buildPromptText()` (expand context via ContextExpander) → `buildPromptWithInstructions()` (inject MCP instructions if dynamic queue enabled) → subclass sends to provider

**Dynamic queue:** Controlled by `allowDynamicExtension` flag + `enableDynamicQueue` setting. Wraps MCP tool instructions in `<criticalInstruction>` tags (hidden in UI).

**Context expansion:** Delegated to `ContextExpander` utility. Supports `@file`, `#file:path:lines`, `#sym:symbol`, generates XML attachments.
</promptBuilding>

<failureTracking>
**Contract:** `sendPrompt()` returns `false` → MUST set `this.lastFailureReason` before returning. Retrieved via `getLastFailureReason()` (resets to `null`).
</failureTracking>

<cancellation>
`cancel()` sets `isCancelling = true`, calls `cancelImplementation()`. `resetCancellationFlag()` clears before new operations.
</cancellation>

<optionalMethods>
CLI-specific (default: `undefined`): `getLastResult()`, `getLastCliCommand()`, `getLastFullPrompt()`, `parseTokenCounts()`
Diagnostics: `testAutomation()`, `retryDetection()`, `getCapabilities()`, `getDetailedStatus()`, `isCli()`
</optionalMethods>

<designPrinciples>
Strategy pattern (polymorphic providers), template method (common logic in base), single responsibility (ContextExpander for attachments), event-driven (loose coupling), graceful degradation (safe defaults).
</designPrinciples>
