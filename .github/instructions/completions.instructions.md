````instructions
---
applyTo: "src/completions/**"
---

<architecture>
Four-class system providing context-aware IntelliSense and navigation for FlightPath prompt files:

1. **PromptCompletionProvider** - IntelliSense for file references, symbols, git changes, and model selection
2. **PromptPropertyCompletionProvider** - YAML property key completions for `.flightpath.yaml` workflow files
3. **PromptLinkProvider** - Ctrl+Click navigation from prompts to source code
4. **CompletionHelpers** - Shared logic and framework-agnostic completion items

Note: "Provider" in class names follows VS Code API naming (CompletionItemProvider, DocumentLinkProvider), unrelated to execution harness selection.

`PromptCompletionProvider` and `PromptLinkProvider` registered for: `*.{prompt,flightpath}.json`, `*.flightpath.{yaml,yml}`, `*.prompt.md`, and `prompt` language.
`PromptPropertyCompletionProvider` registered for: `*.flightpath.{yaml,yml}` only.
</architecture>

<completionProvider>
**PromptCompletionProvider** provides four types of completions:

1. **File references** (`@` trigger) - Full file and directory attachments
2. **Symbol references** (`#` trigger) - Line ranges, selections, and workspace symbols
3. **Git change context** (`~` trigger) - Diff, staged, stash, and commit references
4. **Model selection** (JSON/JSONC only) - Inside "model" string values

**Trigger behavior:**

- `@` trigger: File and directory completions (CLI-native syntax)
- `#` trigger: Selections + workspace symbols (FlightPath-specific)
- `~` trigger: Git change references (`~diff`, `~staged`, `~stash:N`, commit hashes)
- Model field: Auto-triggers inside "model" string values (JSON only)

**Context detection:**

- **JSON/JSONC**: Only inside "prompt" or "model" string values
- **YAML/YML**: Only inside prompt values (supports multi-line blocks with `|` or `>`)
- **Markdown/Prompt**: Anywhere in document

**YAML prompt detection logic:**

- Searches backwards up to 50 lines for `prompt:` key
- Supports inline values: `prompt: "text"`, `prompt: 'text'`, `prompt: text`
- Supports block scalars: `prompt: |` and `prompt: >` with proper indentation checking
- Empty lines stay in block; stops only at dedented non-empty content (out of block)
- Handles list items: `- prompt:` syntax

**Trigger character detection:**

- Uses `lastIndexOf('@')`, `lastIndexOf('#')`, and `lastIndexOf('~')` to find most recent trigger
- Routes to the trigger with the highest index (closest to cursor)
- Stops if space found after trigger UNLESS inside a quoted path (`@"path with spaces/..."`)

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

**Git change completions** (`getGitChangeCompletions()`):

- Called by `PromptCompletionProvider` for `~` trigger and by the webview
- Always-present items: `~diff` (working tree changes) and `~staged` (index)
- Stash items: `~stash:N` for each stash entry
- Commit items: recent 50 commits by default; switches to `git --grep` full-history search when `filterText` is non-empty (up to 200 results)
- 10-second cache (`GIT_CACHE_DURATION_MS`) for base commits/stashes; separate search cache keyed by query string
- Insert text is just the ref (e.g., `diff`, `staged`, `stash:0`, full commit hash)

**Prompt file completions** (`getPromptFileCompletions()`):

- Returns `.prompt.md`, `.md`, `.txt` files only
- Insert text uses `./relative/path` format
- Max 200 results
- Used by the webview prompt editor (not the VS Code completion provider)

**Initialization:**

- `initializeCompletionHelpers(context)` called during extension activation
- Subscribes to `configService` for cache invalidation on any config change
- Watcher registered in `context.subscriptions` (disposed automatically)

**Performance:**

- File cache: 5 seconds, shared across all completions
- Git cache: 10 seconds for commits/stashes; per-query cache for search results
- Symbol queries: Fresh on each request (required for filtering)
- `isIncomplete: true` on CompletionList ensures live updates as user types
- Gitignore filtering uses 500-file batches to avoid overwhelming Git API</completionHelpers>

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
5. `~diff`, `~staged`, `~stash:N`, `~<hash>` → Opens live git diff in a new untitled editor

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
- Git change links: `command:flightpath.openGitChange?{ref}` (custom command)
- Custom commands registered in `extension.ts` via `registerCommands()`

**Relationship to PromptCompletionProvider:**

- Completion = Insert references (write operation)
- Link = Navigate to sources (read operation)
- Both share syntax (`@` for files, `#` for snippets)
- Both use workspace-relative paths
</linkProvider>

<registration>
**Extension registration** (in `extension.ts`):

`PromptCompletionProvider` and `PromptLinkProvider` share these patterns:

```typescript
const promptFilePatterns = [
  { pattern: "**/*.{prompt,flightpath}.json" },
  { pattern: "**/*.flightpath.{yaml,yml}" },
  { pattern: "**/*.prompt.md" },
  { language: "prompt" }, // VS Code's prompt language
];
```

**Completion provider:**

- Registered three times with different trigger characters: `@`, `#`, and `~`
- `@` → file and directory references
- `#` → selections and workspace symbols
- `~` → git change context (diff, staged, stash, commits)

**Property key completion provider:**

- `PromptPropertyCompletionProvider` registered for `*.flightpath.{yaml,yml}` only
- No trigger character — VS Code invokes on Ctrl+Space or natural typing
- Context-aware: detects `type: script` vs AI prompt step within the item block

**Link provider:**

- Single registration: `vscode.languages.registerDocumentLinkProvider(promptFilePatterns, provider)`

**Custom commands:**

- `flightpath.openFileWithSelection` - Opens file with line range selected
- `flightpath.openGitChange` - Opens live git diff in a new untitled editor
- Both registered via `vscode.commands.registerCommand()` in extension.ts

**Initialization:**

- `initializeCompletionHelpers(context)` called during activation
- Sets up config subscription and cache management
</registration>

<promptPropertyCompletionProvider>
**PromptPropertyCompletionProvider** provides context-aware YAML property key completions for `steps:` list items in `.flightpath.yaml` workflow files.

**Step type detection:**

- Searches the current item block (bounded by list-item `-`) for `type: script`
- Searches backwards up to 100 lines for the item start, then up to 50 more lines for `steps:` key
- `isInsidePromptStep: false` returned if cursor is outside a `steps:` list item

**Property groups:**

- `COMMON_PROPERTIES` — offered for all step types: `type`, `name`
- `AI_PROMPT_PROPERTIES` — offered when step is an AI prompt (no `type: script`): `prompt`, `harness`, `model`, `agent`, `skills`, `resumeSession`, `sessionId`, `mcpServers`, `hooks`, `endCondition`, `preCondition`, `allowDynamicExtension`
- `SCRIPT_ONLY_PROPERTIES` — offered when `type: script`: `script`, `timeout`, `compareSource`, `returns`, `onPass`, `onFail`

**Position detection (`isAtPropertyKeyPosition()`):**

- True when text before cursor is only whitespace + optional `- ` + partial identifier (no `: `)
- Also true when cursor is on `type: <value>` for enum value completions

**Type value completions:**

- When cursor is after `type: `, offers `prompt` (sorted first) and `script` (sorted second) as enum members

**Key property constants** mostly sourced from `PROMPT_PROPERTIES` and `STEP_TYPES` in `src/types/DashboardConstants.ts`. Exception: `"name"`, `"timeout"`, and `"allowDynamicExtension"` are inline strings (constants exist in `PROMPT_PROPERTIES` but aren't used there).
</promptPropertyCompletionProvider>

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
