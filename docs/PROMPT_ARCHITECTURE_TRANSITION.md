# Prompt Architecture Transition Plan

## Overview

This document outlines the architectural transition from **runtime context injection** to **design-time context resolution** for FlightPath prompt files.

**Project Status**: Pre-release - No backward compatibility required. This is a clean break from current implementation.

### Current Architecture (Runtime Context Injection)
```
JSON File (simple prompt) → Runtime Parser → Add Context → Send to Copilot
                                ↓
                         buildCopilotChatPrompt()
                         - Resolves #file patterns
                         - Adds @workspace
                         - Adds #selection
                         - Detects slash commands
                         - Appends TOOL_INSTRUCTION
```

### Target Architecture (Design-Time Context Resolution)
```
Prompt Editor UI → User adds context → Generates JSON (final form) → Send directly to Copilot
                        ↓                                                    ↓
                  Context resolution                              Append TOOL_INSTRUCTION only
                  - Resolve selections → #file:path:line-line
                  - Resolve file patterns → #file:path
                  - Add context variables (@workspace, etc.)
                  - Add slash commands
```

## Key Principle

**JSON files should contain prompts in their final, ready-to-send form** (minus the `TOOL_INSTRUCTION` which is always appended at runtime).

## Current State Analysis

### Files Involved
- `CopilotIntegration.ts` - Contains `buildCopilotChatPrompt()` method (lines 858-918)
- `PromptFileParser.ts` - Parses and validates JSON files
- `prompt-schema.json` - JSON Schema for prompt files
- `FlightPathTypes.ts` - Type definitions for `PromptItem` and `ContextConfig`

### Current Context Processing Logic (TO BE REMOVED)

The `buildCopilotChatPrompt()` method currently handles:

1. **Workspace Context (`@workspace`)**
   - Triggered by: `context.includeWorkspaceFiles` array
   - Adds `@workspace` keyword + resolves file patterns
   
2. **File References (`#file:path`)**
   - Triggered by: `context.includeCurrentFile` boolean
   - Resolves active editor file path
   
3. **Selection Context (`#selection`)**
   - Triggered by: `context.includeSelection` boolean
   - Adds `#selection` keyword
   
4. **Slash Command Detection**
   - Analyzes prompt text for keywords (fix, explain, create, test)
   - Prepends appropriate slash command (/fix, /explain, /new, /tests)
   
5. **Final Assembly**
   - Format: `[slash command] [context variables] [prompt text] [TOOL_INSTRUCTION]`

### Current JSON Schema `context` Object (TO BE REMOVED)

```json
{
  "context": {
    "includeCurrentFile": boolean,
    "includeSelection": boolean,
    "includeWorkspaceFiles": string[]
  }
}
```

## Transition Plan

### Phase 1: Remove Context Configuration (Immediate)

**Goal**: Remove the `context` object entirely, treat prompts as final text.

#### Changes Required

1. **CopilotIntegration.ts** - `buildCopilotChatPrompt()` method
   - Remove lines 858-918 (workspace, file, selection, slash command logic)
   - Simplify to: `prompt.prompt + TOOL_INSTRUCTION`
   - Keep only the TOOL_INSTRUCTION appending logic

2. **Update JSON Schema** - `prompt-schema.json`
   - **Remove `context` object entirely** (no backward compatibility needed)
   - Update examples to show final-form prompts
   - Simplify schema structure

3. **Update Type Definitions** - `FlightPathTypes.ts`
   - **Remove `ContextConfig` interface** (clean break)
   - Remove `context` property from `PromptItem`
   - Document that prompts are in final form

4. **Documentation Updates**
   - Update README.md with new prompt format examples
   - Update QUICK_START.md with final-form prompt examples
   - Update example prompt files

#### Example: Current vs. New Format

**Current Format (Runtime Resolution):**
```json
{
  "prompt": "Analyze the performance issues",
  "context": {
    "includeCurrentFile": true,
    "includeSelection": true,
    "includeWorkspaceFiles": ["**/*.ts"]
  }
}
```

**New Format (Final Form):**
```json
{
  "prompt": "/fix @workspace #file:src/app.ts #file:src/utils.ts #file:src/performanceMonitor.ts:45-120 Analyze the performance issues and suggest optimizations"
}
```

### Phase 2: Prompt Editor UI (Future Enhancement)

**Goal**: Build a visual editor that helps users construct final-form prompts.

#### UI Components

