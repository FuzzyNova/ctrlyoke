# Prompt Link Provider Implementation Plan

## Overview

Add clickable links to FlightPath prompt files (.prompt.md, .flightpath.yaml, .flightpath.json) that allow users to navigate back to referenced code, directories, symbols, and selections. This complements the existing `PromptCompletionProvider` by making context references bidirectional - not just insert, but also navigate.

## Research Summary

### VS Code DocumentLink API

VS Code provides the `DocumentLinkProvider` API for creating clickable links in documents:

```typescript
interface DocumentLinkProvider {
  provideDocumentLinks(
    document: TextDocument,
    token: CancellationToken
  ): ProviderResult<DocumentLink[]>;

  resolveDocumentLink?(
    link: DocumentLink,
    token: CancellationToken
  ): ProviderResult<DocumentLink>;
}

class DocumentLink {
  range: Range; // Where the link appears in the document
  target?: Uri; // Where the link navigates to
  tooltip?: string; // Hover text (shows "Ctrl+Click to follow link")
}
```

**Key Features:**

- Works in any text document (JSON, Markdown, etc.)
- Supports Ctrl+Click (Cmd+Click on Mac) to navigate
- Automatic hover tooltips with "Ctrl+Click to follow link" instruction
- Can resolve links lazily (two-phase: provide → resolve)

### VS Code URI Scheme for File Navigation

VS Code uses the `vscode://file/` URI scheme for opening files with line/column positioning:

**Format:** `vscode://file/{absolute-path}:line:column`

**Examples:**

```
vscode://file/c:/myProject/package.json
vscode://file/c:/myProject/package.json:5:10
vscode://file//Users/nathan/project/src/app.ts:42:1
```

**Behavior:**

- Opens file in editor
- Navigates to specific line (1-based)
- Optionally navigates to specific column (1-based)
- Works across all VS Code instances
- **Note:** On Windows, drive letters work without `file:///` prefix

**Alternative (command-based):**
For more control, we can use `vscode.open` command with `vscode.Uri.file()` and selection ranges.

## Architecture

### Component: PromptLinkProvider

**Location:** `src/completions/PromptLinkProvider.ts`

**Purpose:**

