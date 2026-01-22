# CLI Log Parsing & Output Formatting Standardization Plan

## Overview

**Goal:** Create a unified, structured format for CLI output across all three providers (Copilot CLI, Claude CLI, Codex CLI) that enables rich dashboard visualization of tool calls, thinking blocks, and metadata.

**Problem Statement:**
Currently, each CLI provider has different log formats and the parsers handle events inconsistently:
- **Copilot**: Doesn't build `thinkingBlocks` array, only prefixes reasoning text
- **Claude**: `extractContentFromEvent()` skips thinking blocks during streaming
- **Codex**: Stores `reasoningBlocks` in metadata instead of top-level, has two tool call formats
- **Dashboard**: Receives raw text strings with no structured data for tool calls or thinking

**Target State:**
- Single `UniversalCliOutput` interface used across all providers
- Complete event handlers in all parsers (no missing types)
- Shared formatter converts parser output → dashboard format
- Dashboard displays tool calls, thinking blocks, and metadata with rich UI
- Provider-agnostic output rendering

---

## Implementation Plan

### Phase 1: Foundation (Create Shared Types & Formatter)

#### 1.1 Create Universal Output Types

**File:** `src/types/CliOutputTypes.ts` (NEW)

```typescript
/**
 * Universal CLI output structure (provider-agnostic)
 * Used by all CLI parsers to standardize output format
 */
export interface UniversalCliOutput {
  text: string;
  toolCalls: ToolCall[];
  thinkingBlocks: ThinkingBlock[];
  metadata: OutputMetadata;
}

export interface ToolCall {
  name: string;
  parameters: Record<string, any>;  // Normalized from 'input' or 'arguments'
  id?: string;
  result?: ToolResult;
}

export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
}

export interface ThinkingBlock {
  text: string;
  timestamp?: number;
  label?: string;  // e.g., "Reasoning", "Planning"
}

export interface OutputMetadata {
  sessionId?: string;
  model?: string;
  usage?: TokenUsage;
  cliVersion?: string;
  elapsed?: number;
  provider?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
```

**Rationale:**
- `parameters` instead of provider-specific `input`/`arguments`
- Top-level `thinkingBlocks` array (not nested in metadata)
- Consistent `usage` format with camelCase property names
- Optional `provider` field for debugging/display

#### 1.2 Create Shared Formatter

**File:** `src/flightpath/cli/shared/CliOutputFormatter.ts` (NEW)

```typescript
import { UniversalCliOutput, OutputMetadata } from "../../../types/CliOutputTypes";

export class CliOutputFormatter {
  /**
   * Format output as plain text for VS Code Output panel
   */
  static toPlainText(output: UniversalCliOutput): string {
    const parts: string[] = [];

    if (output.text) {
      parts.push(output.text);
    }

    if (output.toolCalls.length > 0) {
      parts.push("\n--- Tool Calls ---");
      for (const tool of output.toolCalls) {
        parts.push(`• ${tool.name}(${JSON.stringify(tool.parameters, null, 2)})`);
        if (tool.result) {
          parts.push(`  Result: ${tool.result.success ? "✓" : "✗"} ${tool.result.output || tool.result.error || ""}`);
        }
      }
    }

    if (output.thinkingBlocks.length > 0) {
      parts.push("\n--- Thinking ---");
      for (const block of output.thinkingBlocks) {
        const label = block.label ? `[${block.label}] ` : "";
        parts.push(`${label}${block.text}`);
      }
    }

    return parts.join("\n");
  }

  /**
   * Format output as structured data for dashboard webview
   */
  static toDashboardFormat(output: UniversalCliOutput) {
    return {
      text: output.text,
      toolCalls: output.toolCalls.map(tool => ({
        name: tool.name,
        parameters: tool.parameters,
        id: tool.id,
        result: tool.result
      })),
      thinkingBlocks: output.thinkingBlocks.map(block => ({
        text: block.text,
        label: block.label || "Thinking",
        timestamp: block.timestamp
      })),
      metadata: output.metadata
    };
  }

  /**
   * Format metadata statistics string (backward compatibility)
   */
  static formatStatistics(metadata: OutputMetadata): string {
    const parts: string[] = [];

    if (metadata.sessionId) {
      // Show first 8 chars for readability
      const displayId = metadata.sessionId.substring(0, 8);
      parts.push(`Session: ${displayId}`);
    }
    if (metadata.model) {
      parts.push(`Model: ${metadata.model}`);
    }
    if (metadata.usage) {
      parts.push(`Tokens: ${metadata.usage.inputTokens} in / ${metadata.usage.outputTokens} out`);
    }

    return parts.join(" | ");
  }
}
```

**Rationale:**
- Provides both plain text (for VS Code Output) and structured data (for dashboard)
- Backward-compatible statistics formatting
- Centralizes all formatting logic

---

### Phase 2: Update Parser Interface & Implementations

#### 2.1 Update ILogParser Interface

**File:** `src/flightpath/cli/shared/interfaces/ILogParser.ts`

**Change:**
```typescript
import { UniversalCliOutput } from "../../../../types/CliOutputTypes";

export interface ILogParser {
  extractResponse(events: any[]): UniversalCliOutput;  // ✅ Now strongly typed!
  // ... rest unchanged ...
}
```

**Rationale:** Enforces consistent return type across all parsers

#### 2.2 Update Copilot Parser

**File:** `src/flightpath/cli/copilot/CopilotLogParser.ts`

**Current Issues:**
- ❌ Doesn't build `thinkingBlocks` array (only concatenates with prefix)
- ❌ Returns `sessionInfo` separately instead of in `metadata`
- ⚠️ Tool call structure may vary

**Changes to extractResponse():**

