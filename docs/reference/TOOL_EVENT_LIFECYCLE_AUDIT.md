# Tool Event Lifecycle Audit

**Date:** 2026-02-01
**Purpose:** Determine which CLI tool types need two-event pattern (initiated + completed)
**Status:** Research Complete

## Executive Summary

**Finding:** Only **file operations** (Edit, Write, Read) need the two-event pattern. All other tool types should remain single-event.

**Recommendation:** Rename `FILE_OPERATION_STATUS` to `OPERATION_STATUS` for future extensibility, but keep it scoped to file operations for now.

---

## Current State Analysis

### Tool Types Supported (7 Total)

| Tool Type | Parser Location | Two-Event Support | Result Value |
|-----------|----------------|-------------------|--------------|
| **Bash/Shell** | ClaudeLogParser:178, ClaudeResponseParser:296 | ❌ No (should add) | Exit code, output, error |
| **File Edit** | ClaudeLogParser:200, ClaudeResponseParser:332 | ✅ Yes (INITIATED + COMPLETED) | Diff, patch, success |
| **File Write** | ClaudeLogParser:189, ClaudeResponseParser:317 | ✅ Yes (INITIATED + COMPLETED) | Success, content |
| **File Read** | ClaudeLogParser:212, ClaudeResponseParser:357 | ✅ Yes (INITIATED + COMPLETED) | Content, success |
| **File Delete** | ClaudeLogParser:222 | ❌ No (single event only) | N/A |
| **Web Search** | ClaudeLogParser:231, ClaudeResponseParser:387 | ❌ No (single event only) | Results array |
| **MCP Tools** | ClaudeLogParser:240, ClaudeResponseParser:401 | ❌ No (single event only) | Server-specific |
| **Generic Fallback** | ClaudeLogParser:252, ClaudeResponseParser:420 | ❌ No (single event only) | Tool result |

---

## Detailed Analysis by Tool Type

### 1. Bash/Shell Commands

**Current State:**
```typescript
// ClaudeLogParser.ts:178-188 - tool_use block
if (toolName === "bash" || toolName === "shell") {
  outputEvents.push({
    type: CLI_EVENT_TYPES.BASH_COMMAND,
    timestamp,
    data: {
      command: input.command || "unknown",
      workingDir: input.working_dir || input.cwd,
      status: "in_progress",  // ⚠️ Hardcoded, no completion tracking
    } as BashCommandData,
  });
}
```

**Missing:** No `tool_result` processing for bash commands in ClaudeLogParser.

**BashCommandData Interface:**
```typescript
// CliOutputTypes.ts:172-185
export interface BashCommandData {
  command: string;
  workingDir?: string;
  exitCode?: number;        // ✅ Present
  output?: string;          // ✅ Present
  error?: string;           // ✅ Present
  status?: "in_progress" | "completed" | "failed"; // ✅ Present
}
```

**Problem:**
- Interface already supports two-event pattern (`status`, `exitCode`, `output`, `error`)
- Parser only creates INITIATED event (from `tool_use`)
- Parser never creates COMPLETED event (from `tool_result`)
- Dashboard shows "in_progress" forever, never shows actual output

**Solution Needed:**
Yes - Bash commands have valuable result data (exit code, stdout, stderr) that must be shown.

**Recommendation:**
✅ **ADD two-event pattern** - Parse `tool_result` blocks for bash commands to populate `exitCode`, `output`, `error`, and set `status: "completed"`.

---

### 2. File Edit (Already Implemented Correctly)