- Scan prompt files for context references (@file, @dir/, #file:path:line-line, #sym:...)
- Convert references to clickable `DocumentLink` objects with proper URIs
- Handle workspace-relative path resolution

**Relationship to PromptCompletionProvider:**

- **Completion** = Insert context references (user types @ or #)
- **Link** = Navigate to context sources (user Ctrl+Click on inserted reference)
- Both use similar pattern matching logic
- Both need workspace-relative path resolution

### Pattern Detection

We need to detect and linkify these 4 context reference patterns:

#### 1. Full File Reference: `@path/to/file.ts`

**Pattern:** `@[^\s@#]+\.[a-zA-Z]+` (@ followed by path with extension, no whitespace)

**Examples:**

```
@src/extension.ts
@docs/ARCHITECTURE.md
@.github/copilot-instructions.md
```

**Link Target:** `vscode://file/{workspaceRoot}/{relativePath}`

**Navigation:** Opens file at top

---

#### 2. Directory Reference: `@path/to/dir/`

**Pattern:** `@[^\s@#]+/` (@ followed by path ending with /)

**Examples:**

```
@src/ui/
@docs/
@.github/instructions/
```

**Link Target:** VS Code command to reveal in Explorer: `command:revealInExplorer?${encodeURIComponent(JSON.stringify(uri))}`

**Navigation:** Shows directory in File Explorer sidebar

**Alternative:** Could also open a folder picker or file tree view

---

#### 3. Line Range/Selection Reference: `#file:path:10-20`

**Pattern:** `#file:([^\s:]+):(\d+)-(\d+)` (captures path, startLine, endLine)

**Examples:**

```
#file:src/extension.ts:42-56
#file:docs/ARCHITECTURE.md:100-150
```

**Link Target:** `vscode://file/{workspaceRoot}/{relativePath}:{startLine}:1`

**Navigation:** Opens file and selects line range (if possible)

**Enhancement:** For true selection, we may need to use `vscode.open` command with `selection` parameter:

```typescript
vscode.commands.executeCommand("vscode.open", uri, {
  selection: new vscode.Range(startLine - 1, 0, endLine - 1, Number.MAX_VALUE),
});
```

---

#### 4. Symbol Reference: `#sym:path:symbolName:line`

**Pattern:** `#sym:([^\s:]+):([^:]+):(\d+)` (captures path, symbolName, line)

**Examples:**

```
#sym:src/extension.ts:activate:14
#sym:src/flightpath/base/CopilotIntegration.ts:cancelImplementation:284
```

**Link Target:** `vscode://file/{workspaceRoot}/{relativePath}:{line}:1`

**Navigation:** Opens file at symbol definition line

**Enhancement:** Could use `vscode.executeDefinitionProvider` to jump to exact symbol location

---

## Implementation Details

### 1. Create PromptLinkProvider Class

```typescript
// src/completions/PromptLinkProvider.ts
import * as vscode from "vscode";
import * as path from "path";

/**
 * Provides clickable links for FlightPath context references
 *
 * Supported patterns:
 * - @path/to/file.ts       → Open file
 * - @path/to/dir/          → Reveal directory
 * - #file:path:10-20       → Open file with line selection
 * - #sym:path:symbol:42    → Open file at symbol line
 */
export class PromptLinkProvider implements vscode.DocumentLinkProvider {
  // Regex patterns for detecting context references
  private readonly patterns = {
    // @file.ext (no trailing slash, has extension)
    fullFile: /@([^\s@#]+\.[a-zA-Z0-9]+)/g,

    // @dir/ (trailing slash)
    directory: /@([^\s@#]+\/)/g,

    // #file:path:10-20 (line range)
    lineRange: /#file:([^\s:]+):(\d+)-(\d+)/g,

    // #sym:path:symbol:42 (symbol reference)
    symbol: /#sym:([^\s:]+):([^:]+):(\d+)/g,
  };

  provideDocumentLinks(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): vscode.DocumentLink[] | undefined {
    // Only provide links for prompt files
    if (!this.isPromptFile(document)) {
      return undefined;
    }

    const links: vscode.DocumentLink[] = [];
    const text = document.getText();
    const workspaceRoot = this.getWorkspaceRoot();

    if (!workspaceRoot) {
      return undefined; // No workspace, can't resolve relative paths
    }

    // 1. Detect full file references (@file.ext)
    links.push(...this.findFileLinks(document, text, workspaceRoot));

    // 2. Detect directory references (@dir/)
    links.push(...this.findDirectoryLinks(document, text, workspaceRoot));

    // 3. Detect line range references (#file:path:10-20)
    links.push(...this.findLineRangeLinks(document, text, workspaceRoot));

    // 4. Detect symbol references (#sym:path:symbol:42)
    links.push(...this.findSymbolLinks(document, text, workspaceRoot));

    return links;
  }

  private isPromptFile(document: vscode.TextDocument): boolean {
    const fileName = path.basename(document.fileName);
    return (
      fileName.endsWith(".flightpath.yaml") ||
      fileName.endsWith(".flightpath.json") ||
      fileName.endsWith(".prompt.md") ||
      document.languageId === "prompt" ||
      document.languageId === "markdown"
    );
  }

  private getWorkspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
  }

  private findFileLinks(
    document: vscode.TextDocument,
    text: string,
    workspaceRoot: string
  ): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];
    const pattern = new RegExp(this.patterns.fullFile);
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      const relativePath = match[1];
      const startPos = document.positionAt(match.index);
      const endPos = document.positionAt(match.index + match[0].length);
      const range = new vscode.Range(startPos, endPos);

      // Resolve to absolute path
      const absolutePath = path.join(workspaceRoot, relativePath);
      const fileUri = vscode.Uri.file(absolutePath);

      const link = new vscode.DocumentLink(range, fileUri);
      link.tooltip = `Open ${relativePath}`;
      links.push(link);
    }

    return links;
  }

  private findDirectoryLinks(
    document: vscode.TextDocument,
    text: string,
    workspaceRoot: string
  ): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];
    const pattern = new RegExp(this.patterns.directory);
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      const relativePath = match[1];
      const startPos = document.positionAt(match.index);
      const endPos = document.positionAt(match.index + match[0].length);
      const range = new vscode.Range(startPos, endPos);

      // Resolve to absolute path
      const absolutePath = path.join(workspaceRoot, relativePath);
      const dirUri = vscode.Uri.file(absolutePath);

      // Use command URI to reveal in Explorer
      const commandUri = vscode.Uri.parse(
        `command:revealInExplorer?${encodeURIComponent(JSON.stringify(dirUri.toString()))}`
      );

      const link = new vscode.DocumentLink(range, commandUri);
      link.tooltip = `Reveal ${relativePath} in File Explorer`;
      links.push(link);
    }

    return links;
  }

  private findLineRangeLinks(
    document: vscode.TextDocument,
    text: string,
    workspaceRoot: string
  ): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];
    const pattern = new RegExp(this.patterns.lineRange);
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      const relativePath = match[1];
      const startLine = parseInt(match[2], 10);
      const endLine = parseInt(match[3], 10);

      const startPos = document.positionAt(match.index);
      const endPos = document.positionAt(match.index + match[0].length);
      const range = new vscode.Range(startPos, endPos);

      // Resolve to absolute path
      const absolutePath = path.join(workspaceRoot, relativePath);
      const fileUri = vscode.Uri.file(absolutePath);

      // Use custom command to open with selection
      const commandUri = vscode.Uri.parse(
        `command:flightpath.openFileWithSelection?${encodeURIComponent(
          JSON.stringify({ uri: fileUri.toString(), startLine, endLine })
        )}`
      );

      const link = new vscode.DocumentLink(range, commandUri);
      link.tooltip = `Open ${relativePath} at lines ${startLine}-${endLine}`;
      links.push(link);
    }

    return links;
  }

  private findSymbolLinks(
    document: vscode.TextDocument,
    text: string,
    workspaceRoot: string
  ): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];
    const pattern = new RegExp(this.patterns.symbol);
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      const relativePath = match[1];
      const symbolName = match[2];
      const line = parseInt(match[3], 10);

      const startPos = document.positionAt(match.index);
      const endPos = document.positionAt(match.index + match[0].length);
      const range = new vscode.Range(startPos, endPos);

      // Resolve to absolute path
      const absolutePath = path.join(workspaceRoot, relativePath);
      const fileUri = vscode.Uri.file(absolutePath);

      // Open at specific line (symbol definition)
      const fileUriWithLine = vscode.Uri.parse(`${fileUri.toString()}#${line}`);

      const link = new vscode.DocumentLink(range, fileUriWithLine);
      link.tooltip = `Go to ${symbolName} in ${relativePath}:${line}`;
      links.push(link);
    }

    return links;
  }
}
```

### 2. Register Custom Command for Selection Opening

```typescript
// In extension.ts, add command registration:

