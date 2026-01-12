# Context Attachment Research

## Overview

This document captures research findings on programmatically attaching files and selections to GitHub Copilot Chat in VS Code.

**Status**: ✅ Implemented (2025-11-12)  
**Conclusion**: Dual strategy implementation

- CLI mode: XML attachment (reliable, works perfectly)
- Chat mode: Native attachments (clean UI, user-configurable with fallback to XML)

---

## Available Commands

### 1. `github.copilot.chat.attachFile`

**Purpose**: Attach entire files to Copilot Chat context

**Parameters**:

- Accepts one or more `vscode.Uri` objects
- Can pass multiple files in a single call

**Usage**:

```typescript
await vscode.commands.executeCommand(
  "github.copilot.chat.attachFile",
  Uri1,
  Uri2,
  Uri3
);
```

**Source**: [GitHub Issue #239703](https://github.com/microsoft/vscode/issues/239703)

**Test Results**: ✅ Successfully attaches files to chat context

**Limitations**:

- Only attaches entire files, not specific line ranges
- No way to specify line numbers or ranges as parameters

---

### 2. `github.copilot.chat.attachSelection`

**Purpose**: Attach the current editor selection to Copilot Chat context

**Parameters**:

- ❌ **No parameters** - only uses current editor selection
- Cannot pass Uri, Range, or Location objects

**Usage**:

```typescript
// Must have active editor with selection first
const editor = vscode.window.activeTextEditor;
editor.selection = new vscode.Selection(
  new vscode.Position(startLine, 0),
  new vscode.Position(endLine, 0)
);

// Then attach the selection
await vscode.commands.executeCommand("github.copilot.chat.attachSelection");
```

**Test Results**: ✅ Successfully attaches selected lines to chat context

**Limitations**:

- Requires opening the file in an editor
- Requires setting the editor selection manually
- No way to pass file path + line range as parameters
- Clunky workflow for automation

---

### 3. `workbench.action.chat.attachSelection`

**Purpose**: Alternative command for attaching selections

**Parameters**:

- Same as `github.copilot.chat.attachSelection`
- ❌ **No parameters** - only uses current editor selection

**Difference**:

- Likely just an alias or different command path
- Behavior appears identical to `github.copilot.chat.attachSelection`

---

## Implementation Strategy for FlightPath

### Problem

We want to support multiple context reference syntaxes in prompt files:

- `@path/to/file` - Full file references (CLI-native)
- `@path/to/dir/` - Directory structure (trailing slash)
- `#file:path:line-line` - Exact line ranges to attach
- `#sym:path:symbol:line` - Symbol references (resolves to definition)

However:

1. VS Code commands don't support passing line ranges directly to `attachSelection`
2. Multiple `#selection` attachments have a bug (see `copilot_selection_bug.md`) - only the last one is included
3. Copilot CLI doesn't support programmatic file attachments via commands

### Solution: Dual Strategy Based on Integration Mode

**Two Approaches Implemented**:

1. **XML Attachment (CLI mode & Chat fallback)**: Construct the attachment XML format that Copilot expects and prepend it to the prompt text.
   - ✅ Works with Copilot CLI, Claude CLI, Codex CLI
   - ✅ Reliable - no VS Code bugs
   - ✅ Supports multiple file ranges
   - ✅ Supports symbol references with line resolution
   - ✅ Supports directory structure listings
   - ✅ Automatic deduplication of attachments
   - ❌ Shows raw XML text in Chat UI (clunky appearance)

2. **Native Attachments (Chat mode with setting enabled)**: Use VS Code's `attachFile`, `attachSelection`, and `attachFolder` commands.
   - ✅ Clean UI in Chat window
   - ✅ Native VS Code experience
   - ⚠️ Subject to VS Code bugs (multiple selections)
   - ❌ Not available in CLI mode

**User Control**: The `flightpath.chatUseNativeAttachments` setting (default: true) allows users to choose their preferred method for Chat mode.

**Copilot's Internal Attachment Format**:

````xml
<attachment id="file:path:startLine-endLine">
Excerpt from path, lines startLine to endLine:
```language
[file content]
````

</attachment>
```

**Benefits**:

- ✅ Works around VS Code's multiple selection bug
- ✅ Compatible with Copilot CLI (no command dependency)
- ✅ No need to open files or manipulate editor state
- ✅ Full control over attachment content
- ✅ Can attach multiple line ranges reliably

**Implementation**:

```typescript
async function buildAttachmentXml(
  filePath: string,
  startLine?: number,
  endLine?: number
): Promise<string> {
  const uri = vscode.Uri.file(filePath);
  const doc = await vscode.workspace.openTextDocument(uri);

  // Determine language for syntax highlighting
  const language = doc.languageId;

  // If no line range, attach entire file
  if (!startLine || !endLine) {
    const content = doc.getText();
    return `<attachment id="file:${filePath}">
File: ${filePath}
\`\`\`${language}
${content}
\`\`\`
</attachment>`;
  }

  // Extract line range (convert to 0-indexed)
  const start = new vscode.Position(startLine - 1, 0);
  const end = new vscode.Position(endLine - 1, Number.MAX_SAFE_INTEGER);
  const range = new vscode.Range(start, end);
  const content = doc.getText(range);

  return `<attachment id="file:${filePath}:${startLine}-${endLine}">
Excerpt from ${filePath}, lines ${startLine} to ${endLine}:
\`\`\`${language}
${content}
\`\`\`
</attachment>`;
}
```

### Workflow Sequence

1. **Parse prompt for all context references**
   - Uses unified `parseAllFileReferences()` from `FileReferenceParser.ts`
   - Parses `@path`, `@path/dir/`, `#file:path:lines`, `#sym:path:symbol:line`