**Current State:**
```typescript
// INITIATED event (from tool_use block)
// ClaudeLogParser.ts:200-211
if (toolName === "edit" || toolName === "apply_patch") {
  outputEvents.push({
    type: CLI_EVENT_TYPES.FILE_EDIT,
    timestamp,
    data: {
      path: input.path || "unknown",
      oldContent: input.old_content || input.old_str,
      newContent: input.new_content || input.new_str,
      status: FILE_OPERATION_STATUS.INITIATED,  // ✅ First event
    } as FileEditData,
  });
}

// COMPLETED event (from toolUseResult metadata)
// ClaudeLogParser.ts:314-333
if (oldString && newString) {
  outputEvents.push({
    type: CLI_EVENT_TYPES.FILE_EDIT,
    timestamp,
    data: {
      path: toolUseResult.filePath || "unknown",
      oldContent: oldString,
      newContent: newString,
      structuredPatch: toolUseResult.structuredPatch,  // ✅ Rich diff data
      originalFile: toolUseResult.originalFile,
      userModified: toolUseResult.userModified,
      replaceAll: toolUseResult.replaceAll,
      status: FILE_OPERATION_STATUS.COMPLETED,  // ✅ Second event
      success: true,
    } as FileEditData,
  });
}
```

**Dashboard Rendering:**
```javascript
// output-manager.js:396-422
if (event.data.status === FILE_OPERATION_STATUS.INITIATED) {
  html += "● Editing " + escapeHtml(event.data.path) + " (starting...)";
} else if (event.data.status === FILE_OPERATION_STATUS.FAILED) {
  html += "● Edit failed: " + escapeHtml(event.data.path);
  if (event.data.error) {
    html += " - " + escapeHtml(event.data.error);
  }
} else {
  // Completed or legacy
  html += "● Edited " + escapeHtml(event.data.path);
}

// Only render diff for completed edits
if (event.data.status !== FILE_OPERATION_STATUS.INITIATED &&
    (event.data.structuredPatch || (event.data.oldContent && event.data.newContent))) {
  html += renderDiffVisualization(event.data);
}
```

**Why Two Events Are Essential:**
1. **Progress feedback:** User sees "Editing file.ts (starting...)" immediately
2. **Rich diff data:** `structuredPatch` only available in COMPLETED event (from `toolUseResult`)
3. **Error handling:** Can show "Edit failed: file.ts - Permission denied"
4. **Accurate line numbers:** `structuredPatch` has correct line positions (not available in INITIATED)

**Recommendation:**
✅ **Keep as-is** - This is the gold standard implementation.

---

### 3. File Write (Already Implemented Correctly)

**Current State:**
```typescript
// INITIATED event
// ClaudeLogParser.ts:189-199
if (toolName === "write") {
  outputEvents.push({
    type: CLI_EVENT_TYPES.FILE_WRITE,
    timestamp,
    data: {
      path: input.path || "unknown",
      content: input.content || "",
      status: FILE_OPERATION_STATUS.INITIATED,  // ✅ First event
    } as FileWriteData,
  });
}

// COMPLETED event
// ClaudeLogParser.ts:336-349
if (toolUseResult.type === "create" || toolUseResult.content) {
  outputEvents.push({
    type: CLI_EVENT_TYPES.FILE_WRITE,
    timestamp,
    data: {
      path: toolUseResult.filePath || toolUseResult.path || "unknown",
      content: toolUseResult.content || "",
      status: FILE_OPERATION_STATUS.COMPLETED,  // ✅ Second event
      success: true,
    } as FileWriteData,
  });
}
```

**Dashboard Rendering:**
```javascript
// output-manager.js:429-451
if (event.data.status === FILE_OPERATION_STATUS.INITIATED) {
  html += "● Writing " + escapeHtml(event.data.path) + " (starting...)";
} else if (event.data.status === FILE_OPERATION_STATUS.FAILED) {
  html += "● Write failed: " + escapeHtml(event.data.path);
  if (event.data.error) {
    html += " - " + escapeHtml(event.data.error);
  }
} else {
  html += "● Wrote " + escapeHtml(event.data.path);
  if (event.data.content) {
    html += " (" + event.data.content.length + " bytes)";
  }
}
```

**Why Two Events Are Essential:**
1. **Progress feedback:** User sees "Writing file.ts (starting...)" immediately
2. **Success confirmation:** COMPLETED event confirms file was actually written
3. **Error handling:** Can show "Write failed: file.ts - Disk full"
4. **Content size:** Shows final byte count only after write completes

**Recommendation:**
✅ **Keep as-is** - Correctly implemented.

---

### 4. File Read (Already Implemented Correctly)

