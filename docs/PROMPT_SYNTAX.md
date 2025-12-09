# FlightPath Prompt Syntax & Completion Reference

## Overview

FlightPath supports rich context references in prompts using a syntax aligned with CLI standards while adding workspace intelligence features. This document defines the syntax, completion behavior, and migration path.

**Last Updated**: 2025-12-09

---

## ⚠️ CURRENT IMPLEMENTATION STATUS

**What's Implemented** (in `PromptCompletionProvider.ts`):

- ✅ `#` trigger only (no `@` trigger yet)
- ✅ `#file:path` completions for workspace files (max 500, 5s cache)
- ✅ `#file:path:10-20` line range support
- ✅ Selection completions (inserts `file:path:line-line`)
- ✅ Model completions in "model" field
- ✅ Works in JSON and Markdown prompt files

**What's NOT Implemented Yet**:

- ❌ `@` completion trigger/handler
- ❌ `@path` syntax for full file references
- ❌ `#sym:name` symbol completions
- ❌ `@dir:path` directory structure references
- ❌ Migration tooling (`#file:path` → `@path`)
- ❌ Deprecation warnings for old syntax

**Bottom Line**: All completions currently use `#file:` prefix. The `@` syntax described in this document is the planned migration target, not current behavior.

---

---

## Syntax Reference

### Mental Model

- **`@` = Full Content**: Complete files or directory structures
- **`#` = Snippets/Excerpts**: Line ranges, selections, symbols

### Full File Attachment: `@path` _(PLANNED - NOT IMPLEMENTED)_

**Purpose**: Attach entire file content

**Format**:

```
@path/to/file.ts              # Full file only
```

**Example**:

```json
{
  "prompt": "Refactor @src/extension.ts to improve error handling"
}
```

**Behavior** _(when implemented)_:

