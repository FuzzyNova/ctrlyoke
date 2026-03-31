````instructions
---
applyTo: "src/completions/**"
---

<architecture>
Three-class system providing context-aware IntelliSense and navigation for FlightPath prompt files:

1. **PromptCompletionProvider** - IntelliSense for file references, symbols, and model selection
2. **PromptLinkProvider** - Ctrl+Click navigation from prompts to source code
3. **CompletionHelpers** - Shared logic and framework-agnostic completion items

Note: "Provider" in class names follows VS Code API naming (CompletionItemProvider, DocumentLinkProvider), unrelated to execution harness selection.

All registered for: `*.{prompt,flightpath}.json`, `*.flightpath.{yaml,yml}`, `*.prompt.md`, and `prompt` language.
</architecture>

<completionProvider>
**PromptCompletionProvider** provides three types of completions:

1. **File references** (`@` trigger) - Full file and directory attachments
2. **Symbol references** (`#` trigger) - Line ranges, selections, and workspace symbols
3. **Model selection** (JSON/JSONC only) - Inside "model" string values

**Trigger behavior:**

- `@` trigger: File and directory completions (CLI-native syntax)
- `#` trigger: Selections + workspace symbols (FlightPath-specific)
- Model field: Auto-triggers inside "model" string values (JSON only)

**Context detection:**

- **JSON/JSONC**: Only inside "prompt" or "model" string values
- **YAML/YML**: Only inside prompt values (supports multi-line blocks with `|` or `>`)
- **Markdown/Prompt**: Anywhere in document

**YAML prompt detection logic:**

- Searches backwards up to 50 lines for `prompt:` key
- Supports inline values: `prompt: "text"`, `prompt: 'text'`, `prompt: text`
- Supports block scalars: `prompt: |` and `prompt: >` with proper indentation checking
- Stops at empty lines or dedented content (out of block)
- Handles list items: `- prompt:` syntax

**Trigger character detection:**

- Uses `lastIndexOf('@')` and `lastIndexOf('#')` to find most recent trigger
- Stops if space found after trigger UNLESS inside a quoted path (`@"path with spaces/..."`)
- Routes to appropriate handler based on trigger type

**YAML compatibility:**

- `calculateCompletionRange()` provides explicit range from trigger to cursor
- Required for YAML extension to show completions
- Prevents VS Code from suppressing completion dropdown
</completionProvider>

<completionHelpers>
**CompletionHelpers** contains shared logic and caching:

**PlainCompletionItem interface:**

- Framework-agnostic completion representation
- Can be used by both extension and webview
- Converted to `vscode.CompletionItem` via `toVSCodeCompletionItem()`

**File completions** (`getFileCompletions()`):

- Returns both file AND directory completions
- Directories have trailing slash: `@src/ui/`
- Files use full path: `@src/extension.ts`
- Paths containing spaces are automatically quoted: `@"path with spaces/file.ts"`
- Max 500 items total (450 files + directories); directories sorted first
- 5-second cache (`CACHE_DURATION_MS`)

**Gitignore filtering:**

- Controlled by `flightpath.respectGitignoreForCompletions` setting
- OFF (default): Returns ALL files (node_modules, dist, logs, everything)
- ON: Filters using Git extension API `checkIgnore()` in 500-file batches
- Groups files by repository for efficient filtering
- Falls back to unfiltered on errors (fail-safe)
- Cache invalidated automatically when setting changes

**Symbol completions** (`getSymbolCompletions()`):

- Uses `getWorkspaceSymbols()` from AttachmentBuilders
- Maps `vscode.SymbolKind` to `vscode.CompletionItemKind` for proper icons
- Insert format: `sym:path/to/file.ts:SymbolName:42` (paths with spaces quoted: `sym:"path with spaces/file.ts":Name:42`)
- Max 500 results

**Selection completions** (`getSelectionCompletions()`):

- Scans ALL visible editors (including split views)
- Insert format: `selection:path:startLine-endLine` (1-based; paths with spaces quoted)
- Label: `selection: filename (lines X-Y)` for multi-editor, `selection: Current Selection` for single
- Deduplicates same file/range across multiple editors
- `sortText: !000_selection_NNN` (sorts before alphabetic entries)
- Shows preview (first 100 chars) in documentation

**Hash completions** (`getHashCompletions()`):

- Combines selections + symbols
- Selections prefixed with `0_` (sorted first), symbols with `1_` (sorted second)

**Prompt file completions** (`getPromptFileCompletions()`):

- Returns `.prompt.md`, `.md`, `.txt` files only
- Insert text uses `./relative/path` format
- Max 200 results
- Used by the webview prompt editor (not the VS Code completion provider)

**Initialization:**

- `initializeCompletionHelpers(context)` called during extension activation
- Sets up configuration watcher for cache invalidation
- `disposeCompletionHelpers()` exists but is dead code — watcher is disposed automatically via `context.subscriptions`

**Performance:**

- File cache: 5 seconds, shared across all completions
- Symbol queries: Fresh on each request (required for filtering)
- `isIncomplete: true` on CompletionList ensures live updates as user types
- Gitignore filtering uses 500-file batches to avoid overwhelming Git API
</completionHelpers>