**Current State:**
```typescript
// INITIATED event
// ClaudeLogParser.ts:212-221
if (toolName === "read" || toolName === "read_file") {
  outputEvents.push({
    type: CLI_EVENT_TYPES.FILE_READ,
    timestamp,
    data: {
      path: input.path || "unknown",
      status: FILE_OPERATION_STATUS.INITIATED,  // ✅ First event
    } as FileReadData,
  });
}

// COMPLETED event
// ClaudeLogParser.ts:352-362
if (toolUseResult.type === "text" && toolUseResult.file) {
  outputEvents.push({
    type: CLI_EVENT_TYPES.FILE_READ,
    timestamp,
    data: {
      path: toolUseResult.file.filePath || "unknown",
      content: toolUseResult.file.content || "",
      status: FILE_OPERATION_STATUS.COMPLETED,  // ✅ Second event
      success: true,
    } as FileReadData,
  });
}
```

**Dashboard Rendering:**
```javascript
// output-manager.js:454-474
if (event.data.status === FILE_OPERATION_STATUS.INITIATED) {
  html += "● Reading " + escapeHtml(event.data.path) + " (starting...)";
} else if (event.data.status === FILE_OPERATION_STATUS.FAILED) {
  html += "● Read failed: " + escapeHtml(event.data.path);
  if (event.data.error) {
    html += " - " + escapeHtml(event.data.error);
  }
} else {
  html += "● Read " + escapeHtml(event.data.path);
}
```

**Why Two Events Are Essential:**
1. **Progress feedback:** User sees "Reading file.ts (starting...)" immediately
2. **Success confirmation:** COMPLETED event confirms file was actually read
3. **Error handling:** Can show "Read failed: file.ts - File not found"

**Recommendation:**
✅ **Keep as-is** - Correctly implemented.

---

### 5. File Delete (Single Event Only)

**Current State:**
```typescript
// ClaudeLogParser.ts:222-230 - tool_use block only
if (toolName === "delete" || toolName === "delete_file") {
  outputEvents.push({
    type: CLI_EVENT_TYPES.FILE_DELETE,
    timestamp,
    data: {
      path: input.path || "unknown",
    } as FileDeleteData,
  });
}
```

**FileDeleteData Interface:**
```typescript
// CliOutputTypes.ts:272-280
export interface FileDeleteData {
  path: string;
  success?: boolean;   // ❓ Unused - no tool_result processing
  error?: string;      // ❓ Unused - no tool_result processing
}
```

**Dashboard Rendering:**
```javascript
// output-manager.js:477-485
case "fileDelete":
  if (event.data) {
    html += '<div class="output-tool-call-terminal">';
    html += '<div class="tool-call-line">';
    html += "● Delete file: " + escapeHtml(event.data.path);
    html += "</div>";
    html += "</div>\n";
  }
  break;
```

**Analysis:**
- Delete operations are fast (milliseconds)
- No valuable result data to show (file is just gone)
- Interface has `success`/`error` fields but they're never populated
- Dashboard doesn't check `status` or show completion state

**Recommendation:**
❌ **Do NOT add two-event pattern** - Single event is sufficient. Delete is instantaneous and has no useful result data.

**Optional Enhancement:** Could add `FILE_OPERATION_STATUS.INITIATED` if we want consistent UX, but not critical.

---

### 6. Web Search (Single Event Only)

**Current State:**
```typescript
// ClaudeLogParser.ts:231-239 - tool_use block only
if (toolName.includes("search") || toolName === "web_search") {
  outputEvents.push({
    type: CLI_EVENT_TYPES.WEB_SEARCH,
    timestamp,
    data: {
      query: input.query || "",
    } as WebSearchData,
  });
}
```

**WebSearchData Interface:**
```typescript
// CliOutputTypes.ts:298-312
export interface WebSearchData {
  query: string;
  results?: Array<{       // ❓ Unused - no tool_result processing
    title: string;
    url: string;
    snippet?: string;
  }>;
  success?: boolean;      // ❓ Unused
  error?: string;         // ❓ Unused
}
```