```typescript
extractResponse(events: any[]): UniversalCliOutput {
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const thinkingBlocks: ThinkingBlock[] = [];  // ✅ NEW
  let metadata: OutputMetadata = {};

  for (const event of events) {
    // Extract text (existing)
    if (event.type === "assistant.message" && event.data?.content) {
      textParts.push(event.data.content);
    }

    // ✅ NEW: Extract thinking blocks from assistant.reasoning
    if (event.type === "assistant.reasoning" && event.data?.content) {
      thinkingBlocks.push({
        text: event.data.content,
        timestamp: event.timestamp ? new Date(event.timestamp).getTime() : undefined,
        label: "Reasoning"
      });
    }

    // ✅ UPDATED: Normalize tool calls
    if (event.data?.toolRequests && Array.isArray(event.data.toolRequests)) {
      for (const toolReq of event.data.toolRequests) {
        toolCalls.push({
          name: toolReq.name || toolReq.tool || "unknown",
          parameters: toolReq.parameters || toolReq.args || toolReq.input || {},
          id: toolReq.id
        });
      }
    }

    // Extract session metadata (existing, but normalize)
    if (event.type === "session.start" && event.data) {
      metadata.sessionId = event.data.sessionId;
      metadata.model = event.data.model;
    }
  }

  return {
    text: textParts.join(""),
    toolCalls,
    thinkingBlocks,  // ✅ Now included
    metadata: { ...metadata, provider: "copilot-cli" }
  };
}
```

**Rationale:**
- Builds `thinkingBlocks` array instead of mixing with text
- Normalizes tool call field names
- Consolidates `sessionInfo` into `metadata`

#### 2.3 Update Claude Parser

**File:** `src/flightpath/cli/claude/ClaudeLogParser.ts`

**Current Issues:**
- ✅ Already builds `thinkingBlocks` correctly in `extractResponse()`
- ❌ `extractContentFromEvent()` ignores thinking blocks during streaming
- ⚠️ Tool calls use `input` field (needs renaming to `parameters`)

**Changes to extractContentFromEvent():**

```typescript
extractContentFromEvent(event: any): string | undefined {
  if (event.type === "assistant" && event.message?.content) {
    const parts: string[] = [];

    for (const block of event.message.content) {
      if (block.type === "text" && block.text) {
        parts.push(block.text);
      }

      // ✅ NEW: Show tool calls during streaming
      if (block.type === "tool_use") {
        parts.push(`\n[Tool Call: ${block.name}]\n`);
      }

      // ✅ NEW: Show thinking blocks during streaming
      if (block.type === "thinking" && block.text) {
        parts.push(`\n[Thinking]\n${block.text}\n`);
      }
    }

    return parts.length > 0 ? parts.join("") : undefined;
  }
  return undefined;
}
```

**Changes to extractResponse():**

```typescript
// Minimal change - just rename 'input' → 'parameters'
if (contentBlock.type === "tool_use") {
  toolCalls.push({
    name: contentBlock.name,
    parameters: contentBlock.input,  // ✅ Rename field for consistency
    id: contentBlock.id,
  });
}

// Add provider field
return {
  text: text.trim(),
  toolCalls,
  thinkingBlocks,
  metadata: {
    sessionId,
    model,
    usage: totalInputTokens > 0 ? {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
    } : undefined,
    provider: "claude-cli"  // ✅ Add provider
  },
};
```

**Rationale:**
- Enables streaming display of thinking blocks and tool calls
- Normalizes field names to match universal format
- Already correctly structured, minimal changes needed

#### 2.4 Update Codex Parser

**File:** `src/flightpath/cli/codex/CodexLogParser.ts`

**Current Issues:**
- ❌ `reasoningBlocks` stored in `metadata` (should be top-level `thinkingBlocks`)
- ❌ Tool calls use both `input` and `arguments` (inconsistent)
- ⚠️ Two different tool call formats in log events

**Changes to extractResponse():**

```typescript
extractResponse(events: any[]): UniversalCliOutput {
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const thinkingBlocks: ThinkingBlock[] = [];  // ✅ Move from metadata
  let metadata: OutputMetadata = {};

  for (const event of events) {
    if (event.type === "response_item" && event.payload?.role === "assistant") {
      const content = event.payload.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          // Text (existing)
          if ((item.type === "input_text" || item.type === "output_text") && item.text) {
            textParts.push(item.text);
          }

          // ✅ UPDATED: Normalize tool calls
          if (item.type === "tool_use") {
            toolCalls.push({
              name: item.name,
              parameters: item.input || item.arguments || {},  // ✅ Normalize both formats
              id: item.id,
            });
          }

          // ✅ UPDATED: Move to top-level thinkingBlocks array
          if (item.type === "thinking" && item.text) {
            thinkingBlocks.push({
              text: item.text,
              label: "Thinking"
            });
          }
        }
      }
    }

    // ✅ UPDATED: Normalize function_call format
    if (event.type === "response_item" && event.payload?.type === "function_call") {
      toolCalls.push({
        name: event.payload.name,
        parameters: event.payload.arguments || event.payload.input || {},  // ✅ Normalize
        id: event.payload.call_id ?? event.payload.id,
      });
    }

    // Session metadata (existing)
    if (event.type === "session_meta" && event.payload) {
      metadata.sessionId = event.payload.id;
      metadata.model = event.payload.model;
      metadata.cliVersion = event.payload.cli_version;
    }
  }

  return {
    text: textParts.join(""),
    toolCalls,
    thinkingBlocks,  // ✅ Now top-level
    metadata: { ...metadata, provider: "codex-cli" }  // ✅ Add provider
  };
}
```

**Rationale:**
- Moves `thinkingBlocks` to top-level (consistent with Claude)
- Handles both tool call formats (`input` and `arguments`)
- Adds `provider` field to metadata

---

### Phase 3: Integrate Formatter into Workflow

#### 3.1 Update WorkflowExecutor

**File:** `src/flightpath/WorkflowExecutor.ts`

**Current:** Sends simple object to dashboard:
```typescript
{
  prompt: prompt.prompt,
  response: responseText,
  elapsed: duration,
  tokens,
  isStreaming: false,
  cliCommand
}
```

**Change:** Use formatter to enrich output

**Around line 816-823 (after CLI completion):**

