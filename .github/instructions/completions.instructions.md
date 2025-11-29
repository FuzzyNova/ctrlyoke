---
applyTo: "src/completions/**"
---

<purpose>
Context-aware IntelliSense for FlightPath prompt files. Provides:
1. `#file:` references and selections in prompt strings
2. Dynamic model completions in "model" field (queried from Copilot API)
</purpose>

<triggerBehavior>
**File/Selection completions:**
- JSON files: Only inside "prompt" string values
- Markdown files: Anywhere in document
- Position: `lastIndexOf('#')` before cursor, stops if space after `#`

**Model completions:**

- JSON files only: Inside "model" string value
- Triggers on any character or Ctrl+Space
- Shows models from ModelRegistry (dynamically queried)
  </triggerBehavior>

<performance>
- 5-second file cache (`CACHE_DURATION_MS`)
- 500 item limit for files
- Model registry queried once at activation
</performance>

<selectionCompletions>
- Scans all visible editors
- Format: `#file:path:startLine-endLine`
- Always first in completion list
</selectionCompletions>

<modelCompletions>
- Uses ModelRegistry for available models
- Shows CLI support indicator (CLI & Chat vs Chat only)
- CLI-supported models sorted first
- Falls back to static list if API query failed
</modelCompletions>
