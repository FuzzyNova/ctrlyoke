# FlightPath Prompt Syntax & Completion Reference

## Overview

FlightPath supports rich context references in prompts using a syntax aligned with CLI standards while adding workspace intelligence features. This document defines the syntax, completion behavior, and migration path.

**Last Updated**: 2026-06-13

---

## ✅ IMPLEMENTATION STATUS

**What's Implemented**:

- ✅ `@` trigger for full file completions (CLI-native syntax)
- ✅ `#` trigger for selection + symbol completions
- ✅ `@path` syntax parsed in all integrations (Copilot CLI, Claude CLI, Chat)
- ✅ `#selection::-` line range support (XML attachments)
- ✅ Selection completions (inserts `file:path:line-line`)
- ✅ Symbol completions (inserts `sym:symbolName`, shows immediately when typing #)
- ✅ Smart filtering (excludes markdown/text/JSON files from symbol results)
- ✅ Dynamic refresh (re-queries as you type, up to 500 symbols)
- ✅ Model completions in "model" field
- ✅ Works in JSON and Markdown prompt files
- ✅ Migration script: `scripts/migrate-prompt-syntax.mjs`
- ✅ `@path/` directory structure references (trailing slash) — completions + runtime XML attachment

**What's NOT Implemented Yet**:

- ❌ Deprecation warnings for legacy `#file:path` without line ranges

**Breaking Change Applied**: `#file:path` for full files is DEPRECATED. Use `@path` instead.
Line ranges (`#selection::-`) continue to use `#file:` syntax.

---

---

## Syntax Reference

### Mental Model

- **`@` = Full Content**: Complete files or directory structures (trailing slash for directories)
- **`#` = Snippets/Excerpts**: Line ranges, selections, symbols

### Full File Attachment: `@path` ✅ IMPLEMENTED

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

**Behavior**:

- **CLI handles natively**: File content auto-attached by Copilot/Claude CLI
- **Path resolution**: Workspace-relative (no leading `/` or `\`)
- **Platform**: Both `@src/file.ts` and `@src\file.ts` work (auto-normalized)

**CLI Integration**:

- Copilot CLI: `@path` triggers `.github/copilot-instructions.md` + folder-level instructions, XML provides content
- Claude CLI: `@path` auto-attaches content + `CLAUDE.md` instructions (no XML duplication)
- Chat mode: `@path` converted to native attachment via `github.copilot.chat.attachFile`
- See [COPILOT_CLI_DESIGN.md](./COPILOT_CLI_DESIGN.md) and [CLAUDE_CLI_DESIGN.md](./CLAUDE_CLI_DESIGN.md) for details

**Important**: CLIs don't support line range syntax. Use `#selection::-` for line ranges.

---

### Directory Structure: `@path\to\directory\` ✅ IMPLEMENTED

**Purpose**: Attach directory structure (file tree, no content)

**Format**:

```
@path/to/directory/           # Directory structure (trailing slash)
@path\to\directory\          # Windows-style also supported
```

**Example**:

```json
{
  "prompt": "Explain the architecture of @src/flightpath/"
}
```

**Behavior**:

- **FlightPath handles**: Detects trailing slash, reads directory tree, wraps in XML attachment
- **No content**: Shows file names and structure only
- **CLI alignment**: Claude natively recognizes `@path/` as directory (no conversion needed)
- Useful for "explain module" or "understand organization" prompts
- **Completions**: Directory paths appear in `@` completions with trailing slash
- **Link navigation**: Ctrl+Click on `@dir/` reveals directory in File Explorer

---

### Snippet Context: `#` prefix

**Purpose**: Attach code excerpts and workspace snippets (FlightPath handles with XML)

#### Line Range: `#selection::-`

**Format**:

```
#selection::-   # Lines 10-20 only
```

**Example**:

```json
{
  "prompt": "Explain the logic in #selection::-"
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
  "prompt": "Optimize #selection::- for better performance"
}
```

**Behavior**:

- **Completion label**: Shows `$(selection) Current Selection` in IntelliSense
- **Inserted text**: `file:path:startLine-endLine` (NOT `selection`)
- **FlightPath processes**: Extracts lines and wraps in XML attachment
- **Important**: `#selection` is NEVER in actual prompts - it's just a UI label

**Note**: There is no `#selection` prompt syntax. The completion provider automatically converts selections to `#selection::-` format.

#### Symbol References: `#sym:path:name:start-end` ✅ FULLY IMPLEMENTED

**Format**:

```
#sym:path/to/file.ts:symbolName:123-123        # Variable, function, class at specific line
#sym:path/to/file.ts:methodName():456-456      # Method with parentheses
```

**Example**:

```json
{
  "prompt": "Refactor #sym:src/flightpath/FlightPathManager.ts:FlightPathManager:42-42 to improve modularity"
}
```

**Behavior**:

- **IntelliSense**: Completion shows workspace symbols as you type
- **Inserted Format**: `sym:path/to/file.ts:SymbolName:123` (path + symbol + line for disambiguation)
- **Resolution**: Uses line number to find exact symbol location (handles duplicate names)
- **Processing**: FlightPath resolves at runtime before sending to CLI/Chat
- **Attachment**: Creates XML attachment with file content at symbol's line range
- **Smart filtering**: Excludes markdown/text/JSON files (focuses on code symbols)
- **Performance**: Shows up to 500 symbols with dynamic refresh

**Implementation Details**:

All integrations (Copilot CLI, Claude CLI, Chat) support symbol resolution:

- `parseSymbolReferences()` extracts `#sym:path:name:start-end` patterns from prompt text
- `resolveSymbol("path:name:line")` queries VS Code's `executeDocumentSymbolProvider`
- Matches both symbol name AND line number for exact disambiguation
- Returns `FileReference` with path, line range, and symbolName
- `buildAttachmentXml()` creates attachment with the full symbol definition

**Disambiguation**:

The line number ensures unique identification when:

- Same symbol name exists in multiple files (e.g., `flightpathDir` in multiple modules)
- Same symbol name appears multiple times in same file (e.g., multiple `execute()` methods)

**Usage**:

- Type `#` → See selections + all symbols
- Type `#Fl` → See selections + symbols matching "Fl"
- Select a symbol → Inserts `sym:src/flightpath/FlightPathManager.ts:FlightPathManager:42`
- FlightPath resolves to actual location and attaches code automatically

#### Directory Context: `@path\to\directory\` _(See Full Content Section)_

**Note**: Directory references belong in the "Full Content" category (use `@` prefix with trailing slash).

See "Directory Structure: `@path\to\directory\`" in the Full Content section above for complete documentation.

---

## Completion Provider Strategy

### Two-Handler Architecture

FlightPath plans to use **two separate completion handlers** to avoid performance issues:

#### Handler 1: `@` Completion (Fast - Full Content) ✅ IMPLEMENTED

**Trigger**: `@` character

**Items**:

- ✅ Workspace files (cached, max 500 items)
- ✅ Directories (trailing slash, sorted before files in the list)

**Performance**:

- File cache: 5-second TTL, refreshed on demand
- Parallel file reads for attachments
- Sorted by path depth (shorter paths first)

**Example completions**:

```
@src/extension.ts                    (file - src/)
@package.json                        (file - Root)
@src/flightpath/                     (directory)
@src/flightpath/PromptQueue.ts       (file - src/flightpath/)
```

#### Handler 2: `#` Completion (Selections + Symbols) ✅ IMPLEMENTED

**Trigger**: `#` character

**Items shown**:

- ✅ Current editor selections (labeled `$(selection) Current Selection`)
  - Inserts `file:path:startLine-endLine` format
- ✅ Workspace symbols matching the typed text (functions, classes, methods, variables)
  - Filters out markdown/text/JSON files (focuses on code symbols only)
  - Dynamic refresh as you type more characters
  - Shows up to 500 symbols (increased from 100)
- ❌ NO file completions (use `@` for full files)

**Behavior**:

- `#` → Shows selections + all symbols
- `#Fl` → Shows selections + symbols matching "Fl" (from TypeScript, JavaScript, Python, etc.)
- `#Flight` → Shows selections + symbols matching "Flight"

**Important Change**: The `#` trigger shows **selections + symbols** immediately. Use `@` for full file completions.

**Example completions**:

```
# (user types #)
$(selection) Current Selection          → inserts: file:src/extension.ts:45-67
$(selection) extension.ts (lines 45-67) → inserts: file:src/extension.ts:45-67

# (user types #Fl) - Shows selections + symbols
$(selection) Current Selection          → inserts: file:src/extension.ts:45-67
FlightPathManager                       → inserts: sym:FlightPathManager
FlightPathDashboardProvider             → inserts: sym:FlightPathDashboardProvider
...more symbols matching "Fl"...

# For full files, use @ instead:
@ (user types @)
extension.ts                            → inserts: src/extension.ts
package.json                            → inserts: package.json

# For line ranges, manually type:
#selection::-           (no completion, user types manually)
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
  "prompt": "Explain #selection::-"
}
```

✅ This is correct - CLIs don't support line ranges, so FlightPath handles them with XML.

**Selections keep current completion behavior**:

- User types `#`, sees `$(selection) Current Selection` in completions
- Completion inserts `file:src/extension.ts:45-67`
- Final prompt: `Optimize #selection::-`

✅ No change needed - `#selection` is just a completion label, not prompt syntax.

### Migration Path

**Status**: ✅ BREAKING CHANGE APPLIED

The migration from `#file:path` to `@path` for full files has been completed.

**What Changed**:

1. ✅ `@path` syntax now works in all integrations (Copilot CLI, Claude CLI, Chat)
2. ✅ `#` completion trigger shows selections only (not files)
3. ✅ Use `@` for file completions, `#` for selections
4. ✅ All templates and manual-test files migrated

**Migration Tooling**:

- ✅ **Migration Script**: `node scripts/migrate-prompt-syntax.mjs`
  - Converts `#file:path` → `@path` (preserves `#selection::-`)
  - Scans `manual-test/`, `src/templates/`, `.flightpath/`
  - Run manually when migrating existing prompts

**Legacy Support**:

- `#file:path` (without line range) still works but is DEPRECATED
- `#selection::-` (with line range) is the correct syntax for line ranges
- Future versions may show deprecation warnings for `#file:path` without line ranges

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

| Syntax Type           | Purpose                  | Who Handles      | Example                                 | Notes                                 |
| --------------------- | ------------------------ | ---------------- | --------------------------------------- | ------------------------------------- |
| `@path`               | Full file content        | CLI (native)     | `@src/extension.ts`                     | CLI attaches entire file              |
| `@path/`              | Full directory structure | FlightPath (XML) | `@src/flightpath/`                      | Trailing slash = directory tree (XML) |
| `#selection::-`       | Line range snippet       | FlightPath (XML) | `#selection::-`                         | Extracts specific lines               |
| `#sym:path:name:start-end` | Symbol snippet           | FlightPath (XML) | `#sym:src/file.ts:FlightPathManager:42-42` | Resolves to exact symbol location     |

**Note**: There is no `#selection` syntax. The completion provider shows `$(selection)` as a label but inserts `file:path:line-line`.

### Performance Considerations

**Problem**: Loading all files + symbols + directories in one completion list is slow (100ms+)

**Solution**: Two handlers with different trigger characters

- `@` → Pre-cached files (instant)
- `#` → Lazy-loaded context (search as you type)

**Result**: Sub-50ms completion latency even in large workspaces

---

## Implementation Status

| Feature                          | Status  | Priority | Notes                                                            |
| -------------------------------- | ------- | -------- | ---------------------------------------------------------------- |
| `@` trigger for file completions | ✅ Done | -        | Workspace files with 5s cache, max 500 items                     |
| `@path` file references          | ✅ Done | -        | Parsed in all integrations (CLI + Chat)                          |
| - ✅ `#` trigger for selections  | ✅ Done | -        | Selections shown when typing `#`                                 |
| - ✅ `#` symbol completions      | ✅ Done | -        | Shows immediately with `#`, filters code files, 500 max          |
| `#selection::-` line ranges      | ✅ Done | -        | Manual typing, XML attachment in all integrations                |
| Selection completions            | ✅ Done | -        | Inserts `file:path:line-line` from editor selections             |
| Symbol completions               | ✅ Done | -        | Inserts `sym:path:name:line`, dynamic refresh as you type        |
| Model completions                | ✅ Done | -        | Dynamic model list in "model" field                              |
| Migration script                 | ✅ Done | -        | `scripts/migrate-prompt-syntax.mjs`                              |
| `@path/` directory refs          | ✅ Done | -        | Completions + runtime XML tree via `buildDirectoryAttachmentXml` |
| `#sym:path:name:start-end` resolution | ✅ Done | -        | Resolves symbols to exact line range using document symbols      |
| Deprecation warnings             | ⬜ TODO | LOW      | Show hints when using `#file:` for full files                    |

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
  "prompt": "Explain the error handling in #selection::-"
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
  "prompt": "Optimize #selection::- for better type safety"
}
```

_User typed `#`, selected "Current Selection" from completions, which inserted `file:src/extension.ts:45-67`_

### Symbol References ✅ IMPLEMENTED

```json
{
  "prompt": "Refactor #sym:src/flightpath/FlightPathManager.ts:executeWorkflow():156-156 to improve error handling"
}
```

_FlightPath resolves symbol location using exact line match, extracts code, wraps in XML_

### Directory Structure ✅ IMPLEMENTED

```json
{
  "prompt": "Explain the architecture of @src/flightpath/ and suggest improvements"
}
```

_Trailing slash indicates directory. FlightPath reads directory tree (no file content), wraps in XML_

### Mixed Content and Snippets

```json
{
  "prompt": "Review @docs/ARCHITECTURE.md and verify that #selection::- follows the documented patterns"
}
```

_Full architecture doc + specific code snippet_

### Directory Structure + Files ✅ IMPLEMENTED

```json
{
  "prompt": "Given the structure in @src/flightpath/ explain how @src/flightpath/FlightPathManager.ts orchestrates the workflow"
}
```

_Directory tree context + specific file content_

---

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

| Version | Date       | Changes                                                              |
| ------- | ---------- | -------------------------------------------------------------------- |
| 1.0     | 2025-12-08 | Initial specification with `@` and `#` syntax                        |
| 2.0     | 2025-12-10 | **IMPLEMENTED**: `@path` completions, CLI integration, migration     |
| 2.1     | 2026-01-12 | Fixed documentation: parsing functions are in FileReferenceParser.ts |