```typescript
import { CliOutputFormatter } from "./cli/shared/CliOutputFormatter";

// After extracting response from log parser
const parsedOutput = await logParser.extractResponse(events);

// Convert to dashboard format
const dashboardOutput = {
  prompt: prompt.prompt,
  response: CliOutputFormatter.toPlainText(parsedOutput),  // ✅ Formatted text
  structured: CliOutputFormatter.toDashboardFormat(parsedOutput),  // ✅ Structured data
  elapsed: duration,
  tokens: parsedOutput.metadata.usage ? {
    prompt: parsedOutput.metadata.usage.inputTokens,
    completion: parsedOutput.metadata.usage.outputTokens
  } : undefined,
  isStreaming: false,
  cliCommand
};

context.dashboardProvider.updateCliOutput(currentIndex, dashboardOutput);
```

**Rationale:**
- Enriches output with structured tool calls and thinking blocks
- Maintains backward compatibility with existing `response` field
- Dashboard can progressively enhance UI

#### 3.2 Update Dashboard Provider

**File:** `src/ui/FlightPathDashboardProvider.ts`

**Change:** Add type for CLI output (optional, for clarity)

```typescript
import { UniversalCliOutput } from "../types/CliOutputTypes";

public updateCliOutput(stepIndex: number, output: {
  prompt: string;
  response: string;
  structured?: ReturnType<typeof CliOutputFormatter.toDashboardFormat>;
  elapsed: number;
  tokens?: { prompt: number; completion: number };
  isStreaming: boolean;
  cliCommand?: string;
}): void {
  console.log(
    `📊 DashboardProvider: Sending CLI output for step ${stepIndex}`,
    output
  );
  this.postMessage({ type: MESSAGE_TYPES.CLI_OUTPUT, stepIndex, output });
}
```

**Rationale:** Documents expected structure without breaking changes

---

### Phase 4: Enhance Dashboard UI with Terminal Styling & Diff Support

#### 4.1 Terminal-Style Output (Replace Green Background)

**Current Issue:** Output uses green background (`rgba(100, 255, 100, 0.1)`) which doesn't match VS Code terminal aesthetic.

**File:** `src/ui/webview/dashboard.scss`

**Replace existing output styling:**

```scss
/* Base output container - terminal styling */
#output-content {
  font-family: var(--vscode-terminal-font-family, var(--vscode-editor-font-family));
  font-size: var(--vscode-terminal-font-size, 11px);
  background: var(--vscode-terminal-background);
  color: var(--vscode-terminal-foreground);
  overflow-y: auto;
  flex: 1;
  min-height: 0;
  padding: var(--spacing-sm);
}

.cli-output-item {
  background: transparent;  // No background, let terminal color show
  padding: var(--spacing-sm) 0;
  margin-bottom: var(--spacing-md);
  border: none;
  border-bottom: 1px solid var(--vscode-terminal-border, var(--border-color));
}

.output-response {
  background: transparent;  // Remove green background
  border-left: 3px solid var(--vscode-terminal-ansiGreen);
  padding: var(--spacing-sm);
  margin: var(--spacing-sm) 0;
  white-space: pre-wrap;
  word-wrap: break-word;
  font-family: var(--vscode-terminal-font-family, var(--vscode-editor-font-family));
  color: var(--vscode-terminal-foreground);
}

.output-prompt {
  border-left-color: var(--vscode-terminal-ansiYellow);
  background: transparent;
  color: var(--vscode-terminal-foreground);
}

.output-cli-command {
  border-left-color: var(--vscode-terminal-ansiCyan);
  background: transparent;
  color: var(--vscode-terminal-ansiCyan);
  font-family: var(--vscode-terminal-font-family);
}
```

**Rationale:**
- Uses VS Code terminal color palette for consistency
- Terminal font family matches integrated terminal
- Transparent backgrounds let terminal theme shine through
- ANSI color borders for visual distinction

#### 4.2 Diff Highlighting for Code Changes

**File:** `src/ui/webview/dashboard.scss`

**Add diff styling:**

```scss
// Tool call code diffs
.tool-call-diff {
  margin-top: 8px;
  font-family: var(--vscode-terminal-font-family, var(--vscode-editor-font-family));
  font-size: 11px;
  border-radius: 3px;
  overflow: hidden;
  border: 1px solid var(--vscode-panel-border);
}

.diff-line {
  padding: 2px 8px;
  white-space: pre;
  font-family: inherit;
  line-height: 1.4;

  &.added {
    background: var(--vscode-diffEditor-insertedTextBackground, rgba(0, 255, 0, 0.15));
    color: var(--vscode-terminal-ansiGreen);

    &::before {
      content: "+ ";
      color: var(--vscode-terminal-ansiGreen);
      font-weight: bold;
      margin-right: 4px;
    }
  }

  &.removed {
    background: var(--vscode-diffEditor-removedTextBackground, rgba(255, 0, 0, 0.15));
    color: var(--vscode-terminal-ansiRed);

    &::before {
      content: "- ";
      color: var(--vscode-terminal-ansiRed);
      font-weight: bold;
      margin-right: 4px;
    }
  }

  &.unchanged {
    background: transparent;
    color: var(--vscode-terminal-foreground);

    &::before {
      content: "  ";
    }
  }
}
```

**Rationale:**
- Uses VS Code's diff editor colors (red/green with transparency)
- Shows `+` and `-` prefixes like git diff
- Monospace terminal font for alignment
- Unchanged lines included for context

#### 4.3 Update Output Manager with Diff Support

**File:** `src/ui/webview/output-manager.js`

**Add helper functions:**