<modelCompletions>
**Model field completions** (JSON/JSONC only):

- Triggers inside `"model": "..."` string values
- Uses `getAvailableModelsSync()` from ModelRegistry
- Shows CLI support indicator: "CLI & Chat" vs "Chat only"
- CLI-supported models sorted first (`0_*` vs `1_*`)
- Replaces entire value inside quotes (calculates range from opening to closing quote)
- Falls back to "No models available" message if registry not initialized

**Documentation shows:**

- Model ID (e.g., `claude-sonnet-4.5`)
- Vendor (Copilot, Claude, Codex)
- Family (Sonnet, Haiku, Opus, GPT)
- CLI support status (✅ Yes / ❌ No)
</modelCompletions>

<linkProvider>
**PromptLinkProvider** enables Ctrl+Click navigation from prompt files to source code.

**Supported link types:**

1. `@path/to/file.ts` or `@"path with spaces/file.ts"` → Opens file
2. `@path/to/dir/` or `@"path with spaces/dir/"` → Reveals directory in File Explorer
3. `#selection:path:10-20` or `#selection:"path with spaces/file":10-20` → Opens file with lines 10-20 selected
4. `#sym:path:symbol:42` or `#sym:"path with spaces/file":symbol:42` → Opens file at symbol line

**Implementation details:**

- Uses VS Code `DocumentLinkProvider` API
- Patterns stored as class fields; fresh `RegExp` instances created per helper method call (prevents state issues with global `/g` flag)
- Each link type has a quoted and unquoted regex variant; quoted variants matched first
- Custom command `flightpath.openFileWithSelection` for line selections
- Workspace-relative path resolution only (no absolute paths)

**Activation conditions** (`isPromptFile()`):

- File name ends with `.flightpath.json`, `.flightpath.yaml`, `.flightpath.yml`, `.prompt.md`
- OR `document.languageId` is `prompt`, `markdown`, `yaml`, or `yml`

**Pattern detection regex (class field `patterns`):**

- `fullFileQuoted`: `/@"([^"]+\.[a-zA-Z0-9]+)"/g`
- `fullFile`: `/@([^\s@#"]+\.[a-zA-Z0-9]+)/g`
- `directoryQuoted`: `/@"([^"]+\/)"/g`
- `directory`: `/@([^\s@#"]+\/)/g`
- `lineRangeQuoted`: `/#selection:"([^"]+)":(\d+)-(\d+)/g`
- `lineRange`: `/#selection:([^\s:]+):(\d+)-(\d+)/g`
- `symbolQuoted`: `/#sym:"([^"]+)":([^:]+):(\d+)/g`
- `symbol`: `/#sym:([^\s:]+):([^:]+):(\d+)/g`

**Command integration:**

- Directory links: `command:revealInExplorer?{uri}` (built-in VS Code command)
- Line selections: `command:flightpath.openFileWithSelection?{uri,startLine,endLine}` (custom command)
- Custom command registered in `extension.ts` via `registerCommands()`

**Relationship to PromptCompletionProvider:**

- Completion = Insert references (write operation)
- Link = Navigate to sources (read operation)
- Both share syntax (`@` for files, `#` for snippets)
- Both use workspace-relative paths
</linkProvider>

<registration>
**Extension registration** (in `extension.ts`):

Both providers registered for same file patterns:

```typescript
const promptFilePatterns = [
  { pattern: "**/*.{prompt,flightpath}.json" },
  { pattern: "**/*.flightpath.{yaml,yml}" },
  { pattern: "**/*.prompt.md" },
  { language: "prompt" }, // VS Code's prompt language
];
```

**Completion provider:**

- Registered twice with different trigger characters: `@` and `#`
- `vscode.languages.registerCompletionItemProvider(promptFilePatterns, provider, '@')`
- `vscode.languages.registerCompletionItemProvider(promptFilePatterns, provider, '#')`

**Link provider:**

- Single registration: `vscode.languages.registerDocumentLinkProvider(promptFilePatterns, provider)`

**Custom command:**

- `flightpath.openFileWithSelection` - Opens file with line range selected
- Registered via `vscode.commands.registerCommand()` in extension.ts

**Initialization:**

- `initializeCompletionHelpers(context)` called during activation
- Sets up configuration watchers and cache management
</registration>

<knownIssues>
**VS Code completion list bug:**

- Setting `isIncomplete: true` sometimes shows duplicate entries in UI
- This is a VS Code bug with how it handles completion list updates
- Only affects visual display, NOT the data we return
- Changing to `false` is worse: duplicates still occur AND list doesn't refresh as user types
- **Solution:** Keep `isIncomplete: true` for live filtering (critical for symbol search)

**YAML extension suppression:**

- VS Code YAML extension suppresses completions without explicit range
- **Solution:** `calculateCompletionRange()` calculates range from trigger to cursor
- Required for YAML/YML files to show completion dropdown

**Gitignore filtering performance:**

- Checking thousands of files against .gitignore can be slow
- Uses batching (500 files per Git API call) to prevent overwhelming the API
- Fails open on errors (returns unfiltered files if Git API fails)
- Cache prevents repeated expensive operations
</knownIssues>
````