**Dashboard Rendering:**
```javascript
// output-manager.js:503-511
case "webSearch":
  if (event.data) {
    html += '<div class="output-tool-call-terminal">';
    html += '<div class="tool-call-line">';
    html += '● Web search: "' + escapeHtml(event.data.query) + '"';
    html += "</div>";
    html += "</div>\n";
  }
  break;
```

**Analysis:**
- Interface has `results` array but it's never populated
- Could show search results in COMPLETED event
- But: Search results are typically very verbose (titles, URLs, snippets)
- Dashboard doesn't have good UX for displaying result lists

**Recommendation:**
⚠️ **Consider adding later** - Two-event pattern would be useful to show search results, but requires UX design for result display. Not critical for MVP.

**Future Enhancement:**
```typescript
// COMPLETED event (future)
{
  type: CLI_EVENT_TYPES.WEB_SEARCH,
  data: {
    query: "FlightPath extension",
    results: [
      { title: "GitHub - FlightPath", url: "...", snippet: "..." },
      // ... more results
    ],
    status: OPERATION_STATUS.COMPLETED,
    success: true,
  }
}
```

---

### 7. MCP Tools (Single Event Only)

**Current State:**
```typescript
// ClaudeLogParser.ts:240-250 - tool_use block only
if (toolName.includes("mcp_") || input.server) {
  outputEvents.push({
    type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
    timestamp,
    data: {
      server: input.server || "unknown",
      tool: toolName,
      parameters: input,
    } as McpToolCallData,
  });
}
```

**McpToolCallData Interface:**
```typescript
// CliOutputTypes.ts:284-294
export interface McpToolCallData {
  server: string;
  tool: string;
  parameters?: Record<string, unknown>;
  result?: ToolResult;    // ❓ Unused - no tool_result processing
}
```

**Dashboard Rendering:**
```javascript
// output-manager.js:488-500
case "mcpToolCall":
  if (event.data) {
    html += '<div class="output-tool-call-terminal">';
    html += '<div class="tool-call-line">';
    html += "● MCP: " + escapeHtml(event.data.server) + "." + escapeHtml(event.data.tool);
    html += "</div>";
    html += "</div>\n";
  }
  break;
```

**Analysis:**
- MCP tools are server-specific (GitHub, Slack, etc.)
- Results vary wildly by tool type
- Interface has `result` field but it's never populated
- Dashboard doesn't show results

**Recommendation:**
⚠️ **Consider adding later** - MCP tool results could be valuable, but each server has different result schemas. Would need custom rendering per MCP server. Not critical for MVP.

**Future Enhancement:**
```typescript
// COMPLETED event (future)
{
  type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
  data: {
    server: "github",
    tool: "search_repositories",
    parameters: { query: "FlightPath" },
    result: {
      success: true,
      output: "Found 5 repositories",  // Generic string
      // OR: structured data per server type
    },
    status: OPERATION_STATUS.COMPLETED,
  }
}
```

---

### 8. Generic Fallback (Single Event Only)

**Current State:**
```typescript
// ClaudeLogParser.ts:252-262 - tool_use block only
// Unknown tool - fallback to generic TOOL_CALL
outputEvents.push({
  type: CLI_EVENT_TYPES.TOOL_CALL,
  timestamp,
  data: {
    name: toolName,
    parameters: input,
    id: contentBlock.id,
  } as ToolCall,
});
```

**ToolCall Interface:**
```typescript
// CliOutputTypes.ts:114-123
export interface ToolCall {
  name: string;
  parameters: Record<string, unknown>;
  id?: string;
  result?: ToolResult;    // ❓ Unused - no tool_result processing
}
```

**Dashboard Rendering:**
```javascript
// output-manager.js:514-539
case "toolCall":
  if (event.data) {
    const toolLine = formatToolCallTerminalStyle(event.data);

    html += '<div class="output-tool-call-terminal">';
    html += '<div class="tool-call-line">' + escapeHtml(toolLine) + "</div>";

    // Add result if available
    if (event.data.result) {
      const resultLine = formatToolResultTerminalStyle(event.data.result);
      const resultClass = event.data.result.success ? "" : " error";
      html += '<div class="tool-result-line' + resultClass + '">' +
              escapeHtml(resultLine) + "</div>";
    }

    html += "</div>\n";
  }
  break;
```