1. **Prompt Text Editor**
   - Rich text editor for prompt content
   - Syntax highlighting for Copilot variables (@, #, /)

2. **Context Insertion Tools**
   - **File Picker**: Browse and insert `#file:path` references
   - **Selection Capture**: Insert `#file:path:line#-line#` for current selection
   - **Workspace Toggle**: Add/remove `@workspace` keyword
   - **Slash Command Dropdown**: Select from `/fix`, `/explain`, `/new`, `/tests`

3. **Preview Panel**
   - Live preview of final prompt text
   - Token count estimation
   - Validation indicators

4. **JSON Export**
   - Save as `.prompt.json` (single prompt)
   - Save as `.flightpath.json` (workflow with multiple prompts)
   - Include metadata (name, description, tags)

#### UI Flow

```
┌─────────────────────────────────────────────────────────┐
│            FlightPath Prompt Editor                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Toolbar:  [/Fix ▼] [@workspace] [#File] [#Selection]  │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Prompt Text Editor                              │   │
│  │                                                 │   │
│  │ /fix @workspace #file:src/app.ts:45-67         │   │
│  │                                                 │   │
│  │ Fix the memory leak in the event handler       │   │
│  │                                                 │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  Preview:                                               │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Final Prompt (339 tokens)                       │   │
│  │                                                 │   │
│  │ /fix @workspace #file:src/app.ts:45-67         │   │
│  │ Fix the memory leak in the event handler       │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  [Save as prompt.json]  [Add to Workflow]              │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

#### Context Resolution Features

1. **File Reference Resolution**
   - File picker with workspace file tree
   - Drag-and-drop from VS Code Explorer
   - Auto-format: `#file:relative/path/to/file.ext`

2. **Selection Context Resolution**
   - Capture current editor selection
   - Always resolve to `#file:path:startLine-endLine` format
   - Never use generic `#selection` - always use specific line ranges
   - Preview of selected code in editor

3. **Workspace Context**
   - Simple toggle for `@workspace` keyword
   - Optional: file pattern filtering UI
   - Optional: exclude patterns

4. **Slash Command Selection**
   - Dropdown with descriptions:
     - `/fix` - Fix errors or issues
     - `/explain` - Explain code or concepts
     - `/new` - Create new code or files
     - `/tests` - Generate or fix tests
   - Auto-suggest based on prompt keywords

### Phase 3: Enhanced JSON Schema (Future)

**Goal**: Support richer metadata and workflow composition.

#### Extended Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "FlightPath Prompt Schema v2",
  "type": "object",
  "properties": {
    "version": {
      "type": "string",
      "description": "Schema version",
      "const": "2.0"
    },
    "metadata": {
      "type": "object",
      "properties": {
        "name": { "type": "string" },
        "description": { "type": "string" },
        "author": { "type": "string" },
        "tags": { "type": "array", "items": { "type": "string" } },
        "createdAt": { "type": "string", "format": "date-time" }
      }
    },
    "prompt": {
      "type": "string",
      "description": "Final-form prompt text (ready to send)"
    },
    "endCondition": {
      "$ref": "#/definitions/endCondition"
    }
  },
  "required": ["version", "prompt"]
}
```

#### Benefits of Metadata

- **Discoverability**: Search prompts by name, tags, description
- **Organization**: Categorize prompts (debugging, refactoring, documentation)
- **Sharing**: Export/import prompt libraries
- **Analytics**: Track prompt usage and effectiveness

## Implementation Roadmap

### Phase 1: Core Simplification (✅ COMPLETED)

**Priority**: HIGH  
**Complexity**: LOW  
**Impact**: Foundation for future work  
**Completed**: 2025-11-02

- [x] Remove context processing from `buildCopilotChatPrompt()`
- [x] Remove `context` from JSON schema (clean break)
- [x] Remove `ContextConfig` interface from types
- [x] Update documentation with new prompt format
- [x] Update all example prompt files to final-form format

### Phase 2: Prompt Editor UI (Weeks 2-4)

**Priority**: MEDIUM  
**Complexity**: HIGH  
**Impact**: User experience transformation

#### Milestone 1: Basic Editor (Week 2)
- [ ] Create WebView-based editor panel
- [ ] Implement basic text editor with syntax highlighting
- [ ] Add file picker for `#file:` insertion
- [ ] Add slash command dropdown

#### Milestone 2: Context Tools (Week 3)
- [ ] Implement selection capture (convert to `#file:path:line-line`)
- [ ] Add @workspace toggle
- [ ] Build live preview panel
- [ ] Add validation and error indicators

#### Milestone 3: JSON Export (Week 4)
- [ ] Implement save as `.prompt.json`
- [ ] Implement save as `.flightpath.json` (multi-prompt workflow)
- [ ] Add prompt library browser (list existing prompts)
- [ ] Add quick-edit functionality for existing prompts

### Phase 3: Enhanced Metadata (Week 5+)

**Priority**: LOW  
**Complexity**: MEDIUM  
**Impact**: Long-term organization and sharing