// Command: Open file with line selection
context.subscriptions.push(
  vscode.commands.registerCommand(
    "flightpath.openFileWithSelection",
    async (args: { uri: string; startLine: number; endLine: number }) => {
      try {
        const fileUri = vscode.Uri.parse(args.uri);
        const document = await vscode.workspace.openTextDocument(fileUri);
        const editor = await vscode.window.showTextDocument(document);

        // Select the line range (convert to 0-based)
        const selection = new vscode.Range(
          args.startLine - 1,
          0,
          args.endLine - 1,
          Number.MAX_SAFE_INTEGER
        );

        editor.selection = new vscode.Selection(selection.start, selection.end);
        editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to open file: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  )
);
```

### 3. Register Link Provider in extension.ts

```typescript
// In extension.ts activate() function:

// Register link provider for prompt files
const promptLinkProvider = new PromptLinkProvider();
context.subscriptions.push(
  vscode.languages.registerDocumentLinkProvider(
    promptFilePatterns, // Reuse same patterns as completion provider
    promptLinkProvider
  )
);
console.log("FlightPath: Registered link provider for prompt files");
```

## Testing Strategy

### Manual Testing

Create test files in `.flightpath/prompts/`:

**test-links.prompt.md:**

```markdown
Test all 4 link types:

1. Full file: @src/extension.ts
2. Directory: @src/ui/
3. Line range: #file:src/completions/PromptCompletionProvider.ts:25-40
4. Symbol: #sym:src/flightpath/FlightPathManager.ts:initialize:50

Should all be Ctrl+Clickable!
```

**test-links.flightpath.yaml:**

```json
{
  "prompt": "Test links: @src/extension.ts @docs/ #file:src/extension.ts:10-20 #sym:src/extension.ts:activate:14",
  "model": "claude-sonnet-4.5"
}
```

### Test Cases

1. **File link** - Verify Ctrl+Click opens file at top
2. **Directory link** - Verify Ctrl+Click reveals folder in Explorer
3. **Line range link** - Verify Ctrl+Click opens file with lines selected
4. **Symbol link** - Verify Ctrl+Click navigates to symbol line
5. **Invalid path** - Verify error message when file doesn't exist
6. **No workspace** - Verify links don't appear when no workspace is open
7. **JSON vs Markdown** - Verify links work in both file types
8. **Multiple links** - Verify multiple links on same line work independently

### Automated Testing

Add unit tests in `src/test/suite/`:

```typescript
// test/suite/promptLinkProvider.test.ts
describe("PromptLinkProvider", () => {
  it("should detect @file references", () => {
    // Test pattern matching
  });

  it("should detect @dir/ references", () => {
    // Test directory pattern
  });

  it("should detect #file:path:10-20 references", () => {
    // Test line range pattern
  });

  it("should detect #sym:path:symbol:42 references", () => {
    // Test symbol pattern
  });

  it("should create correct URIs for each type", () => {
    // Test URI generation
  });
});
```

## Edge Cases & Considerations

### 1. Path Resolution

- **Workspace-relative:** Always resolve relative to workspace root
- **Absolute paths:** Handle gracefully (rare in prompt files)
- **Windows paths:** Support both `/` and `\` separators
- **Path with spaces:** Ensure proper handling of paths like `@manual-test/directory with spaces/file.txt`

### 2. File Existence

- **Missing files:** Links should still appear but show error on click
- **No workspace:** Don't show links when no workspace is open
- **External files:** Consider supporting links to files outside workspace (future)

### 3. Regex Overlap Prevention

- **Order matters:** Check patterns in order to avoid false matches
- **Boundary detection:** Use word boundaries to avoid partial matches
- **Escaped characters:** Handle `\@` and `\#` as literal characters (future)

### 4. Performance

- **Large files:** Limit link detection to reasonable file sizes (<1MB)
- **Regex efficiency:** Use compiled regex patterns, not inline
- **Caching:** Consider caching links if document hasn't changed

### 5. JSON String Context

- **Inside strings only:** In JSON files, only detect links inside "prompt" string values
- **Escape sequences:** Handle JSON escape sequences (`\"`, `\\`)

## Future Enhancements

### Phase 2 Features

1. **Hover preview:** Show file preview on hover (before click)
2. **Go to definition:** For symbols, use actual symbol resolution instead of line number
3. **Bidirectional navigation:** Add "Find References" from source files back to prompt files
4. **Multi-workspace:** Support links across multiple workspace folders
5. **External links:** Support `https://` links to documentation
6. **Relative paths:** Support `../` relative path navigation

### Phase 3 Features

1. **Code lens:** Show inline "Referenced in N prompts" above functions/classes
2. **Breadcrumbs:** Show prompt context in breadcrumb navigation
3. **Minimap marks:** Highlight linked lines in minimap
4. **Peek definition:** Show file preview in peek window

## Integration with Existing Code

### Synergy with PromptCompletionProvider

Both providers should share:

- **Pattern detection logic** - Extract to shared utility module
- **Path resolution** - Centralize workspace path handling
- **File validation** - Common file existence checks

### Synergy with AttachmentBuilders

The `AttachmentBuilders` utility already resolves file paths. We can reuse:

- `resolveFilePath()` - For workspace-relative path resolution
- `validateFilePath()` - For checking file existence

### Separation of Concerns

- **CompletionProvider** = Insert context references (write operation)
- **LinkProvider** = Navigate to context sources (read operation)
- Both use same syntax, but serve different purposes

## Summary

The `PromptLinkProvider` adds navigation capabilities to FlightPath prompt files by:

1. **Detecting** 4 types of context references using regex patterns
2. **Converting** them to clickable `DocumentLink` objects with proper URIs
3. **Enabling** Ctrl+Click navigation back to source code
4. **Complementing** the existing completion provider for a complete workflow

This creates a bidirectional relationship between prompts and code:

- **Write:** Use completions to insert context references
- **Read:** Use links to navigate back to referenced code

**Implementation Effort:** ~6-8 hours

- Core implementation: 3-4 hours
- Testing & debugging: 2-3 hours
- Documentation: 1 hour

**Priority:** Medium-High (Nice UX improvement, not critical for core functionality)
