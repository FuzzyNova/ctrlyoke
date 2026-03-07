# CLI Output Standardization — Implementation Reference

**Status**: IMPLEMENTED  
**Implemented**: ~2026-01-31 (evolved from research in `docs/research/CLI_OUTPUT_STANDARDIZATION.md`)  
**Last Verified**: 2026-02-25

---

## Overview

FlightPath uses a universal, provider-agnostic output format for all CLI harnesses (Copilot CLI, Claude CLI, Codex CLI). This ensures consistent display in the VS Code Output panel and the React dashboard webview regardless of which harness generates the output.

---

## Implementation vs. Original Plan

The original research proposed separate top-level arrays (`toolCalls`, `thinkingBlocks`, `text`) in `UniversalCliOutput`. The actual implementation uses a **single chronological events array** instead. This is a strictly better design: it preserves the exact order that events occurred (e.g., thinking → tool call → tool result → more text) rather than grouping them by type.

---

## Core Types — `src/types/CliOutputTypes.ts`

Single source of truth for all CLI output structures.

### `UniversalCliOutput`

```typescript
export interface UniversalCliOutput {
  events: CliEvent[]; // Chronologically ordered events
  metadata: OutputMetadata;
}
```

### `CliEvent`

```typescript
export interface CliEvent {
  type: CliEventType; // text | tool_call | thinking | tool_result | bash_command | ...
  timestamp?: number;
  data: CliEventData; // Union type — exact shape depends on type
}
```

### Event Data Types

| Event Type      | Data Interface    | Notes                                    |
| --------------- | ----------------- | ---------------------------------------- |
| `text`          | `TextData`        | AI response text                         |
| `tool_call`     | `ToolCall`        | Normalized from harness-specific formats |
| `thinking`      | `ThinkingBlock`   | Claude extended thinking                 |
| `tool_result`   | `ToolResultData`  | Result for a preceding tool call         |
| `bash_command`  | `BashCommandData` | Shell command + output                   |
| `file_read`     | `FileReadData`    | File read operation                      |
| `file_write`    | `FileWriteData`   | File creation                            |
| `file_edit`     | `FileEditData`    | File modification with optional diff     |
| `file_delete`   | `FileDeleteData`  | File deletion                            |
| `mcp_tool_call` | `McpToolCallData` | MCP server tool invocations              |
| `web_search`    | `WebSearchData`   | Web search operations                    |

### `ToolCall` (normalized across harnesses)

```typescript
export interface ToolCall {
  name: string;
  parameters: Record<string, unknown>; // Always "parameters", never "input"/"arguments"
  id?: string;
  result?: ToolResult;
}
```

### `OutputMetadata`

```typescript
export interface OutputMetadata {
  sessionId?: string;
  model?: string;
  usage?: TokenUsage;
  cliVersion?: string;
  elapsed?: number;
  harness?: string; // 'copilot-cli' | 'claude-cli' | 'codex-cli' | 'opencode'
  rawTextOutput?: boolean; // true when harness pre-formats output (skips markdown rendering)
}
```

### `TokenUsage` (extended beyond original plan)

Includes cache token variants for Claude and reasoning token tracking for Codex:

```typescript
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  cacheCreatedTokens?: number; // Claude only
  reasoningOutputTokens?: number; // Codex only
  contextWindowUsedTokens?: number;
  contextWindowSize?: number;
}
```

---

## Shared Formatter — `src/flightpath/harness/shared/CliOutputFormatter.ts`

Static utility class with two output targets:

### `CliOutputFormatter.toPlainText(output)`

Renders events chronologically as readable text for the VS Code Output panel. Includes section headers for tool calls and thinking blocks.

### `CliOutputFormatter.toDashboardFormat(output)`

Passes events + metadata directly to the dashboard webview. Returns `DashboardOutput`:

```typescript
export interface DashboardOutput {
  events: CliEvent[];
  metadata: OutputMetadata;
}
```

### `CliOutputFormatter.formatStatistics(metadata)`

Produces `"Session: 550e8400 | Model: claude-sonnet-4.5 | Tokens: 1234 in / 567 out | Time: 3.2s"` for status display.

---

## ILogParser Interface — `src/flightpath/harness/shared/interfaces/ILogParser.ts`

All parsers implement `ILogParser` via `BaseLogParser` (`src/flightpath/harness/shared/BaseLogParser.ts`), which enforces `extractResponse(events: BaseCliEvent[]): UniversalCliOutput`:

| Parser   | File                                                   | Notes                                                  |
| -------- | ------------------------------------------------------ | ------------------------------------------------------ |
| Copilot  | `src/flightpath/harness/copilot/CopilotLogParser.ts`   | Parses Copilot CLI JSON log events                     |
| Claude   | `src/flightpath/harness/claude/ClaudeLogParser.ts`     | Parses `stream-json` format, including thinking blocks |
| Codex    | `src/flightpath/harness/codex/CodexLogParser.ts`       | Parses JSONL events from Codex CLI                     |
| OpenCode | `src/flightpath/harness/opencode/OpenCodeLogParser.ts` | Parses OpenCode streaming JSON events                  |

---

## Dashboard Integration

The React webview receives `DashboardOutput` via `MESSAGE_TYPES.CLI_RESPONSE`. Event rendering is handled by:

- `src/ui/webview-react/components/output/ToolCallOutput.tsx` — tool calls, file edits with diff
- `src/ui/webview-react/utils/outputUtils.ts` — markdown export and text formatting
- `src/ui/webview-react/types/cliEvents.ts` — re-exports from `CliOutputTypes` for webview use

---

## Tests

`src/test/unit/CliOutputFormatter.test.ts` covers `toPlainText()`, `toDashboardFormat()`, and `formatStatistics()`.

---

## Provider-Specific Notes

### Claude CLI

- Provides `structuredPatch` (unified diff with line numbers) in `FileEditData`
- Populates `thinkingBlocks` during extended thinking sessions
- Uses `cache_creation_input_tokens` and `cache_read_input_tokens`

### Copilot CLI

- Provides `oldContent`/`newContent` in file edit events for diff generation

### Codex CLI

- Only provides `{path, kind}` in file change events — no diff data available
- ANSI escape codes are stripped in `CodexResponseParser.ts` before event creation
- Uses `reasoningOutputTokens` for o-series models