```javascript
/**
 * Check if tool is a file modification operation
 */
function isFileModificationTool(toolName) {
  const fileTools = ['Edit', 'Write', 'MultiEdit', 'sed', 'patch'];
  return fileTools.some(t => toolName.toLowerCase().includes(t.toLowerCase()));
}

/**
 * Render tool call with diff visualization
 */
function renderToolWithDiff(tool) {
  let html = '';

  // Try to extract old_string and new_string from parameters
  if (tool.parameters.old_string && tool.parameters.new_string) {
    html += `<div class="tool-call-diff">`;

    const oldLines = tool.parameters.old_string.split('\n');
    const newLines = tool.parameters.new_string.split('\n');

    // Show removed lines
    oldLines.forEach(line => {
      html += `<div class="diff-line removed">${escapeHtml(line)}</div>`;
    });

    // Show added lines
    newLines.forEach(line => {
      html += `<div class="diff-line added">${escapeHtml(line)}</div>`;
    });

    html += `</div>`;
  } else if (tool.parameters.content && tool.parameters.file_path) {
    // Write tool - show file path and content
    html += `<div class="tool-file-info">`;
    html += `<div class="file-path">${escapeHtml(tool.parameters.file_path)}</div>`;
    html += `</div>`;
    html += `<pre class="tool-params">${escapeHtml(tool.parameters.content)}</pre>`;
  } else {
    // Fallback to JSON if no diff available
    html += `<pre class="tool-params">${escapeHtml(JSON.stringify(tool.parameters, null, 2))}</pre>`;
  }

  return html;
}
```

**Update renderStructuredOutput():**

```javascript
function renderStructuredOutput(output) {
  let html = "";

  // Response text (existing)
  if (output.response) {
    html += `<div class="output-text">${escapeHtml(output.response)}</div>`;
  }

  // Tool calls with diff support
  if (output.structured?.toolCalls && output.structured.toolCalls.length > 0) {
    html += `<div class="output-tool-calls">`;
    html += `<div class="tool-calls-header">🔧 Tool Calls</div>`;

    for (const tool of output.structured.toolCalls) {
      html += `<div class="tool-call-item">`;
      html += `<div class="tool-name">${escapeHtml(tool.name)}</div>`;

      // Check if this is a file modification tool (Edit, Write, etc.)
      if (isFileModificationTool(tool.name)) {
        html += renderToolWithDiff(tool);
      } else {
        html += `<pre class="tool-params">${escapeHtml(JSON.stringify(tool.parameters, null, 2))}</pre>`;
      }

      if (tool.result) {
        const icon = tool.result.success ? "✓" : "✗";
        html += `<div class="tool-result ${tool.result.success ? 'success' : 'error'}">`;
        html += `${icon} ${escapeHtml(tool.result.output || tool.result.error || "")}`;
        html += `</div>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
  }

  // Thinking blocks (NEW)
  if (output.structured?.thinkingBlocks && output.structured.thinkingBlocks.length > 0) {
    html += `<div class="output-thinking">`;
    html += `<div class="thinking-header">💭 Thinking</div>`;
    for (const block of output.structured.thinkingBlocks) {
      html += `<div class="thinking-block">`;
      if (block.label) {
        html += `<div class="thinking-label">${escapeHtml(block.label)}</div>`;
      }
      html += `<div class="thinking-text">${escapeHtml(block.text)}</div>`;
      html += `</div>`;
    }
    html += `</div>`;
  }

  return html;
}
```

**Update existing renderAllCliOutputs():**

```javascript
// Around line 105-151, replace plain text rendering with:
const outputHtml = renderStructuredOutput(output);
html += outputHtml;
```

**Rationale:**
- Detects file modification tools automatically
- Shows diffs for Edit operations (old_string → new_string)
- Shows file path for Write operations
- Graceful fallback to JSON for other tools
- Backward compatible with existing plain text outputs

#### 4.4 Structured Output Styles

**File:** `src/ui/webview/dashboard.scss`

**Add new styles:**

```scss
// Tool Calls Section
.output-tool-calls {
  margin-top: 12px;
  border-left: 3px solid var(--vscode-charts-blue);
  padding-left: 12px;

  .tool-calls-header {
    font-weight: 600;
    color: var(--vscode-charts-blue);
    margin-bottom: 8px;
    font-size: 13px;
  }

  .tool-call-item {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    padding: 8px;
    margin: 8px 0;

    .tool-name {
      font-weight: 600;
      color: var(--vscode-symbolIcon-functionForeground);
      font-size: 13px;
      margin-bottom: 6px;
    }

    .tool-params {
      font-size: 11px;
      font-family: var(--vscode-editor-font-family);
      background: var(--vscode-textCodeBlock-background);
      padding: 6px;
      border-radius: 3px;
      overflow-x: auto;
      margin: 0;
    }

    .tool-file-info {
      margin-bottom: 6px;

      .file-path {
        font-family: var(--vscode-editor-font-family);
        font-size: 11px;
        color: var(--vscode-terminal-ansiBlue);
        font-weight: 600;
      }
    }

    .tool-result {
      margin-top: 6px;
      padding: 4px 8px;
      border-radius: 3px;
      font-size: 12px;

      &.success {
        background: var(--vscode-testing-iconPassed);
        color: var(--vscode-editor-background);
      }

      &.error {
        background: var(--vscode-testing-iconFailed);
        color: var(--vscode-editor-background);
      }
    }
  }
}