**Analysis:**
- Generic fallback for unknown tools
- Already has `result` field and dashboard renders it
- But: No parser code populates the result field

**Recommendation:**
⚠️ **Low priority** - Generic tools are rare. Could add `TOOL_RESULT` event processing for completeness, but not critical.

---

## Constant Naming Analysis

### Current: `FILE_OPERATION_STATUS`

```typescript
// DashboardConstants.ts:153-157
export const FILE_OPERATION_STATUS = {
  INITIATED: "initiated",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;
```

**Usage:**
- Only used for file operations (Edit, Write, Read)
- Name is accurate and specific
- Clear semantic meaning

**Rename Proposal: `OPERATION_STATUS`**

**Pros:**
- More generic, could apply to Bash, Web Search, MCP tools
- Future-proof if we add two-event pattern to other tools
- Shorter name

**Cons:**
- Less specific (loses "FILE" context)
- Would require renaming all references (40+ files)
- Current name is more self-documenting

**Recommendation:**
⚠️ **Rename for future extensibility** - If we're adding Bash command two-event pattern, rename now to avoid future churn.

**Migration Plan:**
1. Rename constant: `FILE_OPERATION_STATUS` → `OPERATION_STATUS`
2. Update all imports (TypeScript will catch most)
3. Update documentation
4. Keep semantic meaning: "initiated" → "completed" → "failed"

---

## Implementation Priority

### High Priority - Essential Functionality

**1. Bash Commands - Two-Event Pattern**

**Why:** Bash commands are the most common tool type. Users need to see:
- Command execution started
- Exit code (success/failure)
- Stdout output
- Stderr errors

**Implementation Steps:**

1. **Update ClaudeLogParser.ts** - Add `tool_result` processing for bash:

```typescript
// In processUserContent() method, around line 305
if (event.type === "user" && event.toolUseResult) {
  const toolUseResult = event.toolUseResult;

  // Bash command result
  if (toolUseResult.type === "bash" || toolUseResult.command) {
    outputEvents.push({
      type: CLI_EVENT_TYPES.BASH_COMMAND,
      timestamp,
      data: {
        command: toolUseResult.command || "unknown",
        workingDir: toolUseResult.workingDir,
        exitCode: toolUseResult.exitCode,
        output: toolUseResult.output,
        error: toolUseResult.error,
        status: toolUseResult.exitCode === 0 ? "completed" : "failed",
      } as BashCommandData,
    });
  }
}
```

2. **Update ClaudeResponseParser.ts** - Same pattern in `processUserContent()`:

```typescript
// Around line 465
if (toolUseResult.type === "bash" || toolUseResult.command) {
  events.push({
    type: CLI_EVENT_TYPES.BASH_COMMAND,
    timestamp: Date.now(),
    data: {
      command: toolUseResult.command || "unknown",
      workingDir: toolUseResult.workingDir,
      exitCode: toolUseResult.exitCode,
      output: toolUseResult.output,
      error: toolUseResult.error,
      status: toolUseResult.exitCode === 0 ? "completed" : "failed",
    } as BashCommandData,
  });
  return;
}
```

3. **Update output-manager.js** - Dashboard already handles bash status correctly:

```javascript
// output-manager.js:337-370
case "bashCommand":
  if (event.data) {
    const status = event.data.status || "unknown";
    const exitCode = event.data.exitCode !== undefined ? event.data.exitCode : "?";
    const success = exitCode === 0;

    html += '<div class="output-tool-call-terminal">';
    html += '<div class="tool-call-line">';
    html += "● " + escapeHtml(event.data.command);
    html += ' <span class="status-badge ' + (success ? "success" : "error") + '">';
    html += status + " (exit: " + exitCode + ")";
    html += "</span></div>";

    // Show output if available
    if (event.data.output) {
      html += '<div class="tool-output">';
      html += "<pre>" + escapeHtml(event.data.output) + "</pre>";
      html += "</div>";
    }

    // Show error if available
    if (event.data.error) {
      html += '<div class="tool-error">';
      html += "<pre>" + escapeHtml(event.data.error) + "</pre>";
      html += "</div>";
    }

    html += "</div>\n";
  }
  break;
```