- **CLI handles natively**: File content auto-attached by Copilot/Claude CLI
- **Path resolution**: Workspace-relative (no leading `/` or `\`)
- **Platform**: Both `@src/file.ts` and `@src\file.ts` work (auto-normalized)

**CLI Integration**:

- Copilot CLI: `@path` triggers `.github/copilot-instructions.md` + folder-level instructions
- Claude CLI: `@path` auto-attaches content + `CLAUDE.md` instructions
- See [COPILOT_CLI_DESIGN.md](./COPILOT_CLI_DESIGN.md) and [CLAUDE_CLI_DESIGN.md](./CLAUDE_CLI_DESIGN.md) for details

**Important**: CLIs don't support line range syntax. `@path:10-20` would attach the entire file, not lines 10-20.

**Current Implementation**: NOT IMPLEMENTED. Completion provider currently only offers `#file:` completions.

---

### Directory Structure: `@dir:path` _(Planned)_

**Purpose**: Attach directory structure (file tree, no content)

**Format**:

```
@dir:path/to/directory        # Directory structure
```

**Example**:

```json
{
  "prompt": "Explain the architecture of @dir:src/flightpath"
}
```

**Behavior** _(when implemented)_:

- **FlightPath handles**: Reads directory tree and wraps in XML attachment
- **No content**: Shows file names and structure only
- Useful for "explain module" or "understand organization" prompts

**Priority**: Medium (useful for architectural questions)

---

### Snippet Context: `#` prefix

**Purpose**: Attach code excerpts and workspace snippets (FlightPath handles with XML)

#### Line Range: `#file:path:startLine-endLine`

**Format**:

```
#file:path/to/file.ts:10-20   # Lines 10-20 only
```

**Example**:

```json
{
  "prompt": "Explain the logic in #file:src/flightpath/PromptQueue.ts:45-67"
}
```

**Behavior**:

- **FlightPath extracts lines**: Reads file and extracts specified range
- **XML attachment**: Wraps in `<attachment>` block
- **Neither CLI supports this natively**: FlightPath custom feature

#### Current Editor Selection (via Completion)

**How it works**:

1. User types `#` in a prompt file
2. Completion shows: `$(selection) Current Selection` (if editor has selection)
3. User accepts completion
4. Inserts: `file:path/to/file:startLine-endLine`

**Resulting prompt**:

```json
{
  "prompt": "Optimize #file:src/extension.ts:45-67 for better performance"
}
```

**Behavior**:

- **Completion label**: Shows `$(selection) Current Selection` in IntelliSense
- **Inserted text**: `file:path:startLine-endLine` (NOT `selection`)
- **FlightPath processes**: Extracts lines and wraps in XML attachment
- **Important**: `#selection` is NEVER in actual prompts - it's just a UI label

**Note**: There is no `#selection` prompt syntax. The completion provider automatically converts selections to `#file:path:line-line` format.

#### Symbol References: `#sym:symbolName` _(Planned)_

**Format**:

```
#sym:symbolName               # Function, class, method, or variable
```

**Example**:

```json
{
  "prompt": "Refactor #sym:FlightPathManager to improve modularity"
}
```

**Behavior** _(when implemented)_:

- Uses VS Code Language Server to resolve symbol location
- Converts to line range: `@file:path:startLine-endLine`
- Completion shows symbols from current file or workspace-wide search

**Priority**: Medium-High (high user value for focused refactoring)

#### Directory Context: `#dir:path` _(Planned)_

**Format**:

```
#dir:path/to/directory        # Directory structure
```

**Example**:

```json
{
  "prompt": "Explain the architecture of #dir:src/flightpath"
}
```

**Behavior** _(when implemented)_:

- Reads directory structure (file tree, no content)
- Wraps in XML attachment
- Useful for "explain module" or "understand organization" prompts

**Priority**: Medium (useful for architectural questions)

---

## Completion Provider Strategy

### Two-Handler Architecture

FlightPath plans to use **two separate completion handlers** to avoid performance issues:

#### Handler 1: `@` Completion (Fast - Full Content) _(NOT IMPLEMENTED)_

**Trigger**: `@` character

**Items** _(planned)_:

- ⬜ Workspace files (cached, max 500 items)
- ⬜ Directories (when `@dir:` is typed)

**Performance** _(when implemented)_:

- File cache: 5-second TTL, refreshed on demand
- Parallel file reads for attachments
- Sorted by path depth (shorter paths first)

**Current Status**: NOT IMPLEMENTED. No `@` trigger exists in PromptCompletionProvider yet.

**Example completions**:

```
@src/extension.ts                    (file - src/)
@package.json                        (file - Root)
@src/flightpath/PromptQueue.ts       (file - src/flightpath/)
@dir:src/flightpath                  (directory - 8 files) [PLANNED]
```

#### Handler 2: `#` Completion (Current Implementation)

**Trigger**: `#` character

**Items shown immediately**:

- ✅ Current editor selections (labeled `$(selection) Current Selection`)
  - Inserts `file:path:startLine-endLine` format
- ✅ `#file:path` workspace files (cached, max 500 items)
  - Allows manual line range entry like `#file:path:10-20`

**Items shown after typing** _(planned)_:

- ⬜ `#sym:<search>` - Fuzzy search symbols matching typed text

**Performance**:

- File cache: 5-second TTL, refreshed on demand
- Selection completions from all visible editors
- Sorted by path depth (shorter paths first)

**Current Status**: ✅ FULLY IMPLEMENTED for `#file:` completions. Symbol completions planned.

**Note**: This is currently the ONLY completion handler. All file completions use `#file:` prefix, not `@`.

**Example completions**:

```
# (user types #)
$(selection) Current Selection          → inserts: file:src/extension.ts:45-67
$(selection) extension.ts (lines 45-67) → inserts: file:src/extension.ts:45-67
extension.ts                            → inserts: file:src/extension.ts
package.json                            → inserts: file:package.json

# (user types #file:src/extension.ts:)
  [User manually types line range like :10-20, no completion needed]

# (user types #sym:Flight)
#sym:FlightPathManager                  → inserts: file:src/.../Manager.ts:10-50 [PLANNED]
#sym:FlightPathDashboardProvider        → inserts: file:src/.../Dashboard.ts:15-80 [PLANNED]
```

**Note**: Selection completions show `$(selection)` label but insert `file:path:line-line` text.

---

## Migration from Legacy Syntax

### Legacy Format: `#file:path` for full files

FlightPath previously used `#file:path` for full file attachment:

```json
{
  "prompt": "Analyze #file:src/extension.ts"
}
```

**New format** (aligned with CLIs):

```json
{
  "prompt": "Analyze @src/extension.ts"
}
```

### What's NOT Changing

**Line ranges keep `#file:` syntax**:

```json
{
  "prompt": "Explain #file:src/extension.ts:45-67"
}
```

✅ This is correct - CLIs don't support line ranges, so FlightPath handles them with XML.

**Selections keep current completion behavior**:

- User types `#`, sees `$(selection) Current Selection` in completions
- Completion inserts `file:src/extension.ts:45-67`
- Final prompt: `Optimize #file:src/extension.ts:45-67`

✅ No change needed - `#selection` is just a completion label, not prompt syntax.

### Migration Path

**Status**: Pre-release - breaking change acceptable for full file references only

**Timeline**:

1. **Phase 1** (Current): Support both `@path` and `#file:path` for full files
2. **Phase 2** (Next release): Show deprecation warnings for `#file:path` without line ranges
3. **Phase 3** (Future): Remove `#file:path` support for full files (keep for line ranges)

**Migration Tooling** _(planned)_:

1. **Code Action**: "Convert #file:path to @path"
   - Only appears on full file references (no `:line-line`)
   - One-click conversion

2. **Batch Conversion Command**: `FlightPath: Migrate Prompt Syntax`
   - Scans workspace for `.prompt.json` and `.flightpath.json` files
   - Converts `#file:path` → `@path` (preserves `#file:path:10-20`)
   - Shows preview before applying

**User Communication**:

- Changelog explaining full file vs. snippet distinction
- Update all templates and examples
- Migration guide in README

---

## Design Rationale

### Why `@` for Full Content?

1. **CLI Alignment**: Both Copilot CLI and Claude CLI use `@path` natively for full files
2. **No Conversion Needed**: Eliminates `#file:path` → `@path` transformation for full files
3. **Industry Standard**: VS Code Chat, GitHub Copilot, and Claude all use `@` for files
4. **User Familiarity**: Reduces learning curve for CLI users
5. **Clear Intent**: `@` = "attach this entire thing" (file, directory structure)

### Why `#` for Snippets?

1. **Semantic Distinction**: `#` signals "extract a piece" vs. "attach the whole thing"
2. **FlightPath Custom Feature**: CLIs don't support line ranges/selections/symbols natively
3. **XML Handling**: All `#` references become XML attachments (FlightPath processes them)
4. **Performance**: Separates fast completions (`@` cached files) from lazy searches (`#sym:`)
5. **Extensibility**: Clear namespace for snippet types (`#file:line-line`, `#sym:`, future features)

### Mental Model Summary

| Syntax Type        | Purpose                  | Who Handles      | Example                        | Notes                              |
| ------------------ | ------------------------ | ---------------- | ------------------------------ | ---------------------------------- |
| `@path`            | Full file content        | CLI (native)     | `@src/extension.ts`            | CLI attaches entire file           |
| `@dir:path`        | Full directory structure | FlightPath (XML) | `@dir:src/flightpath`          | File tree, no content _(planned)_  |
| `#file:path:10-20` | Line range snippet       | FlightPath (XML) | `#file:src/extension.ts:10-20` | Extracts specific lines            |
| `#sym:name`        | Symbol snippet           | FlightPath (XML) | `#sym:FlightPathManager`       | Resolves to line range _(planned)_ |

**Note**: There is no `#selection` syntax. The completion provider shows `$(selection)` as a label but inserts `file:path:line-line`.

### Performance Considerations

**Problem**: Loading all files + symbols + directories in one completion list is slow (100ms+)

**Solution**: Two handlers with different trigger characters

- `@` → Pre-cached files (instant)
- `#` → Lazy-loaded context (search as you type)

**Result**: Sub-50ms completion latency even in large workspaces

---

## Implementation Status

| Feature                          | Status  | Priority | Notes                                                   |
| -------------------------------- | ------- | -------- | ------------------------------------------------------- |
| `#` trigger for file completions | ✅ Done | -        | Only trigger currently implemented                      |
| `#file:path` completions         | ✅ Done | -        | Workspace files with 5s cache, max 500 items            |
| `#file:path:10-20` line ranges   | ✅ Done | -        | Completions support, XML attachment in CLI integration  |
| Selection completions            | ✅ Done | -        | Inserts `file:path:line-line` from editor selections    |
| Model completions                | ✅ Done | -        | Dynamic model list in "model" field                     |
| `@` trigger handler              | ⬜ TODO | **HIGH** | **NEW HANDLER NEEDED** - separate from `#`              |
| `@path` file references          | ⬜ TODO | **HIGH** | Requires new `@` completion handler                     |
| `#sym:name` symbol refs          | ⬜ TODO | MEDIUM   | Requires Language Server integration                    |
| `@dir:path` directory refs       | ⬜ TODO | LOW      | Directory structure attachment                          |
| Lazy symbol search               | ⬜ TODO | MEDIUM   | Performance optimization for `#sym:`                    |
| Migration code action            | ⬜ TODO | **HIGH** | One-click `#file:` → `@` conversion                     |
| Batch migration command          | ⬜ TODO | **HIGH** | Workspace-wide syntax migration                         |
| Deprecation warnings             | ⬜ TODO | MEDIUM   | Show hints when using `#file:` for full files (Phase 2) |

---

## Examples

### Full File Attachment

```json
{
  "prompt": "Review @src/extension.ts for potential improvements"
}
```

_CLI attaches entire file content natively_

### Line Range Snippet

```json
{
  "prompt": "Explain the error handling in #file:src/flightpath/PromptQueue.ts:123-145"
}
```

_FlightPath extracts lines 123-145 and wraps in XML attachment_

### Multiple Full Files

```json
{
  "prompt": "Compare @src/flightpath/cli/CopilotCommandLineIntegration.ts and @src/flightpath/cli/ClaudeCommandLineIntegration.ts and suggest refactoring opportunities"
}
```

_Both files attached in full by CLI_

### Current Selection (via Completion)

```json
{
  "prompt": "Optimize #file:src/extension.ts:45-67 for better type safety"
}
```

_User typed `#`, selected "Current Selection" from completions, which inserted `file:src/extension.ts:45-67`_

### Symbol References _(Future)_

```json
{
  "prompt": "Refactor #sym:FlightPathManager.executeWorkflow to improve error handling"
}
```

_FlightPath resolves symbol location, converts to line range, wraps in XML_

### Directory Structure _(Future)_

```json
{
  "prompt": "Explain the architecture of @dir:src/flightpath and suggest improvements"
}
```

_FlightPath reads directory tree (no file content), wraps in XML_

### Mixed Content and Snippets

```json
{
  "prompt": "Review @docs/ARCHITECTURE.md and verify that #file:src/flightpath/FlightPathManager.ts:45-120 follows the documented patterns"
}
```

_Full architecture doc + specific code snippet_

---

## Implementation Roadmap

### Phase 1: Add `@` Completion Handler (HIGH PRIORITY)

**Current State**: `PromptCompletionProvider.ts` only has `#` trigger logic

**Required Changes**:

1. **Register second completion provider** in `extension.ts`:

   ```typescript
   // Current: Only one provider registered
   const promptCompletionProvider = new PromptCompletionProvider();
   context.subscriptions.push(
     vscode.languages.registerCompletionItemProvider(
       ["json", "jsonc", "markdown", "prompt"],
       promptCompletionProvider,
       "#" // Only # trigger
     )
   );

   // Needed: Add @ trigger
   context.subscriptions.push(
     vscode.languages.registerCompletionItemProvider(
       ["json", "jsonc", "markdown", "prompt"],
       promptCompletionProvider,
       "@" // Add @ trigger
     )
   );
   ```

2. **Update `provideCompletionItems()` logic**:

   ```typescript
   // Add detection for @ vs # trigger
   const line = document.lineAt(position.line).text;
   const textBeforeCursor = line.substring(0, position.character);
   const lastAtIndex = textBeforeCursor.lastIndexOf("@");
   const lastHashIndex = textBeforeCursor.lastIndexOf("#");

   // Determine which trigger is active
   if (lastAtIndex > lastHashIndex) {
     // @ trigger - provide full file completions
     return this.getAtCompletions(document, position);
   } else if (lastHashIndex !== -1) {
     // # trigger - provide snippet completions (current behavior)
     return this.getHashCompletions(document, position);
   }
   ```

3. **Split completion methods**:
   - `getAtCompletions()` - Full file references (no line ranges)
     - Insert text: `src/extension.ts` (no `@` prefix in insert text)
     - Documentation: Show `@src/extension.ts` examples
   - `getHashCompletions()` - Current behavior (selections + files with line range support)
     - Keep current `#file:` insert text

4. **Update file completion insert text** in `getFileCompletions()`:

   ```typescript
   // Current (always #file:):
   item.insertText = `file:${relativePath}`;

   // Needed (conditional based on trigger):
   if (triggerChar === "@") {
     item.insertText = relativePath; // Just the path
     item.documentation = `Insert reference:\n\n\`@${relativePath}\``;
   } else {
     item.insertText = `file:${relativePath}`; // Current behavior
     item.documentation = `Insert reference:\n\n\`#file:${relativePath}\``;
   }
   ```

### Phase 2: Migration Tooling (HIGH PRIORITY)

**Goal**: Help users convert existing `#file:path` (full file) to `@path`

