---
applyTo: "src/flightpath/base/**"
---

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
