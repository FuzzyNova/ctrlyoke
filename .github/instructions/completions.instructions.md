---
applyTo: "src/completions/**"
---

<purpose>
Context-aware IntelliSense for `#file:` references in prompt files.
</purpose>

<triggerBehavior>
- JSON files: Only inside "prompt" string values
- Markdown files: Anywhere in document
- Position: `lastIndexOf('#')` before cursor, stops if space after `#`
</triggerBehavior>

<performance>
- 5-second file cache (`CACHE_DURATION_MS`)
- 500 item limit
- Fuzzy filtering delegated to VS Code
</performance>

<selectionCompletions>
- Scans all visible editors
- Format: `#file:path:startLine-endLine`
- Always first in completion list
</selectionCompletions>