**Required Features**:

1. **Code Action Provider**: `PromptSyntaxCodeActionProvider.ts`
   - Detects `#file:path` without line ranges in prompt strings
   - Offers Quick Fix: "Convert to @path syntax"
   - Uses `WorkspaceEdit` to replace `#file:path` → `@path`

2. **Batch Migration Command**: `FlightPath: Migrate Prompt Syntax`
   - Scans workspace for `.prompt.json`, `.flightpath.json`, `.prompt.md`
   - Finds all `#file:path` references without `:line-line`
   - Shows preview tree view before applying
   - Applies changes with undo support

3. **Deprecation Diagnostics**: `PromptSyntaxDiagnostics.ts`
   - Creates `DiagnosticCollection` for prompt files
   - Shows warning on `#file:path` without line ranges
   - Message: "Use @path for full files. #file: is for line ranges."
   - Severity: Warning (not error - still works)

### Phase 3: Documentation & Communication (MEDIUM PRIORITY)

1. Update all templates to use `@path` for full files
2. Add migration guide to README
3. Update CHANGELOG with breaking change notice
4. Update copilot-instructions.md examples

## Related Documentation

- [COPILOT_CLI_DESIGN.md](./COPILOT_CLI_DESIGN.md) - Copilot CLI integration details
- [CLAUDE_CLI_DESIGN.md](./CLAUDE_CLI_DESIGN.md) - Claude CLI integration details
- [CONTEXT_ATTACHMENT_IMPLEMENTATION.md](./CONTEXT_ATTACHMENT_IMPLEMENTATION.md) - Implementation plan for file attachment optimization
- [PromptCompletionProvider.ts](../src/completions/PromptCompletionProvider.ts) - Completion provider implementation

---

## Future Enhancements

### Additional Context Types

**Full Content** (`@` prefix):

- `@workspace:name/path` - Files from specific workspace folder (multi-root workspaces)

**Snippets** (`#` prefix):

- `#git:diff` - Unstaged/staged changes (snippet)
- `#git:commit:hash` - Specific commit diff (snippet)
- `#env:VAR` - Environment variable value (snippet)
- `#setting:path` - VS Code setting value (snippet)
- `#terminal:n` - Terminal output buffer (snippet)
- `#diagnostics` - Current file diagnostics (snippet)
- `#breakpoint:n` - Code at breakpoint location (snippet)

### Smart Context Detection

- Auto-detect relevant files based on prompt keywords
- Suggest symbols when user types class/function names in prompt
- Recommend directory context (`@dir:`) for architectural questions
- Show related files based on import graph

### Snippet Range Improvements

- `#file:path:symbolName` - Auto-resolve symbol to line range
- `#file:path:@function` - Extract specific function (alternative to `#sym:`)
- Smart range expansion (include related code, imports, types)

---

## Version History

| Version | Date       | Changes                                       |
| ------- | ---------- | --------------------------------------------- |
| 1.0     | 2025-12-08 | Initial specification with `@` and `#` syntax |