2. **Resolve symbol references to file locations**
   - Symbol refs use VS Code's Document Symbol API to find definitions

3. **Build attachment XML for each reference in parallel**:

   ```typescript
   const attachmentPromises = fileReferences.map((ref) =>
     this.buildAttachmentForReference(ref).catch((err) => {
       Log.error(`Failed to attach ${ref.path}:`, err);
       return null; // Skip failed attachments
     })
   );

   const attachments = await Promise.all(attachmentPromises);
   ```

4. **Deduplicate attachments** (same file/range only attached once)

5. **Construct final prompt**:

   ```typescript
   const attachmentsSection = validAttachments.join("\n\n");
   const finalPrompt = `${attachmentsSection}\n\n${promptText}`;
   ```

6. **Keep all references in prompt text** (provides positional context to LLM)

7. **Send the final prompt** with attachments prepended

---

## User Experience Considerations

### Keep Context References in Prompt Text

**Decision**: **ALWAYS keep context reference syntax in the prompt text**

**⚠️ CRITICAL: NEVER REMOVE CONTEXT REFERENCES FROM PROMPT TEXT**

This applies to ALL reference types (`@path`, `#file:path:lines`, `#sym:path:symbol`) in **BOTH** XML attachment mode and native attachment mode.

**Rationale**:

- ✅ Matches Copilot's native behavior (Copilot keeps references in prompts)
- ✅ Provides LLM with contextual references about WHERE in the prompt you're discussing specific code
- ✅ Makes prompts self-documenting and easier to understand
- ✅ Helps LLM correlate prompt text with attached code sections
- ✅ Useful for debugging and understanding prompt intent
- ✅ **Enables sequential/ordered references**: Users can write prompts like "Look at this first: #file:A:1-10 then read this: #file:B:20-30"

**Example 1 - Simple Reference**:

````xml
<attachment id="file:src/app.ts:45-67">
Excerpt from src/app.ts, lines 45 to 67:
```typescript
[code here]
````

</attachment>

Fix the bug in #file:src/app.ts:45-67 where the event handler leaks memory [TOOL_INSTRUCTION]

```

**Example 2 - Sequential References (CRITICAL USE CASE)**:
```

Look at this line first: #file:CopilotChatIntegration.ts:695-696
and then only after that, read this other line #file:CopilotChatIntegration.ts:697-697

````

Without the `#file:` references in the prompt text, the sequential instruction makes no sense - the LLM wouldn't know which attachment to look at first or second.

**Why this matters**: The `#file:` reference in the prompt text tells the LLM "when I say 'the bug', I'm specifically referring to the code in src/app.ts lines 45-67". Without it, the LLM has to infer which attachment you're discussing.

**Implementation**: Do NOT remove `#file:` syntax from prompt text - keep it as-is whether using XML attachments or native attachments.

---

## Performance & UX Optimizations

### File Reading Performance

**Challenge**: Need to read file content to build attachment XML

**Optimizations**:
1. **Use `vscode.workspace.openTextDocument()`**: Efficient file reading with caching
2. **Parallel processing**: Read all files concurrently using `Promise.all()`
3. **Error handling**: Gracefully skip missing/unreadable files
4. **Path resolution**: Cache workspace root to avoid repeated lookups

