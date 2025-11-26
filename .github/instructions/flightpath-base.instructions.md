---
applyTo: "src/flightpath/base/**"
---

<purpose>
Abstract base for CLI/Chat integration strategies. Strategy pattern + event-driven architecture.
</purpose>

<contract>
Subclasses implement: `initialize()`, `sendPrompt()`, `getStatus()`, `isIntegrationAvailable()`
</contract>

<events>
- `statusChangeEmitter`: Availability changes (initializing → ready → unavailable)
- `responseCompleteEmitter`: Response text (CLI) or empty string (Chat)
</events>

<failureTracking>
When `sendPrompt()` returns false, integrations MUST set `this.lastFailureReason` with a specific error message before returning.

Examples:

- "Copilot stopped responding (inactivity timeout after 300s)"
- "Copilot CLI error: ..."
- "Failed to send message to Copilot Chat"

`getLastFailureReason()` returns the reason and resets it to null. Falls back to "Failed to send prompt" if no specific reason was set.
</failureTracking>

<fileAttachments>
Parses `#file:path` and `#file:path:line-line`, builds Copilot XML format:

```xml
<context>
  <file path="relative/path" startLine="10" endLine="20">
    ...content...
  </file>
</context>
```

Attachment XML prepended; `#file:` syntax kept in prompt text for LLM context.
</fileAttachments>