**Status:** Dashboard rendering is already correct, just need parser updates.

---

### Medium Priority - Nice to Have

**2. Rename FILE_OPERATION_STATUS → OPERATION_STATUS**

**Why:** Supports Bash two-event pattern, future-proofs for other tools.

**Implementation Steps:**

1. **Update DashboardConstants.ts:**

```typescript
// OLD:
export const FILE_OPERATION_STATUS = {
  INITIATED: "initiated",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

// NEW:
export const OPERATION_STATUS = {
  INITIATED: "initiated",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

// Type alias (for compatibility)
export type OperationStatus = (typeof OPERATION_STATUS)[keyof typeof OPERATION_STATUS];
export type FileOperationStatus = OperationStatus; // Deprecated alias
```

2. **Update all imports** (TypeScript will catch these):
   - `CliOutputTypes.ts` - FileReadData, FileWriteData, FileEditData
   - `ClaudeLogParser.ts` - All file operation events
   - `ClaudeResponseParser.ts` - All file operation events
   - `output-manager.js` - All file operation rendering

3. **Update BashCommandData interface:**

```typescript
// CliOutputTypes.ts:172-185
export interface BashCommandData {
  command: string;
  workingDir?: string;
  exitCode?: number;
  output?: string;
  error?: string;
  status?: OperationStatus;  // Use new generic constant
}
```

---

### Low Priority - Future Enhancement

**3. Web Search Two-Event Pattern**

**Blocked by:** Need UX design for search result display.

**4. MCP Tool Two-Event Pattern**

**Blocked by:** Need per-server result schema and rendering logic.

**5. Generic Tool Result Processing**

**Blocked by:** Need `TOOL_RESULT` event handling in parsers.

---

## Testing Checklist

After implementing Bash two-event pattern:

- [ ] **Bash Command (Success)**
  - [ ] Verify INITIATED event shows "● git status (in_progress)"
  - [ ] Verify COMPLETED event shows "● git status (completed, exit: 0)"
  - [ ] Verify stdout output appears in `<pre>` block
  - [ ] Verify no stderr shown on success

- [ ] **Bash Command (Failure)**
  - [ ] Verify INITIATED event shows "● git bad-command (in_progress)"
  - [ ] Verify COMPLETED event shows "● git bad-command (failed, exit: 1)"
  - [ ] Verify stderr output appears in error block with red styling
  - [ ] Verify exit code is non-zero

- [ ] **File Edit (Regression Test)**
  - [ ] Verify INITIATED event shows "● Editing file.ts (starting...)"
  - [ ] Verify COMPLETED event shows "● Edited file.ts"
  - [ ] Verify diff renders with accurate line numbers
  - [ ] Verify no regression in existing functionality

- [ ] **File Write (Regression Test)**
  - [ ] Verify INITIATED event shows "● Writing file.ts (starting...)"
  - [ ] Verify COMPLETED event shows "● Wrote file.ts (1234 bytes)"
  - [ ] Verify no regression in existing functionality

- [ ] **File Read (Regression Test)**
  - [ ] Verify INITIATED event shows "● Reading file.ts (starting...)"
  - [ ] Verify COMPLETED event shows "● Read file.ts"
  - [ ] Verify no regression in existing functionality

---

## Code Examples

### Pattern 1: Tool Use (INITIATED Event)

```typescript
// ClaudeLogParser.ts - tool_use block processing
if (contentBlock.type === "tool_use") {
  const toolName = contentBlock.name;
  const input = contentBlock.input || {};

  if (toolName === "bash" || toolName === "shell") {
    outputEvents.push({
      type: CLI_EVENT_TYPES.BASH_COMMAND,
      timestamp,
      data: {
        command: input.command || "unknown",
        workingDir: input.working_dir || input.cwd,
        status: OPERATION_STATUS.INITIATED,  // ✅ First event
      } as BashCommandData,
    });
  }
}
```