**Example**:
```typescript
async function processAllAttachments(
  fileReferences: Array<{ path: string; startLine?: number; endLine?: number }>
): Promise<string[]> {
  // Process all files in parallel
  const attachmentPromises = fileReferences.map(ref =>
    buildAttachmentXml(ref.path, ref.startLine, ref.endLine)
      .catch(err => {
        console.error(`Failed to attach ${ref.path}:`, err);
        return null; // Skip failed attachments
      })
  );

  const attachments = await Promise.all(attachmentPromises);
  return attachments.filter(a => a !== null) as string[];
}
````

### No Editor Manipulation Required

**Benefit**: Unlike the command-based approach, this method doesn't require:

- Opening files in editor tabs
- Setting selections
- Managing editor focus
- Adding delays for UI state

This makes the attachment process **instantaneous and invisible to the user**.

---

## Code Implementation Location

### XML Attachment (CLI mode & Chat fallback)

**Location**: `src/utils/ContextExpander.ts`

**Key Class**: `ContextExpander`

**Key Method**: `expandContext(promptText: string): Promise<string>`

**Responsibility**:

1. Parse prompt for all reference types using `FileReferenceParser`
2. Resolve relative paths to absolute workspace paths
3. Resolve symbol references to file locations
4. Read file content for each reference in parallel
5. Build attachment XML blocks with deduplication
6. **Keep reference syntax in prompt text** (do NOT remove)
7. Prepend attachments to prompt
8. Return final prompt string ready to send

**File Reference Parsing**:

**Location**: `src/utils/FileReferenceParser.ts`

**Key Functions**:

- `parseAllFileReferences(prompt): FileReference[]` - Unified parser for all reference types
- `parseAtReferences(prompt): FileReference[]` - Parses @path references
- `parseFileReferences(prompt): FileReference[]` - Parses #file:path:line-line references
- `parseSymbolReferences(prompt): FileReference[]` - Parses #sym:path:symbol:line references

**ContextExpander Helper Methods** (private):

- `resolveSymbolReferences()` - Resolves #sym: references to file locations
- `buildAttachmentForReference()` - Builds XML with deduplication
- `buildAttachmentXml()` - Creates XML attachment block
- `resolveWorkspacePath()` - Converts to absolute path

### Chat Integration - Native Attachments

**Location**: `src/flightpath/chat/NativeAttachmentHandler.ts`

**Key Class**: `NativeAttachmentHandler`

**Key Method**: `processAttachments(prompt: string): Promise<string>`

**CopilotChatIntegration Override**:

**Location**: `src/flightpath/chat/CopilotChatIntegration.ts`

**Method**: `buildPromptText(prompt: PromptItem): Promise<string>`

**Responsibility**:

1. Check `chatUseNativeAttachments` setting
2. If enabled:
   - Delegate to `NativeAttachmentHandler.processAttachments()`
   - For each reference:
     - Whole file: Use `github.copilot.chat.attachFile` command
     - Directory: Use `workbench.action.chat.attachFolder` command
     - Line range: Open file, set selection, use `github.copilot.chat.attachSelection`
   - **KEEP reference syntax in prompt text** (provides sequential/positional context)
   - Return original prompt unchanged
3. If disabled:
   - Fall back to XML attachment via `ContextExpander`

**Workflow Sequence** (Native Attachments):

```typescript
1. Parse all references via FileReferenceParser
2. Resolve symbol references to file locations
3. For each reference:
   - Resolve absolute path
   - If directory:
     await vscode.commands.executeCommand('workbench.action.chat.attachFolder', uri)
   - If whole file:
     await withFocusedDocument(uri, async () => {
       await vscode.commands.executeCommand('github.copilot.chat.attachFile')
     })
   - If line range:
     await withFocusedDocument(uri, async (editor) => {
       editor.selection = new vscode.Selection(startLine, 0, endLine, MAX_INT)
       await vscode.commands.executeCommand('github.copilot.chat.attachSelection')
     })
4. Keep reference syntax in prompt (CRITICAL for context)
5. Return original prompt text unchanged
```

---

## User Settings

### `flightpath.autoAttachFiles` (boolean, default: true)

Enables/disables automatic file attachment for all modes. When disabled, prompts are sent as-is without processing `#file:` references.

### `flightpath.chatUseNativeAttachments` (boolean, default: true)

**Chat mode only** - Controls attachment method:

- **Enabled (default)**: Uses VS Code's native `attachFile` and `attachSelection` commands
  - ✅ Clean chat UI
  - ✅ Native VS Code experience
  - ⚠️ Subject to VS Code's multiple selection bug
  - ✅ Keeps `#file:` references in prompt text (provides positional context)

- **Disabled**: Uses XML attachment method (same as CLI mode)
  - ✅ Reliable - no VS Code bugs
  - ✅ Supports multiple file ranges
  - ❌ Shows raw XML in chat (clunky appearance)
  - ✅ Keeps `#file:` references in prompt text (provides positional context)