// Thinking Blocks Section
.output-thinking {
  margin-top: 12px;
  border-left: 3px solid var(--vscode-charts-purple);
  padding-left: 12px;

  .thinking-header {
    font-weight: 600;
    color: var(--vscode-charts-purple);
    margin-bottom: 8px;
    font-size: 13px;
  }

  .thinking-block {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    padding: 8px;
    margin: 8px 0;

    .thinking-label {
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
      letter-spacing: 0.5px;
    }

    .thinking-text {
      white-space: pre-wrap;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      line-height: 1.5;
      color: var(--vscode-editor-foreground);
    }
  }
}
```

**Rationale:**
- VS Code theme integration via CSS variables
- Distinct visual sections for tool calls and thinking
- File paths styled with terminal blue color
- Success/error indicators with VS Code test colors

#### 4.5 Enhanced Markdown Export

**File:** `src/ui/webview/output-manager.js`

**Update generateMarkdownOutput():**

```javascript
function generateMarkdownOutput() {
  const state = stateManager.getState();
  const lines = [];
  const timestamp = new Date().toISOString();

  // Header (existing)
  lines.push("# FlightPath Execution Output");
  lines.push("");
  lines.push(`**File:** ${state.fileName || "Unknown"}`);
  lines.push(`**Exported:** ${timestamp}`);
  lines.push(`**Status:** ${state.executionState}`);
  lines.push(`**Progress:** ${state.currentStep} of ${state.totalSteps} completed`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // Build chronological message list (existing)
  const allMessages = [];
  // ... existing code ...

  // Render each message
  allMessages.forEach((item) => {
    if (item.type === "status") {
      const statusMsg = item.data;
      lines.push(`> **[${statusMsg.timestamp}]** ${statusMsg.message}`);
      lines.push("");
    } else if (item.type === "copilot-cli") {
      const output = item.data;
      const attemptIndex = item.attemptIndex;
      const stepIndex = item.stepIndex;
      const attemptLabel = attemptIndex === 0 ? "Initial Attempt" : `Retry ${attemptIndex}`;

      lines.push(`## Prompt ${stepIndex + 1} - ${attemptLabel}`);
      lines.push("");

      // Prompt (existing)
      if (output.prompt) {
        lines.push("### Prompt");
        lines.push("");
        lines.push("```");
        lines.push(output.prompt);
        lines.push("```");
        lines.push("");
      }

      // CLI Command (existing)
      if (output.cliCommand) {
        lines.push("### CLI Command");
        lines.push("");
        lines.push("```bash");
        lines.push(`$ ${output.cliCommand}`);
        lines.push("```");
        lines.push("");
      }

      // Response (existing)
      if (output.response) {
        lines.push("### Response");
        lines.push("");
        lines.push("```");
        lines.push(output.response);
        lines.push("```");
        lines.push("");
      }

      // ✅ NEW: Export tool calls with diff formatting
      if (output.structured?.toolCalls && output.structured.toolCalls.length > 0) {
        lines.push("### Tool Calls");
        lines.push("");

        output.structured.toolCalls.forEach(tool => {
          lines.push(`**${tool.name}**`);
          lines.push("");

          // Special handling for file modifications with diff
          if (tool.parameters.old_string && tool.parameters.new_string) {
            lines.push("```diff");
            tool.parameters.old_string.split('\n').forEach(line => {
              lines.push(`- ${line}`);
            });
            tool.parameters.new_string.split('\n').forEach(line => {
              lines.push(`+ ${line}`);
            });
            lines.push("```");
          } else if (tool.parameters.file_path && tool.parameters.content) {
            // Write tool - show file path
            lines.push(`File: \`${tool.parameters.file_path}\``);
            lines.push("");
            lines.push("```");
            lines.push(tool.parameters.content);
            lines.push("```");
          } else {
            // Other tools - show JSON
            lines.push("```json");
            lines.push(JSON.stringify(tool.parameters, null, 2));
            lines.push("```");
          }

          if (tool.result) {
            const status = tool.result.success ? "✓ Success" : "✗ Failed";
            lines.push("");
            lines.push(`*${status}*`);
            if (tool.result.output || tool.result.error) {
              lines.push("```");
              lines.push(tool.result.output || tool.result.error);
              lines.push("```");
            }
          }
          lines.push("");
        });
      }

      // ✅ NEW: Export thinking blocks
      if (output.structured?.thinkingBlocks && output.structured.thinkingBlocks.length > 0) {
        lines.push("### Thinking");
        lines.push("");

        output.structured.thinkingBlocks.forEach(block => {
          if (block.label) {
            lines.push(`**${block.label}**`);
            lines.push("");
          }
          lines.push("```");
          lines.push(block.text);
          lines.push("```");
          lines.push("");
        });
      }

      // Stats section (existing)
      const stats = [];
      if (output.tokens) {
        const total = output.tokens.prompt + output.tokens.completion;
        stats.push(`Tokens: ${output.tokens.prompt} prompt / ${output.tokens.completion} completion / ${total} total`);
      }
      if (output.elapsed !== undefined) {
        stats.push(`${output.elapsed}s`);
      }

      if (stats.length > 0) {
        lines.push(`*${stats.join(" | ")}*`);
        lines.push("");
      }

      lines.push("---");
      lines.push("");
    }
  });

  return lines.join("\n");
}
```

**Example Exported Markdown:**

```markdown
## Prompt 1 - Initial Attempt

### Tool Calls

**Edit**

```diff
- const oldValue = 42;
+ const newValue = 100;
```

*✓ Success*

**Write**

File: `src/test.ts`

```
console.log("Hello world");
```

*✓ Success*

### Thinking

**Reasoning**

```
I need to update the value to 100 because the requirements changed.
```

*Tokens: 1500 prompt / 300 completion / 1800 total | 3.2s*
```

**Rationale:**
- Diffs exported as `diff` code blocks (GitHub/VS Code renders with colors)
- Write operations show file path clearly
- Tool results included with success/failure indicators
- Thinking blocks exported in code blocks for readability
- Fully compatible with markdown viewers and GitHub

---

### Phase 5: Testing & Validation

#### 5.1 Unit Tests

**File:** `src/test/unit/CliOutputFormatter.test.ts` (NEW)

```typescript
import * as assert from "assert";
import { CliOutputFormatter } from "../../flightpath/cli/shared/CliOutputFormatter";
import { UniversalCliOutput } from "../../types/CliOutputTypes";

suite("CliOutputFormatter Tests", () => {
  test("toPlainText - formats text only", () => {
    const output: UniversalCliOutput = {
      text: "Hello world",
      toolCalls: [],
      thinkingBlocks: [],
      metadata: {}
    };

    const result = CliOutputFormatter.toPlainText(output);
    assert.strictEqual(result, "Hello world");
  });

  test("toPlainText - includes tool calls", () => {
    const output: UniversalCliOutput = {
      text: "Running tests",
      toolCalls: [{ name: "shell", parameters: { command: "npm test" } }],
      thinkingBlocks: [],
      metadata: {}
    };

    const result = CliOutputFormatter.toPlainText(output);
    assert.ok(result.includes("--- Tool Calls ---"));
    assert.ok(result.includes("shell"));
  });

  test("formatStatistics - all fields", () => {
    const metadata = {
      sessionId: "abc-123-def-456",
      model: "claude-sonnet-4.5",
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }
    };

    const result = CliOutputFormatter.formatStatistics(metadata);
    assert.strictEqual(result, "Session: abc-123 | Model: claude-sonnet-4.5 | Tokens: 100 in / 50 out");
  });
});
```

#### 5.2 Parser Tests

**Update existing parser tests** to verify `UniversalCliOutput` structure:

- `src/test/unit/CopilotLogParser.test.ts`
- `src/test/unit/ClaudeLogParser.test.ts`
- `src/test/unit/CodexLogParser.test.ts`

**Example addition:**

```typescript
test("extractResponse - returns UniversalCliOutput with thinkingBlocks", () => {
  const events = [
    { type: "assistant.reasoning", data: { content: "I need to analyze..." } },
    { type: "assistant.message", data: { content: "Here's the solution" } }
  ];

  const result = parser.extractResponse(events);

  assert.strictEqual(result.text, "Here's the solution");
  assert.strictEqual(result.thinkingBlocks.length, 1);
  assert.strictEqual(result.thinkingBlocks[0].text, "I need to analyze...");
  assert.strictEqual(result.thinkingBlocks[0].label, "Reasoning");
});
```

#### 5.3 Integration Testing

**Manual testing checklist:**

1. ✅ Run workflow with Copilot CLI - verify thinking blocks shown
2. ✅ Run workflow with Claude CLI - verify tool calls displayed
3. ✅ Run workflow with Codex CLI - verify both thinking and tools work
4. ✅ Verify streaming shows tool calls/thinking in real-time
5. ✅ Verify plain text fallback works (backward compatibility)
6. ✅ Check VS Code Output panel formatting
7. ✅ Export to markdown - verify structured data included

---

## Migration Strategy

### Backward Compatibility

**Phase 1-2:** No breaking changes
- New types/formatter are additive
- Parser updates return new structure but don't break existing consumers

**Phase 3:** Opt-in enrichment
- WorkflowExecutor adds `structured` field alongside existing `response`
- Old code continues using `response` text
- New code can use `structured` data

**Phase 4:** Progressive enhancement
- Dashboard checks for `structured` field before rendering
- Falls back to plain text if not present
- Existing workflows continue working

### Rollout Plan

**Week 1:** Foundation (Phase 1)
- Create types and formatter
- Add unit tests
- No user-facing changes

**Week 2:** Parser updates (Phase 2)
- Update all three parsers
- Add parser tests
- Still no UI changes (data collected but not displayed)

**Week 3:** Integration (Phase 3)
- Update WorkflowExecutor to use formatter
- Dashboard receives structured data but doesn't display yet
- Verify data flow end-to-end

**Week 4:** UI enhancement (Phase 4)
- Add structured rendering in output-manager.js
- Add styles
- User sees rich tool call/thinking display

**Week 5:** Polish & documentation
- Fix edge cases
- Update docs/research plan (this file)
- Write user guide

---

## Critical Files to Modify

### New Files (4)
1. **src/types/CliOutputTypes.ts** - Universal output interfaces
2. **src/flightpath/cli/shared/CliOutputFormatter.ts** - Shared formatter class
3. **src/test/unit/CliOutputFormatter.test.ts** - Formatter tests
4. **docs/research/CLI_OUTPUT_STANDARDIZATION.md** - This plan

### Modified Files (10)
5. **src/flightpath/cli/shared/interfaces/ILogParser.ts** - Update extractResponse return type
6. **src/flightpath/cli/copilot/CopilotLogParser.ts** - Add thinkingBlocks, normalize tools
7. **src/flightpath/cli/claude/ClaudeLogParser.ts** - Fix extractContentFromEvent, rename input→parameters
8. **src/flightpath/cli/codex/CodexLogParser.ts** - Move reasoningBlocks, normalize tools
9. **src/flightpath/WorkflowExecutor.ts** - Use formatter in completion handler
10. **src/ui/FlightPathDashboardProvider.ts** - Update output type (documentation only)
11. **src/ui/webview/output-manager.js** - Add renderStructuredOutput function
12. **src/ui/webview/dashboard.scss** - Add tool call and thinking block styles
13. **src/test/unit/CopilotLogParser.test.ts** - Add UniversalCliOutput tests
14. **src/test/unit/ClaudeLogParser.test.ts** - Add UniversalCliOutput tests
15. **src/test/unit/CodexLogParser.test.ts** - Add UniversalCliOutput tests

---

## Verification Steps

After implementation, verify:

1. **Type Safety**
   - [ ] All parsers return `UniversalCliOutput`
   - [ ] No TypeScript errors in strict mode
   - [ ] ILogParser interface matches implementations

2. **Parser Completeness**
   - [ ] Copilot builds `thinkingBlocks` array
   - [ ] Claude's `extractContentFromEvent()` shows thinking during streaming
   - [ ] Codex normalizes both tool call formats
   - [ ] All parsers include `provider` in metadata

3. **Formatter Functionality**
   - [ ] `toPlainText()` formats all three sections (text, tools, thinking)
   - [ ] `toDashboardFormat()` preserves all data
   - [ ] `formatStatistics()` handles missing fields gracefully

4. **Dashboard Display**
   - [ ] Tool calls show in blue bordered section
   - [ ] Thinking blocks show in purple bordered section
   - [ ] Styles match VS Code theme
   - [ ] Backward compatible with plain text outputs

5. **End-to-End Testing**
   - [ ] Run workflow with Copilot CLI → see reasoning blocks
   - [ ] Run workflow with Claude CLI → see tool calls and thinking
   - [ ] Run workflow with Codex CLI → see both formats
   - [ ] Streaming updates show structured content in real-time
   - [ ] Export to markdown includes all structured data

---

## Future Enhancements

After initial implementation, consider:

1. **Collapsible Sections** - Allow users to collapse tool calls/thinking
2. **Token Tracking** - Display per-step token usage in UI
3. **Tool Result Visualization** - Show success/failure with icons
4. **Thinking Timeline** - Show thinking blocks chronologically
5. **MCP Integration** - Display MCP tool execution separately
6. **Response Diffing** - Compare outputs across retries
7. **Export Enhancements** - Structured JSON export option

---

## Success Criteria

✅ All three CLI providers return identical `UniversalCliOutput` structure
✅ Dashboard displays tool calls and thinking blocks with rich UI
✅ No breaking changes to existing workflows
✅ Unit test coverage for formatter and parser changes
✅ Documentation updated in docs/research/
✅ Manual testing confirms all providers work correctly

---

## Appendix A: Real Log Structures from Production Logs

This appendix documents the **actual JSON structures** found in production log files from all three CLI providers. These examples were extracted from real session logs to ensure the parser implementation handles actual data formats (not assumptions).

### Documentation References

- **Claude CLI**: `docs/CLAUDE_CLI_LOG_STRUCTURE.md` (985 lines, comprehensive)
- **Copilot CLI**: `docs/COPILOT_CLI_EVENT_STRUCTURE.md` (14 event types)
- **Codex CLI**: `docs/CODEX_CLI_LOG_STRUCTURE.md` (1,328 lines, comprehensive)

---

### A.1 Tool Calls - Field Name Variations

**The Primary Normalization Challenge**

#### Claude CLI - `tool_use` with `input`

```json
{
  "type": "assistant",
  "message": {
    "id": "msg_01ABC",
    "content": [
      {
        "type": "tool_use",
        "id": "toolu_01XYZ",
        "name": "Edit",
        "input": {
          "file_path": "src/test.ts",
          "old_string": "const x = 42;",
          "new_string": "const x = 100;"
        }
      }
    ]
  }
}
```

**Field:** `input` (object)
**Normalization:** Rename to `parameters`

#### Codex CLI - Format A: `tool_use` with `input`

```json
{
  "type": "response_item",
  "payload": {
    "role": "assistant",
    "content": [
      {
        "type": "tool_use",
        "name": "write_file",
        "input": {
          "path": "app.ts",
          "content": "export const app = 'FlightPath';"
        },
        "id": "tool-codex-1"
      }
    ]
  }
}
```

**Field:** `input` (object)
**Normalization:** Rename to `parameters`

#### Codex CLI - Format B: `function_call` with `arguments`

```json
{
  "type": "response_item",
  "payload": {
    "type": "function_call",
    "name": "shell_command",
    "arguments": "{\"command\":\"Get-Content -Path file.md\"}",
    "call_id": "call_Q0mtPu3Ec90Fqm8k1CulZY6q"
  }
}
```

**Field:** `arguments` (JSON **string**, not object!)
**Normalization:** Parse JSON string, then rename to `parameters`

```typescript
// Must parse before normalization
const params = JSON.parse(event.payload.arguments);
toolCalls.push({ name: event.payload.name, parameters: params });
```

#### Copilot CLI - `toolRequest` with `parameters` or `args`

```json
{
  "type": "assistant.message",
  "data": {
    "content": "...",
    "toolRequests": [
      {
        "name": "shell",
        "parameters": {
          "command": "git status"
        },
        "id": "call_abc123"
      }
    ]
  }
}
```

**Field:** `parameters` OR `args` (inconsistent)
**Normalization:** Already uses `parameters` (sometimes), but may also have `args`

**Normalization Code:**

```typescript
toolCalls.push({
  name: toolReq.name || toolReq.tool || "unknown",
  parameters: toolReq.parameters || toolReq.args || toolReq.input || {},
  id: toolReq.id
});
```

---

### A.2 Thinking Blocks - Location Variations

#### Claude CLI - `thinking` Content Block

```json
{
  "type": "assistant",
  "message": {
    "content": [
      {
        "type": "thinking",
        "thinking": "I need to analyze this code carefully. The bug is likely in the validation logic."
      },
      {
        "type": "text",
        "text": "I found the issue in the validation function."
      }
    ]
  }
}
```

**Location:** `content[]` array
**Field:** `thinking` (text content)
**Label:** None (implied "Thinking")

#### Codex CLI - Format A: Inline `thinking`

```json
{
  "type": "response_item",
  "payload": {
    "role": "assistant",
    "content": [
      { "type": "thinking", "text": "Let me think about this approach..." },
      { "type": "input_text", "text": "Based on my analysis, I recommend..." }
    ]
  }
}
```

**Location:** `content[]` array
**Field:** `text`
**Label:** None

#### Codex CLI - Format B: Encrypted `reasoning`

```json
{
  "type": "response_item",
  "payload": {
    "type": "reasoning",
    "summary": [],
    "content": null,
    "encrypted_content": "gAAAAABpbANyGJEH3ezksCKCbQ7Uldz-MNKrIOdM5iM98b4SUjT8jpYIijka..."
  }
}
```

**Location:** Top-level `payload`
**Field:** `encrypted_content` (not accessible)
**Handling:** Skip (cannot decrypt)

#### Copilot CLI - `assistant.reasoning` Event

```json
{
  "type": "assistant.reasoning",
  "data": {
    "content": "I should first check the current file structure before making changes.",
    "timestamp": "2025-01-21T10:30:45.123Z"
  }
}
```

**Location:** Separate event type
**Field:** `data.content`
**Label:** "Reasoning"
**Note:** Only appears with extended thinking models

---

### A.3 Text Content - Type Variations

#### Claude CLI - `text` Block

```json
{
  "type": "text",
  "text": "Here's the implementation you requested."
}
```

**Type:** `text`
**Field:** `text`

#### Codex CLI - Both `input_text` and `output_text`

```json
{
  "type": "input_text",
  "text": "Let me analyze the code structure."
}
```

```json
{
  "type": "output_text",
  "text": "console.log('result');"
}
```

**Types:** `input_text` AND `output_text`
**Field:** `text`
**Handling:** Extract both types

```typescript
if ((item.type === "input_text" || item.type === "output_text") && item.text) {
  textParts.push(item.text);
}
```

#### Copilot CLI - Simple Content String

```json
{
  "type": "assistant.message",
  "data": {
    "content": "Here's the solution to your problem."
  }
}
```

**Field:** `data.content` (string)
**Handling:** Extract directly

---

### A.4 Session Metadata

#### Claude CLI - Per-Event `sessionId`

```json
{
  "type": "assistant",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "message": {
    "model": "claude-sonnet-4.5",
    "usage": {
      "input_tokens": 1234,
      "output_tokens": 567
    }
  }
}
```

**Session ID:** UUID in every event
**Model:** `message.model`
**Tokens:** `message.usage` object

#### Codex CLI - `session_meta` Event

```json
{
  "type": "session_meta",
  "payload": {
    "id": "019bcded-64fd-7b21-b80b-be2a50ec8767",
    "model_provider": "openai",
    "cli_version": "0.87.0",
    "git": {
      "commit_hash": "6d2a783eeea0fc082bd4cac66818aab83ac40fdc",
      "branch": "main"
    }
  }
}
```

**Session ID:** `payload.id` (UUID, not `thread_` prefix)
**Model:** Not in session_meta (must infer from context)
**CLI Version:** `payload.cli_version`

#### Copilot CLI - `session.start` Event

```json
{
  "type": "session.start",
  "data": {
    "sessionId": "01JJWPK6Q5RQXM4KZXQXM4KZXQ",
    "model": "gpt-4o-2024-11-20",
    "version": "0.0.367"
  }
}
```

**Session ID:** `data.sessionId`
**Model:** `data.model`
**Version:** `data.version`

---

### A.5 Completion Signals

#### Claude CLI - `stop_reason`

```json
{
  "type": "assistant",
  "message": {
    "stop_reason": "end_turn"
  }
}
```

**Signal:** `stop_reason: "end_turn"` or `"tool_use"`
**Streaming:** `stop_reason: null` means still streaming
**Final:** Last event with non-null `stop_reason`

#### Codex CLI - `turn.completed` Event

```json
{
  "type": "event_msg",
  "payload": {
    "type": "turn.completed"
  }
}
```

**Signal:** `event_msg` with `payload.type = "turn.completed"`
**Definitive:** This is the only completion signal

#### Copilot CLI - `assistant.turn_end`

```json
{
  "type": "assistant.turn_end",
  "data": {
    "timestamp": "2025-01-21T10:31:00.000Z"
  }
}
```

**Signal:** `assistant.turn_end` event
**Reliable:** Clear end-of-turn marker

---

### A.6 Token Usage Formats

#### Claude CLI - Comprehensive Usage Object

```json
{
  "usage": {
    "input_tokens": 2500,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 1200,
    "output_tokens": 450
  }
}
```

**Fields:**
- `input_tokens` - New input tokens
- `cache_creation_input_tokens` - Cache creation cost
- `cache_read_input_tokens` - Cache hits (90% discount)
- `output_tokens` - Generated tokens

**Total Calculation:**
```typescript
const total = usage.input_tokens + usage.cache_creation_input_tokens +
              usage.output_tokens;