### Pattern 2: Tool Result (COMPLETED Event)

```typescript
// ClaudeLogParser.ts - toolUseResult metadata processing
if (event.type === "user" && event.toolUseResult) {
  const toolUseResult = event.toolUseResult;

  // Bash command result
  if (toolUseResult.type === "bash" || toolUseResult.command) {
    outputEvents.push({
      type: CLI_EVENT_TYPES.BASH_COMMAND,
      timestamp,
      data: {
        command: toolUseResult.command || "unknown",
        workingDir: toolUseResult.workingDir,
        exitCode: toolUseResult.exitCode,
        output: toolUseResult.output,
        error: toolUseResult.error,
        status: toolUseResult.exitCode === 0
          ? OPERATION_STATUS.COMPLETED  // ✅ Second event (success)
          : OPERATION_STATUS.FAILED,     // ✅ Second event (failure)
      } as BashCommandData,
    });
  }
}
```

### Pattern 3: Dashboard Rendering

```javascript
// output-manager.js - Bash command rendering
case "bashCommand":
  if (event.data) {
    const status = event.data.status || "unknown";
    const exitCode = event.data.exitCode !== undefined ? event.data.exitCode : "?";
    const success = exitCode === 0;

    // Show command with status badge
    html += '<div class="output-tool-call-terminal">';
    html += '<div class="tool-call-line">';
    html += "● " + escapeHtml(event.data.command);
    html += ' <span class="status-badge ' + (success ? "success" : "error") + '">';
    html += status + " (exit: " + exitCode + ")";
    html += "</span></div>";

    // Show output/error only for COMPLETED events
    if (status === "completed" || status === "failed") {
      if (event.data.output) {
        html += '<div class="tool-output">';
        html += "<pre>" + escapeHtml(event.data.output) + "</pre>";
        html += "</div>";
      }

      if (event.data.error) {
        html += '<div class="tool-error">';
        html += "<pre>" + escapeHtml(event.data.error) + "</pre>";
        html += "</div>";
      }
    }

    html += "</div>\n";
  }
  break;
```

---

## Summary Table

| Tool Type | Current Events | Should Have | Parser Update Needed | Dashboard Update Needed |
|-----------|---------------|-------------|---------------------|------------------------|
| **Bash** | 1 (initiated only) | 2 (initiated + completed) | ✅ Yes - Add tool_result processing | ❌ No - Already correct |
| **File Edit** | 2 (initiated + completed) | 2 | ❌ No - Already correct | ❌ No - Already correct |
| **File Write** | 2 (initiated + completed) | 2 | ❌ No - Already correct | ❌ No - Already correct |
| **File Read** | 2 (initiated + completed) | 2 | ❌ No - Already correct | ❌ No - Already correct |
| **File Delete** | 1 (single event) | 1 | ❌ No - Correct | ❌ No - Correct |
| **Web Search** | 1 (single event) | 1 (maybe 2 later) | ⚠️ Future enhancement | ⚠️ Future enhancement |
| **MCP Tools** | 1 (single event) | 1 (maybe 2 later) | ⚠️ Future enhancement | ⚠️ Future enhancement |
| **Generic Fallback** | 1 (single event) | 1 | ❌ No - Correct | ❌ No - Correct |

---

## Conclusion

**Immediate Action Required:**
1. ✅ Add Bash command two-event pattern (high priority, parser updates only)
2. ✅ Rename `FILE_OPERATION_STATUS` → `OPERATION_STATUS` (medium priority, clean refactor)

**No Action Needed:**
- File operations (Edit, Write, Read) - Already correct
- File Delete - Single event is appropriate
- Web Search - Defer until UX design available
- MCP Tools - Defer until server-specific rendering designed
- Generic Fallback - Low usage, low priority

**Key Insight:**
Only operations with **valuable, non-trivial result data** (exit codes, output, diffs) benefit from two-event pattern. Fast, simple operations (Delete) should stay single-event.