**When to disable**: If you encounter issues with multiple file attachments or prefer the XML approach for consistency with CLI mode.

---

## Testing Notes

**Test Command**: `FlightPath Test: Test File Attachment Commands`

**Test Results**:

- ✅ `github.copilot.chat.attachFile` works with Uri objects
- ✅ `github.copilot.chat.attachSelection` works with current selection
- ✅ Multiple files can be attached in one call
- ✅ Attachments appear in Copilot Chat UI with file names
- ✅ Line ranges show as selections in attached context

**Edge Cases to Handle**:

- File doesn't exist → Show error, skip attachment
- Invalid line range → Clamp to file bounds
- File already open → Reuse editor, update selection
- Workspace not open → Cannot resolve relative paths

---

## Alternative Approaches Considered

### ❌ Using VS Code Attachment Commands

**Why not**:

- `attachSelection` has a bug - only last selection is included when using multiple
- Requires opening files and manipulating editor state
- Not compatible with Copilot CLI
- Clunky user experience with visible tab switching

### ❌ Using `#file:path:line` Chat Context Syntax Directly

**Why not**: While Copilot Chat supports `#file:` syntax when users type it manually, programmatically inserted text with this syntax doesn't trigger the same attachment mechanism reliably.

### ❌ Using Language Model API Directly

**Why not**: VS Code Language Model API doesn't expose Copilot Chat's attachment mechanism. It's designed for custom chat participants, not for automating the Copilot Chat UI.

### ❌ Using Clipboard Tricks

**Why not**: Too unreliable and would interfere with user's clipboard.

### ✅ Manual Attachment XML Construction (CHOSEN)

**Why yes**:

- Works around VS Code bugs
- No editor manipulation required
- Compatible with both VS Code extension and CLI
- Complete control over format
- Matches Copilot's internal format exactly
- Fast and invisible to user

---

## Future Enhancements

### If VS Code Adds Parameters to `attachSelection`

If future VS Code API versions allow passing Uri + Range to `attachSelection`:

```typescript
// Hypothetical future API
await vscode.commands.executeCommand(
  "github.copilot.chat.attachSelection",
  uri,
  new vscode.Range(startLine, 0, endLine, 0)
);
```

This would eliminate the need to open files and set selections manually.

### Feature Request Potential

Consider filing a feature request with VS Code team to add parameters to `attachSelection` command for programmatic use cases.

---

## Related Documentation

- [PROMPT_SYNTAX.md](./PROMPT_SYNTAX.md) - Complete reference syntax documentation
- [FlightPath Types](../src/types/FlightPathTypes.ts) - PromptItem interface
- [FileReferenceParser](../src/utils/FileReferenceParser.ts) - Reference parsing logic
- [ContextExpander](../src/utils/ContextExpander.ts) - XML attachment building

---

## Summary

**What Works**:

- ✅ Manual attachment XML construction via `ContextExpander`
- ✅ Multiple file attachments with automatic deduplication
- ✅ Full files, line ranges, directory listings, and symbol references
- ✅ Compatible with Copilot CLI, Claude CLI, Codex CLI, and Chat modes
- ✅ Native attachments for Chat mode (cleaner UI)

**What Doesn't Work**:

- ❌ VS Code `attachSelection` command (bug with multiple selections)
- ❌ Passing line ranges as parameters to attach commands
- ❌ Programmatic selection attachment without opening files

**Chosen Implementation Path**:

- Parse all context references using unified `FileReferenceParser`
- Resolve symbol references to file locations using VS Code's Document Symbol API
- Read file content directly via VS Code workspace API
- Build Copilot's internal attachment XML format with deduplication
- Prepend attachments to prompt before sending
- **Keep reference syntax in prompt body** (provides positional context)
- No editor manipulation required (for CLI mode)

**Key Advantages**:

- 🚀 **Fast**: Parallel file reading, no editor operations
- 🐛 **Bug-free**: Avoids VS Code's multiple selection bug
- 🎯 **Reliable**: Direct control over attachment format
- 🔧 **CLI-ready**: Works with all CLI integrations
- 👻 **Invisible**: No visible UI changes during attachment
- 🔄 **Deduplicated**: Same content never attached twice

**Implementation Status**: ✅ **Complete**

All features fully implemented:

- `ContextExpander` class for XML-based attachments
- `FileReferenceParser` for unified reference parsing
- `NativeAttachmentHandler` for Chat mode native attachments
- Support for `@path`, `@dir/`, `#file:path:lines`, `#sym:path:symbol:line`
- `flightpath.autoAttachFiles` and `flightpath.chatUseNativeAttachments` settings