```

#### Codex CLI - Token Count Events

```json
{
  "type": "event_msg",
  "payload": {
    "type": "token_count",
    "info": null
  }
}
```

**Location:** Separate `event_msg` events
**Format:** Not well documented (may be in `info` field)

#### Copilot CLI - Statistics in `assistant.turn_end`

```json
{
  "type": "assistant.turn_end",
  "data": {
    "stats": "25.7k input, 223 output"
  }
}
```

**Format:** Human-readable string
**Parsing Required:**
```typescript
const match = stats.match(/(\d+\.?\d*)k?\s+input,\s+(\d+)\s+output/);
const inputTokens = parseFloat(match[1]) * (match[1].includes('k') ? 1000 : 1);
const outputTokens = parseInt(match[2]);
```

---

### A.7 Implementation Impact Summary

**Critical Normalizations Required:**

1. **Tool Calls:**
   - Codex `arguments` (JSON string) → Parse → `parameters`
   - Claude `input` → `parameters`
   - Copilot `parameters`/`args` → `parameters`

2. **Thinking Blocks:**
   - Claude: Extract from `content[]` with `type: "thinking"`
   - Codex: Extract from `content[]` with `type: "thinking"` (skip encrypted)
   - Copilot: Extract from `assistant.reasoning` events

3. **Text Content:**
   - Claude: `type: "text"` → `text` field
   - Codex: `type: "input_text"` OR `"output_text"` → `text` field
   - Copilot: `data.content` string

4. **Session Metadata:**
   - All use UUID session IDs (Codex no longer uses `thread_` prefix)
   - Extract from different event types per provider
   - Model names vary in format

5. **Completion Detection:**
   - Claude: `stop_reason !== null`
   - Codex: `event_msg.payload.type === "turn.completed"`
   - Copilot: `assistant.turn_end` event

---

### A.8 Reference Documentation

For complete event structures and more examples, see:

- **`docs/CLAUDE_CLI_LOG_STRUCTURE.md`** - 15 event types, 985 lines
- **`docs/CLAUDE_CLI_LOG_QUICK_REFERENCE.md`** - Quick lookup, 344 lines
- **`docs/COPILOT_CLI_EVENT_STRUCTURE.md`** - 14 event types with real examples
- **`docs/CODEX_CLI_LOG_STRUCTURE.md`** - 15 sections, 1,328 lines

These documents include:
- Full JSON schemas for all event types
- Field-by-field descriptions
- Multiple real-world examples
- Edge cases and variations
- Parsing strategies and code snippets
- FlightPath integration guidance
- Comparison tables across providers
