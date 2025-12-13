# Context Attachment Implementation Plan

## Overview

This document details the integration-specific optimizations for file attachment behavior in FlightPath CLI integrations (Copilot and Claude).

**Syntax Note**: FlightPath uses `@path` syntax for file references (aligned with CLI standards). See [PROMPT_SYNTAX.md](./PROMPT_SYNTAX.md) for complete syntax reference and design rationale. Legacy `#file:path` syntax is deprecated but temporarily supported during migration.

## Problem Statement

### Current Implementation

FlightPath uses a unified `processPromptAttachments()` method in the base `CopilotIntegration` class that:

1. Parses `#file:path` and `#file:path:line-line` syntax from prompts
2. Reads file content from disk
3. Wraps content in XML `<attachment>` blocks
4. Prepends attachments to the prompt text

**Issues:**

- **Copilot CLI**: `#file:path` syntax doesn't trigger custom instruction discovery (requires `@path` syntax)
- **Claude CLI**: Duplicates file content (XML attachment + Claude's auto-attachment from `@path`)
- **Both**: Line ranges work correctly (neither CLI supports natively)

**Implemented:**

- ✅ `#sym:path/to/file.ts:SymbolName:123` - Symbol-specific code attachment with exact line disambiguation

**Note**: Directory references use `@path\to\directory\` syntax (trailing slash indicates directory). This aligns with Claude's native format and requires no conversion.

See [COPILOT_CLI_DESIGN.md](./COPILOT_CLI_DESIGN.md) for complete documentation on these VS Code Chat features and proposed FlightPath implementations.

### Discovered Behaviors

| CLI        | `@path` File Content  | `@path` Custom Instructions                                           | `#file:path` Recognition |
| ---------- | --------------------- | --------------------------------------------------------------------- | ------------------------ |
| Copilot    | ❌ No (explicit read) | ✅ Yes (`.github/copilot-instructions.md` + conditional folder-level) | ❌ No                    |
| Claude     | ✅ Yes (auto)         | ✅ Partial (only `CLAUDE.md` files, no conditional)                   | ❌ No                    |
| Line Range | ❌ Not supported      | N/A                                                                   | N/A                      |

**Note**: Claude only supports `CLAUDE.md` files (one at root, one per folder). It does NOT support Copilot's `.github/instructions/*.instructions.md` pattern or conditional front matter matching.

## Proposed Solution

### Architecture Changes

**1. Make `processPromptAttachments()` integration-aware**

Move from unified base class implementation to integration-specific overrides:

- Base class provides shared utilities (parsing, path resolution, XML generation)
- Each CLI integration overrides to implement optimal behavior
- Chat integration continues using current implementation (no `@path` support)

**2. Integration-Specific Behaviors**

#### Copilot CLI Integration

```typescript
// CopilotCommandLineIntegration.ts
protected async processPromptAttachments(prompt: string): Promise<string> {
  const fileReferences = this.parseFileReferences(prompt);
  if (fileReferences.length === 0) {
    return prompt;
  }

  const atReferences: string[] = [];
  const xmlAttachments: string[] = [];

  for (const ref of fileReferences) {
    // Use shared base class method for @path conversion
    const atPath = this.convertToAtSyntax(ref.path);

    if (ref.startLine && ref.endLine) {
      // Line range: Use XML attachment only (not supported by @path)
      const xml = await this.buildAttachmentXml(ref.path, ref.startLine, ref.endLine);
      xmlAttachments.push(xml);
    } else {
      // Full file: Use BOTH @path (for instructions) AND XML (for content)
      atReferences.push(atPath);
      const xml = await this.buildAttachmentXml(ref.path);
      xmlAttachments.push(xml);
    }
  }

  // Build final prompt:
  // 1. @path references (triggers custom instructions)
  // 2. XML attachments (provides file content)
  // 3. Original prompt (keeps #file: syntax for LLM context)
  const atSection = atReferences.length > 0
    ? atReferences.join(' ') + '\n\n'
    : '';
  const xmlSection = xmlAttachments.join('\n\n');

  return `${atSection}${xmlSection}\n\n${prompt}`;
}
```

**Why both `@path` and XML for Copilot?**

- `@path`: Triggers custom instruction discovery for referenced files
- XML: Provides actual file content (Copilot doesn't auto-attach content from `@path`)
- Result: Best of both worlds (instructions + content)

#### Claude CLI Integration

```typescript
// ClaudeCommandLineIntegration.ts
protected async processPromptAttachments(prompt: string): Promise<string> {
  const fileReferences = this.parseFileReferences(prompt);
  if (fileReferences.length === 0) {
    return prompt;
  }

  const atReferences: string[] = [];
  const xmlAttachments: string[] = [];

  for (const ref of fileReferences) {
    // Use shared base class method for @path conversion
    const atPath = this.convertToAtSyntax(ref.path);

    if (ref.startLine && ref.endLine) {
      // Line range: Use XML attachment only (not supported by @path)
      const xml = await this.buildAttachmentXml(ref.path, ref.startLine, ref.endLine);
      xmlAttachments.push(xml);
    } else {
      // Full file: Use @path ONLY (Claude auto-attaches content)
      atReferences.push(atPath);
      // NO XML attachment needed - would duplicate content
    }
  }

  // Build final prompt:
  // 1. @path references (auto-attaches content + CLAUDE.md instructions)
  // 2. XML attachments (only for line ranges)
  // 3. Original prompt (keeps #file: syntax for LLM context)
  const atSection = atReferences.length > 0
    ? atReferences.join(' ') + '\n\n'
    : '';
  const xmlSection = xmlAttachments.join('\n\n');

  return `${atSection}${xmlSection}\n\n${prompt}`;
}
```

**Why only `@path` for Claude (no XML)?**

- `@path`: Claude automatically attaches full file content
- `CLAUDE.md`: Only static instruction files (no conditional front matter matching)
- XML: Would duplicate content unnecessarily
- Result: Cleaner prompts, less token usage

#### Chat Integration (No Change)

```typescript
// CopilotChatIntegration.ts
// Keep current implementation from base class
// Chat doesn't support @path syntax, XML attachments work correctly
```

### Base Class Refactoring

**Move to protected utilities in `CopilotIntegration`:**

```typescript
export abstract class CopilotIntegration {
  // ... existing code ...

  /**
   * Process #file: references (integration-specific override point)
   * Default implementation uses XML attachments only (for Chat integration)
   */
  protected async processPromptAttachments(prompt: string): Promise<string> {
    // Default implementation for Chat integration
    const fileReferences = this.parseFileReferences(prompt);
    if (fileReferences.length === 0) {
      return prompt;
    }

    const attachments = await Promise.all(
      fileReferences.map((ref) =>
        this.buildAttachmentXml(ref.path, ref.startLine, ref.endLine)
      )
    );

    const xmlSection = attachments.join("\n\n");
    return `${xmlSection}\n\n${prompt}`;
  }

  /**
   * Parse #file: references (shared utility)
   * PROTECTED - Used by subclass overrides
   */
  protected parseFileReferences(
    prompt: string
  ): Array<{ path: string; startLine?: number; endLine?: number }> {
    // ... existing implementation ...
  }

  /**
   * Build XML attachment (shared utility)
   * PROTECTED - Used by subclass overrides
   */
  protected async buildAttachmentXml(
    filePath: string,
    startLine?: number,
    endLine?: number
  ): Promise<string> {
    // ... existing implementation (move from private to protected) ...
  }

  /**
   * Convert workspace-relative path to @path syntax
   * PROTECTED - SHARED by both Copilot and Claude CLI integrations
   *
   * IMPORTANT: Both CLIs use identical @path format. This is the single
   * source of truth for path conversion used by both CLI integrations.
   */
  protected convertToAtSyntax(filePath: string): string {
    // Remove leading slash/backslash if present
    const normalized = filePath.replace(/^[\/\\]/, "");

    // Platform-specific path separator (use native for consistency)
    // Both CLIs accept either separator, but we use platform-native
    const separator = process.platform === "win32" ? "\\" : "/";
    const pathWithCorrectSeparator = normalized.replace(/[\/\\]/g, separator);

    return `@${pathWithCorrectSeparator}`;
  }
}
```

## Implementation Steps

### Phase 1: Refactor Base Class (No Behavior Change)

**Goal**: Make utilities accessible to subclasses without changing behavior

1. ✅ Move `buildAttachmentXml()` from private to protected
2. ✅ Keep `processPromptAttachments()` as-is (will be overridden by CLI integrations)
3. ✅ Add `convertToAtSyntax()` utility method (SINGLE implementation shared by both CLIs)
4. ✅ Update visibility of `parseFileReferences()` to protected (already is)

**Key insight**: Since both Copilot and Claude CLI use identical `@path` format, `convertToAtSyntax()` is implemented once in the base class and reused by both CLI integrations. No duplication needed!

**Files**:

- `src/flightpath/base/CopilotIntegration.ts`

**Validation**:

- Run existing tests
- Manually test Chat integration (should work unchanged)

### Phase 2: Implement Copilot CLI Override

**Goal**: Add `@path` references + XML attachments for Copilot CLI

1. ✅ Override `processPromptAttachments()` in `CopilotCommandLineIntegration`
2. ✅ Implement dual attachment logic (both `@path` and XML)
3. ✅ Add unit tests for path conversion
4. ✅ Test with manual prompts containing:
   - Single file reference: `#file:README.md`
   - Multiple files: `#file:src/extension.ts` and `#file:package.json`
   - Line range: `#file:src/extension.ts:10-20`
   - Mixed: Full file + line range

**Files**:

- `src/flightpath/cli/CopilotCommandLineIntegration.ts`
- `src/test/suite/copilot-cli-integration.test.ts` (new)

**Validation**:

- Verify custom instructions are loaded (check Copilot output for instruction content)
- Verify file content is included (check XML in prompt)
- Verify line ranges work correctly

### Phase 3: Implement Claude CLI Override

**Goal**: Use `@path` references only (no XML for full files)

1. ✅ Override `processPromptAttachments()` in `ClaudeCommandLineIntegration`
2. ✅ Implement `@path`-only logic for full files
3. ✅ Keep XML attachments for line ranges
4. ✅ Test with same manual prompts as Phase 2

**Files**:

- `src/flightpath/cli/ClaudeCommandLineIntegration.ts`
- `src/test/suite/claude-cli-integration.test.ts` (new)

**Validation**:

- Verify no duplicate content in Claude responses
- Verify custom instructions are loaded
- Verify line ranges work correctly

### Phase 4: Update Documentation

1. ✅ Update `docs/COPILOT_CLI_DESIGN.md` - Context Attachment section
2. ✅ Update `docs/CLAUDE_CLI_DESIGN.md` - Context Attachment section
3. ✅ Create this document: `docs/CONTEXT_ATTACHMENT_IMPLEMENTATION.md`
4. ⬜ Update `docs/CONTEXT_ATTACHMENT.md` if it exists (or create it)
5. ⬜ Update `.github/copilot-instructions.md` with implementation notes

### Phase 5: End-to-End Testing

**Test scenarios:**

1. ⬜ Copilot CLI workflow with file references and custom instructions
2. ⬜ Claude CLI workflow with file references and custom instructions
3. ⬜ Chat workflow (verify no regression)
4. ⬜ Line range handling across all integrations
5. ⬜ Mixed file references (full + line ranges)

## Edge Cases & Considerations

### Path Resolution

- ✅ Handle absolute paths (resolve to workspace-relative)
- ✅ Handle `..\` parent directory references
- ✅ Handle `.\` current directory references
- ✅ Cross-platform path separators (Windows `\` vs Unix `/`)

### Error Handling

- ✅ File not found (skip attachment, log warning, continue)
- ✅ Invalid line range (out of bounds, log warning, continue)
- ✅ Permission errors (log warning, continue)
- ✅ Empty file (include empty attachment)

### Performance

- ✅ Parallel file reads for multiple references
- ✅ Cache file content for duplicate references (optional optimization)
- ⬜ Limit attachment size (warn if file > 100KB?)

### User Experience

- ⬜ Show attachment count in status bar (e.g., "Attached 3 files")
- ⬜ Log attachment details to Output panel when `flightpath.showCliOutput: true`
- ⬜ Provide clear error messages for attachment failures

## Testing Strategy

### Unit Tests

```typescript
// Test parseFileReferences()
describe("parseFileReferences", () => {
  it("should parse full file reference", () => {
    const prompt = "Analyze #file:src/extension.ts please";
    const refs = integration.parseFileReferences(prompt);
    expect(refs).toEqual([{ path: "src/extension.ts" }]);
  });

  it("should parse line range reference", () => {
    const prompt = "Check #file:src/extension.ts:10-20";
    const refs = integration.parseFileReferences(prompt);
    expect(refs).toEqual([
      {
        path: "src/extension.ts",
        startLine: 10,
        endLine: 20,
      },
    ]);
  });

  it("should handle quoted paths", () => {
    const prompt = 'Review #file:"path with spaces.ts"';
    const refs = integration.parseFileReferences(prompt);
    expect(refs).toEqual([{ path: "path with spaces.ts" }]);
  });

  it("should strip trailing punctuation from unquoted paths", () => {
    const prompt = "Can you look at #file:test.md?";
    const refs = integration.parseFileReferences(prompt);
    expect(refs).toEqual([{ path: "test.md" }]);
  });
});

// Test convertToAtSyntax()
describe("convertToAtSyntax", () => {
  it("should convert path to @path syntax", () => {
    const result = integration.convertToAtSyntax("src/extension.ts");
    expect(result).toBe("@src\\extension.ts"); // Windows
  });

  it("should handle leading slash", () => {
    const result = integration.convertToAtSyntax("/src/extension.ts");
    expect(result).toBe("@src\\extension.ts"); // Windows
  });
});
```

### Integration Tests

```typescript
// Test actual file attachment with CLI
describe("CopilotCommandLineIntegration", () => {
  it("should attach file content and custom instructions", async () => {
    const prompt = "Improve #file:src/extension.ts";
    const result = await integration.processPromptAttachments(prompt);

    // Should contain @path reference
    expect(result).toContain("@src\\extension.ts");

    // Should contain XML attachment
    expect(result).toContain('<attachment id="file:src/extension.ts">');

    // Should preserve original prompt
    expect(result).toContain("#file:src/extension.ts");
  });

  it("should handle line ranges with XML only", async () => {
    const prompt = "Check #file:src/extension.ts:10-20";
    const result = await integration.processPromptAttachments(prompt);

    // Should NOT contain @path for line range
    expect(result).not.toContain("@src\\extension.ts:10-20");

    // Should contain XML attachment with line range
    expect(result).toContain("lines 10 to 20");
  });
});

describe("ClaudeCommandLineIntegration", () => {
  it("should use @path only for full files", async () => {
    const prompt = "Improve #file:src/extension.ts";
    const result = await integration.processPromptAttachments(prompt);

    // Should contain @path reference
    expect(result).toContain("@src\\extension.ts");

    // Should NOT contain XML attachment (Claude auto-attaches)
    expect(result).not.toContain('<attachment id="file:src/extension.ts">');

    // Should preserve original prompt
    expect(result).toContain("#file:src/extension.ts");
  });
});
```

### Manual Testing

Create test prompt files in `manual-test/`:

**`test-file-attachments.flightpath.json`**:

```json
{
  "prompts": [
    {
      "prompt": "Summarize the architecture described in #file:docs/ARCHITECTURE.md",
      "model": "claude-sonnet-4.5"
    },
    {
      "prompt": "Explain the error handling in #file:src/extension.ts:45-67",
      "model": "claude-sonnet-4.5"
    },
    {
      "prompt": "Compare #file:src/flightpath/cli/CopilotCommandLineIntegration.ts and #file:src/flightpath/cli/ClaudeCommandLineIntegration.ts",
      "model": "claude-sonnet-4.5"
    }
  ]
}
```

**Test checklist:**

- [ ] Copilot CLI: Verify custom instructions loaded
- [ ] Copilot CLI: Verify file content in responses
- [ ] Claude CLI: Verify no duplicate content
- [ ] Claude CLI: Verify custom instructions loaded
- [ ] Both: Verify line ranges work correctly
- [ ] Chat: Verify no regression (XML attachments still work)

## Success Criteria

- ✅ Copilot CLI receives both custom instructions (`.github/copilot-instructions.md` + folder-level) and file content
- ✅ Claude CLI avoids duplicate content (uses `@path` for file content, `CLAUDE.md` for instructions)
- ✅ Line ranges work consistently across all integrations
- ✅ No regressions in Chat integration
- ✅ Clear documentation of behavior differences
- ⬜ Comprehensive test coverage (unit + integration)
- ⬜ User-facing documentation updated
- ⬜ (Future) Implement Copilot-style instruction system for Claude

## Rollout Plan

1. **Phase 1-2**: Implement and test Copilot CLI changes (low risk, additive)
2. **Phase 3**: Implement Claude CLI changes (medium risk, removes duplication)
3. **Phase 4**: Update documentation
4. **Phase 5**: End-to-end testing and validation
5. **Release**: Include in next minor version (v0.x.0)

## Risks & Mitigation

| Risk                                      | Impact | Mitigation                                         |
| ----------------------------------------- | ------ | -------------------------------------------------- |
| Breaking Chat integration                 | HIGH   | Keep default implementation in base class          |
| Copilot CLI doesn't recognize `@path`     | MEDIUM | Test thoroughly, fallback to XML-only if needed    |
| Claude CLI behavior changes               | MEDIUM | Version documentation, monitor Claude CLI releases |
| Performance degradation (duplicate reads) | LOW    | Implement caching if needed                        |
| Cross-platform path issues                | LOW    | Extensive testing on Windows + Unix                |
| Custom instruction discovery doesn't work | MEDIUM | Manual testing with real instruction files         |

## Future Enhancements

### Custom Instruction System for Claude CLI

**Goal**: Bring Copilot's folder-level instruction system to Claude CLI

**Current limitation**: Claude natively supports only fixed `CLAUDE.md` files (one at root, one per folder). It does NOT natively support:

- Conditional instruction attachment based on front matter
- Multiple instruction files per folder
- The `.github/instructions/*.instructions.md` pattern

**Current state**: Chained `@` references in `CLAUDE.md` (basic file inclusion only)

Claude Code CLI supports `@` syntax for file references in `CLAUDE.md`, and these references can be chained recursively:

1. `CLAUDE.md` includes `@.github/copilot-instructions.md`
2. That file includes `@.github/instructions/ui.instructions.md`
3. Those files are loaded recursively when Claude reads `CLAUDE.md`

**Critical limitation**: This is NOT equivalent to Copilot's conditional inclusion system:

- ❌ No pattern matching based on `applyTo` front matter
- ❌ No selective loading (ALL files in chain are ALWAYS included)
- ❌ No context-awareness (doesn't matter which files you're actually working with)
- ✅ Only provides basic multi-file loading via static reference chain

This makes FlightPath's pattern-based implementation still necessary for intelligent, context-aware instruction loading.

**Proposed automated solution**: FlightPath-managed instruction attachment

1. Parse `.github/instructions/*.instructions.md` files
2. Match `applyTo` front matter against referenced files in prompt
3. Manually prepend matching instruction content to Claude prompts
4. Wrap in XML structure to distinguish from user content

**Example implementation:**

```typescript
// In ClaudeCommandLineIntegration.ts
protected async attachCustomInstructions(
  prompt: string,
  fileReferences: string[]
): Promise<string> {
  const instructionFiles = await this.findMatchingInstructions(fileReferences);
  if (instructionFiles.length === 0) {
    return prompt;
  }

  const instructionBlocks = instructionFiles.map(file =>
    `<customInstruction source="${file.path}">
${file.content}
</customInstruction>`
  );

  return `${instructionBlocks.join('\n\n')}\n\n${prompt}`;
}
```

**Benefits over manual chained references:**

- **Conditional loading** based on `applyTo` front matter (like Copilot) - THE KEY FEATURE
- Only includes relevant instruction files for the files you're working with
- Reduces token usage (doesn't load ALL instructions for EVERY prompt)
- Context-aware and intelligent (not just static file chains)
- No need to manually maintain `CLAUDE.md` index file
- Consistent instruction system across Copilot and Claude
- Single source of truth for project conventions

**Implementation priority**: Medium-High (chained references don't provide conditional/pattern-based inclusion)

**See also**: Consider creating `docs/INSTRUCTION_ATTACHMENT_DESIGN.md` for detailed specification when ready to implement.

---

## Related Documentation

- [PROMPT_SYNTAX.md](./PROMPT_SYNTAX.md) - **Prompt syntax reference and design rationale**
- [COPILOT_CLI_DESIGN.md](./COPILOT_CLI_DESIGN.md) - Copilot CLI reference
- [CLAUDE_CLI_DESIGN.md](./CLAUDE_CLI_DESIGN.md) - Claude CLI reference
- [CONTEXT_ATTACHMENT.md](./CONTEXT_ATTACHMENT.md) - Original design doc (if exists)
- [flightpath-base.instructions.md](../.github/instructions/flightpath-base.instructions.md) - Base integration guidelines
