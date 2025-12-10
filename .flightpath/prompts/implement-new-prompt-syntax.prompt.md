# Implement @path Syntax Migration (Breaking Change)

## Context

FlightPath is migrating from `@path` to `@path` syntax for full file references to align with Copilot CLI and Claude CLI standards. This is a **clean break** - no backward compatibility required (pre-release status).

**Read these first:**

- @docs/PROMPT_SYNTAX.md - Complete syntax specification
- @docs/CONTEXT_ATTACHMENT_IMPLEMENTATION.md - CLI integration details
- @src/flightpath/chat/NativeAttachmentHandler.ts - Chat mode file attachment
- @src/completions/PromptCompletionProvider.ts - IntelliSense implementation

## Migration Rules

### Syntax Changes (Breaking)

**OLD (deprecated, will no longer work):**

```json
{
  "prompt": "Analyze @src/extension.ts"
}
```

**NEW (required):**

```json
{
  "prompt": "Analyze @src/extension.ts"
}
```

**UNCHANGED (line ranges keep #file: prefix):**

```json
{
  "prompt": "Explain @src/extension.ts:45-67"
}
```

### Mental Model

- `@path` = Full file content (CLI handles natively)
- `@path:10-20` = Line range snippet (FlightPath handles with XML)

## Implementation Tasks

### 1. Update NativeAttachmentHandler.ts (Chat Mode)

**File:** `src/flightpath/chat/NativeAttachmentHandler.ts`

**Changes needed:**

```typescript
/** Parse both @path and @path:line-line references */
parseFileReferences(prompt: string): FileReference[] {
  const references: FileReference[] = [];

  // Match @path for full files (no line range support)
  const fullFileRegex = /@([^\s:]+)/g;
  let match;
  while ((match = fullFileRegex.exec(prompt)) !== null) {
    references.push({
      path: match[1],
      // No line range for @path syntax
    });
  }

  // Match @path:startLine-endLine for line ranges
  const lineRangeRegex = /@([^\s:]+):(\d+)-(\d+)/g;
  while ((match = lineRangeRegex.exec(prompt)) !== null) {
    references.push({
      path: match[1],
      startLine: parseInt(match[2], 10),
      endLine: parseInt(match[3], 10),
    });
  }

  return references;
}
```

**Key points:**

- Two separate regex patterns (no overlapping matches)
- `@path` = full file only (no `@path:10-20` support)
- `@path:line-line` = line ranges only
- Native attachment commands remain the same:
  - `github.copilot.chat.attachFile` for `@path`
  - `github.copilot.chat.attachSelection` for `@path:line-line`

### 2. Update PromptCompletionProvider.ts (IntelliSense)

**File:** `src/completions/PromptCompletionProvider.ts`

**Changes needed:**

1. **Add `@` trigger character:**

```typescript
// In extension.ts where provider is registered:
vscode.languages.registerCompletionItemProvider(
  [...],
  provider,
  "#",  // Keep for line ranges
  "@"   // NEW: Add for full files
);
```

2. **Split completion logic by trigger:**

```typescript
async provideCompletionItems(
  document: vscode.TextDocument,
  position: vscode.Position,
  token: vscode.CancellationToken,
  context: vscode.CompletionContext
): Promise<vscode.CompletionList | undefined> {
  // Model completions (unchanged)
  if (this.isInsideModelString(document, position)) {
    return this.getModelCompletions(document, position);
  }

  if (!this.shouldProvideCompletions(document, position)) {
    return undefined;
  }

  const line = document.lineAt(position.line).text;
  const textBeforeCursor = line.substring(0, position.character);

  // Check for @ trigger (full files)
  const lastAtIndex = textBeforeCursor.lastIndexOf("@");
  if (lastAtIndex !== -1) {
    const afterAt = textBeforeCursor.substring(lastAtIndex + 1);
    if (!afterAt.includes(" ")) {
      return this.getFullFileCompletions(afterAt);
    }
  }

  // Check for # trigger (selections + line ranges)
  const lastHashIndex = textBeforeCursor.lastIndexOf("#");
  if (lastHashIndex !== -1) {
    const afterHash = textBeforeCursor.substring(lastHashIndex + 1);
    if (!afterHash.includes(" ")) {
      return this.getSnippetCompletions(afterHash);
    }
  }

  return undefined;
}
```

3. **New method for @ completions:**

```typescript
/** Get completions for @path (full files only) */
private async getFullFileCompletions(filter: string): Promise<vscode.CompletionList> {
  const items: vscode.CompletionItem[] = [];

  // Only workspace files (no selections)
  const workspaceFiles = await this.getWorkspaceFiles();

  for (const fileUri of workspaceFiles) {
    const workspacePath = this.getWorkspaceRelativePath(fileUri);
    if (!workspacePath) continue;

    // Filter by typed text
    if (filter && !workspacePath.toLowerCase().includes(filter.toLowerCase())) {
      continue;
    }

    const item = new vscode.CompletionItem(
      workspacePath,
      vscode.CompletionItemKind.File
    );

    // Insert text WITHOUT @ prefix (user already typed it)
    item.insertText = workspacePath;
    item.detail = `Full file`;
    item.documentation = `Attach entire file: ${workspacePath}`;

    // Sort by path depth (shorter paths first)
    const depth = workspacePath.split(/[/\\]/).length;
    item.sortText = `${depth}_${workspacePath}`;

    items.push(item);
  }

  return new vscode.CompletionList(items, false);
}
```

4. **Update # completions (selections only):**

```typescript
/** Get completions for # prefix (selections and manual line ranges) */
private async getSnippetCompletions(filter: string): Promise<vscode.CompletionList> {
  const items: vscode.CompletionItem[] = [];

  // 1. Add selection completions (unchanged)
  const selectionItems = this.getAllSelectionCompletions();
  items.push(...selectionItems);

  // 2. NO FILE COMPLETIONS for # trigger anymore
  //    Users must use @path for full files
  //    They can manually type @path:10-20 for line ranges

  return new vscode.CompletionList(items, false);
}
```

**Key points:**

- `@` trigger → workspace files only
- `#` trigger → selections only (no file list)
- Users manually type `@path:10-20` for line ranges (no completion needed for line numbers)

### 3. Update Base CopilotIntegration (Already Planned)

**Status:** ✅ Already covered in CONTEXT_ATTACHMENT_IMPLEMENTATION.md Phase 1

No additional changes needed - base class refactoring is already designed.

### 4. Update CLI Integrations (Already Planned)

**Status:** ✅ Already covered in CONTEXT_ATTACHMENT_IMPLEMENTATION.md Phases 2-3

- CopilotCommandLineIntegration: `@path` + XML (both)
- ClaudeCommandLineIntegration: `@path` only (no XML duplication)

### 5. Create Migration Script

**File:** `scripts/migrate-prompt-syntax.mjs` (one-time use, throw-away)

```javascript
#!/usr/bin/env node
import { readFileSync, writeFileSync } from "fs";
import { glob } from "glob";
import { resolve } from "path";

/**
 * One-time migration script: @path → @path (full files only)
 * Keeps @path:10-20 unchanged (line ranges)
 */

const files = glob.sync("manual-test/**/*.{json,md}", {
  cwd: resolve(process.cwd()),
  absolute: true,
});

let totalFiles = 0;
let totalReplacements = 0;

for (const filePath of files) {
  const content = readFileSync(filePath, "utf-8");

  // Replace @path BUT NOT @path:10-20
  // Regex: Match @path where path is NOT followed by :digit
  const newContent = content.replace(/@([^\s:]+)(?!:\d)/g, "@$1");

  if (newContent !== content) {
    writeFileSync(filePath, newContent, "utf-8");
    totalFiles++;

    // Count replacements
    const matches = content.match(/@([^\s:]+)(?!:\d)/g);
    totalReplacements += matches ? matches.length : 0;

    console.log(`✅ ${filePath}`);
  }
}

console.log(`\n📊 Migration complete:`);
console.log(`   Files updated: ${totalFiles}`);
console.log(`   Replacements: ${totalReplacements}`);
console.log(`\n⚠️  Manual review required for:`);
console.log(`   - Prompts in .flightpath/workflows/`);
console.log(`   - Template files in src/templates/`);
```

**Usage:**

```bash
npm install glob  # If not already installed
node scripts/migrate-prompt-syntax.mjs
```

### 6. Update Documentation Status

**Files to update:**

1. **docs/PROMPT_SYNTAX.md**
   - Change all "PLANNED" to "IMPLEMENTED"
   - Update "Implementation Status" table
   - Remove migration timeline (breaking change applied)

2. **.github/copilot-instructions.md**
   - Update syntax examples to use `@path`
   - Document the breaking change
   - Add note about manual-test migration

3. **README.md** (if it has syntax examples)
   - Update to `@path` syntax

### 7. Update Templates

**Files to review and update:**

```bash
src/templates/workflows/*.flightpath.json
src/templates/agents/*.agent.md
```

Replace any `@path` (without line range) with `@path`.

## Testing Plan

### Unit Tests

1. **NativeAttachmentHandler.parseFileReferences()**
   - Test `@path` parsing
   - Test `@path:10-20` parsing
   - Test mixed prompts with both syntaxes
   - Test edge cases (invalid paths, missing line numbers)

2. **PromptCompletionProvider**
   - Test `@` trigger completions
   - Test `#` trigger completions (selections only)
   - Verify no file completions on `#` trigger

### Manual Testing

**Test prompts:**

```json
{
  "prompts": [
    {
      "prompt": "Analyze @src/extension.ts",
      "description": "Full file with @ syntax"
    },
    {
      "prompt": "Explain @src/extension.ts:45-67",
      "description": "Line range with #file: syntax"
    },
    {
      "prompt": "Review @package.json and @README.md:1-10",
      "description": "Mixed: full file + line range"
    }
  ]
}
```

**Test in each mode:**

- ✅ Copilot CLI mode
- ✅ Claude CLI mode
- ✅ Copilot Chat mode

**Verify:**

- File content is attached correctly
- Line ranges extract correct lines
- No duplicate content in any mode
- IntelliSense shows correct completions for `@` and `#`

## Success Criteria

- ✅ `@path` syntax works in all three integration modes
- ✅ `@path:10-20` line ranges still work correctly
- ✅ `@path` (without line range) NO LONGER works (breaking change)
- ✅ IntelliSense shows files on `@` trigger, selections on `#` trigger
- ✅ All manual-test prompts migrated successfully
- ✅ All templates updated to new syntax
- ✅ Documentation reflects implemented status
- ✅ No regressions in existing functionality

## Implementation Order

1. ✅ Run migration script on manual-test files
2. ✅ Update NativeAttachmentHandler.ts
3. ✅ Update PromptCompletionProvider.ts
4. ✅ Update templates (src/templates/)
5. ✅ Update documentation status
6. ✅ Manual testing in all three modes
7. ✅ Commit changes with message: "feat!: migrate to @path syntax for full files (BREAKING)"

## Notes

- This is a **BREAKING CHANGE** - old `@path` syntax will stop working
- Pre-release status means no backward compatibility needed
- Migration script is throw-away (not included in extension)
- Line ranges are UNCHANGED (`@path:line-line` still works)
- `@path:10-20` is NOT supported (CLIs don't support it, use `@` for ranges)