- [ ] Extend JSON schema with metadata fields
- [ ] Add metadata editor in UI
- [ ] Implement search/filter by tags and descriptions
- [ ] Build export/import for prompt libraries
- [ ] Add prompt templates/snippets

## Migration Note

**No migration needed** - FlightPath is pre-release. Any existing test/example prompt files will be updated directly to the new format.

## Benefits of New Architecture

### For Users

1. **Transparency**: See exactly what will be sent to Copilot
2. **Control**: No hidden context injection or transformations
3. **Reusability**: Prompts work consistently regardless of current editor state
4. **Version Control**: Prompts are self-contained and git-friendly

### For Developers

1. **Simplicity**: Remove complex runtime context resolution logic
2. **Testability**: Prompts are deterministic (no editor state dependency)
3. **Maintainability**: Single source of truth (JSON file)
4. **Extensibility**: Easy to add new context types in editor UI

### For FlightPath Evolution

1. **Foundation for Prompt Library**: Shareable, portable prompts
2. **Template System**: Create reusable prompt patterns
3. **Prompt Marketplace**: Community-shared prompts (future)
4. **Analytics**: Track prompt effectiveness with consistent format

## Technical Considerations

### Prompt Text Storage

- **Encoding**: UTF-8 for all JSON files
- **Line Breaks**: Preserve `\n` in prompt text for readability
- **Escaping**: Proper JSON string escaping for special characters
- **Size Limits**: Warn if prompt exceeds token limits (~4K for context)

### Context Reference Syntax

Follow Copilot Chat conventions:

- `@workspace` - Workspace-wide context
- `#file:path/to/file.ext` - File reference (entire file)
- `#file:path/to/file.ext:line` - Specific line
- `#file:path/to/file.ext:startLine-endLine` - Line range (preferred for selections)
- `/fix`, `/explain`, `/new`, `/tests` - Slash commands

**Note**: Never use `#selection` in final-form prompts. Always resolve to specific file:line-line format.

### Editor UI Technology Stack

- **WebView**: VS Code WebView API for custom UI
- **Framework**: React or Svelte for component-based UI
- **Messaging**: WebView ↔ Extension Host communication
- **State**: Local storage for draft prompts
- **Validation**: Real-time validation against JSON schema

## Testing Strategy

### Unit Tests

- Prompt parsing without context injection
- TOOL_INSTRUCTION appending
- JSON schema validation
- Migration tool logic

### Integration Tests

- Send final-form prompts to Copilot
- Verify context variables work correctly
- Test slash commands
- Test file references and line ranges

### UI Tests

- Prompt editor interactions
- File picker functionality
- Selection capture accuracy
- JSON export validation

### Format Tests

- Validate new final-form prompt format parsing
- Test various prompt structures (slash commands, context variables, etc.)
- Ensure TOOL_INSTRUCTION appending works correctly

## Success Metrics

### Phase 1 (Core Simplification)
- ✅ All existing functionality works with simplified code
- ✅ No regression in prompt execution
- ✅ Documentation updated and clear

### Phase 2 (Prompt Editor)
- ✅ Users can create final-form prompts in UI
- ✅ Context insertion is intuitive and accurate
- ✅ JSON export produces valid, ready-to-use files

### Phase 3 (Enhanced Metadata)
- ✅ Prompt library is discoverable and organized
- ✅ Users share and import prompts successfully
- ✅ Analytics provide insight into prompt effectiveness

## Open Questions

1. **Should we support prompt variables/templates?**
   - Example: `"prompt": "Fix {{selectedComponent}} to use hooks"`
   - Resolution: User-defined placeholders replaced at runtime
   - Decision: Defer to future enhancement

2. **How to handle dynamic file lists?**
   - Example: All TypeScript files in current directory
   - Resolution: Editor UI resolves at design-time, not runtime
   - Decision: File picker shows resolved list

3. **Should prompts include Copilot model preferences?**
   - Example: `"model": "gpt-4"` in JSON
   - Resolution: Future extension, not in v1
   - Decision: Defer until Copilot API supports model selection

4. **Prompt versioning strategy?**
   - Example: Track changes to prompt text over time
   - Resolution: Git handles versioning for now
   - Decision: Future enhancement (prompt history in UI)

## Conclusion

This architectural transition moves FlightPath from **implicit runtime magic** to **explicit design-time clarity**. By storing prompts in their final, ready-to-send form, we:

- Simplify the codebase
- Improve user control and transparency
- Enable powerful future features (editor UI, libraries, sharing)
- Make a clean break for better architecture

The three-phase approach allows incremental delivery with a solid foundation from Phase 1.

---

**Document Status**: Phase 1 Complete  
**Phase 1 Completed**: 2025-11-02  
**Owner**: FlightPath Team  
**Last Updated**: 2025-11-02
