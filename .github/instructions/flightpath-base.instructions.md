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
