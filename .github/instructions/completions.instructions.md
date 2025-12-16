---
applyTo: "src/completions/**"
---

<purpose>
Context-aware IntelliSense and navigation for FlightPath prompt files:

**PromptCompletionProvider:**

1. `@file` and `#file:` references with IntelliSense
2. Dynamic model completions in "model" field (queried from Copilot API)

**PromptLinkProvider:**

1. Clickable links (Ctrl+Click) for context references
2. Bidirectional navigation between prompts and source code
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

<promptLinkProvider>
Enables Ctrl+Click navigation from prompt files back to source code.

**Supported link types:**

1. `@path/to/file.ts` → Opens file at top
2. `@path/to/dir/` → Reveals directory in File Explorer
3. `#file:path:10-20` → Opens file with lines 10-20 selected
4. `#sym:path:symbol:42` → Opens file at symbol line

**Implementation:**

- Uses VS Code DocumentLinkProvider API
- Fresh regex instances prevent state issues
- Custom command for line selection: `flightpath.openFileWithSelection`
- Workspace-relative path resolution only (no absolute paths)

**Pattern detection:**

- Full file: `/@([^\s@#]+\.[a-zA-Z0-9]+)/g`
- Directory: `/@([^\s@#]+\/)/g`
- Line range: `/#file:([^\s:]+):(\d+)-(\d+)/g`
- Symbol: `/#sym:([^\s:]+):([^:]+):(\d+)/g`

**Relationship to PromptCompletionProvider:**

- Completion = Insert references (write operation)
- Link = Navigate to sources (read operation)
- Both share syntax and path resolution logic
  </promptLinkProvider>
