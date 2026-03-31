# Codex CLI JSON Response Schema Reference

**Version**: Codex CLI v0.44.0+
**Format**: JSONL (JSON Lines)
**Last Updated**: 2026-01-28

## Overview

This document provides a comprehensive schema reference for OpenAI Codex CLI JSON output format (via `--json` flag) based on official TypeScript SDK types and real-world testing.

### Output Format

**Flag**: `--json`

**Format**: JSONL (JSON Lines) - one JSON object per line written to stdout

**Purpose**: Machine-readable event stream for programmatic consumption, automation, CI/CD integration

**TypeScript SDK**: `@openai/codex-sdk` - Official package with complete type definitions

### When This Format is Used

The `--json` flag enables JSONL output for **headless/non-interactive mode**:

```bash
codex exec --json "your prompt here"
```

**Key Characteristics**:

- Real-time streaming of events to stdout as they occur
- Each line is independent JSON (not a single JSON array)
- Events arrive chronologically but timing is not guaranteed
- Can be combined with `--output-last-message <path>` for final response
- Session IDs available via `thread.started` event for resumption

### Session Persistence

**Automatic JSONL Logs**:

All sessions (interactive and non-interactive) are automatically saved:

```
$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<thread-id>.jsonl
```

**Default Path**:

```
~/.codex/sessions/YYYY/MM/DD/rollout-0199a213-81c0-7800-8aa1-bbab2a035a53.jsonl
```

**File Structure**:

1. **Metadata header** (first line): Session information
2. **Event stream** (subsequent lines): All events in chronological order

---

## Event Type Summary

The Codex JSON format uses **8 distinct event types**:

| Event Type       | Description                                       |
| ---------------- | ------------------------------------------------- |
| `thread.started` | Session initialization with thread ID             |
| `turn.started`   | User prompt submitted, agent begins processing    |
| `turn.completed` | Turn finishes successfully (includes token usage) |
| `turn.failed`    | Turn encounters fatal error                       |
| `item.started`   | Work item created and begins processing           |
| `item.updated`   | Work item state changes during processing         |
| `item.completed` | Work item reaches terminal state                  |
| `error`          | Top-level error (non-item-specific)               |

**Total Event Types**: 8

---

## Item Type Summary

Items represent discrete units of work. The Codex JSON format includes **8 item types**:

| Item Type           | Description                                         |
| ------------------- | --------------------------------------------------- |
| `agent_message`     | Assistant's text response or structured JSON output |
| `reasoning`         | Agent's internal reasoning/thinking process         |
| `command_execution` | Shell command with output and status                |
| `file_change`       | File modifications (add/update/delete)              |
| `mcp_tool_call`     | Model Context Protocol tool invocation              |
| `web_search`        | Web search query performed by agent                 |
| `todo_list`         | Agent's task list with completion tracking          |
| `error`             | Non-fatal error as item (vs. top-level error)       |
| `unknown`           | Forward compatibility for unrecognized types        |

**Total Item Types**: 8 (+ 1 for forward compatibility)

---

## Common Event Structure

**All events share these required fields**:

```typescript
interface BaseEvent {
  type: string; // Event type discriminator
  // Additional fields vary by event type
}
```

**Discriminated Union Pattern**:

The `type` field determines which additional fields are present. Use TypeScript discriminated unions for type-safe parsing.

---

## Event Type Schemas

### 1. `thread.started`

**Description**: First event in session, provides thread ID for resumption

**Frequency**: 1 per session (always first event)

**Fields**:

```typescript
interface ThreadStartedEvent {
  type: "thread.started";
  thread_id: string; // UUID format for session resumption
}
```

**Example**:

```json
{
  "type": "thread.started",
  "thread_id": "0199a213-81c0-7800-8aa1-bbab2a035a53"
}
```

**Notes**:

- `thread_id` is required for session resumption via `--thread-id <id>` flag
- UUID format (8-4-4-4-12 hex digits)
- Always `parentId: null` equivalent (root event)

---

### 2. `turn.started`

**Description**: Marks beginning of agent turn (prompt processing starts)

**Frequency**: 1 per user prompt

**Fields**:

```typescript
interface TurnStartedEvent {
  type: "turn.started";
}
```

**Example**:

```json
{ "type": "turn.started" }
```

**Notes**:

- No additional fields
- Pairs with `turn.completed` or `turn.failed`
- Followed by item events (item.started, item.updated, item.completed)

---

### 3. `turn.completed`

**Description**: Turn finishes successfully, provides token usage statistics

**Frequency**: 1 per successful turn

**Fields**:

```typescript
interface TurnCompletedEvent {
  type: "turn.completed";
  usage: Usage;
}

interface Usage {
  input_tokens: number; // Total input tokens (including cached)
  cached_input_tokens: number; // Tokens served from cache
  output_tokens: number; // Generated output tokens
}
```

**Example**:

```json
{
  "type": "turn.completed",
  "usage": {
    "input_tokens": 24763,
    "cached_input_tokens": 24448,
    "output_tokens": 122
  }
}
```

**Notes**:

- `input_tokens` includes `cached_input_tokens` (total input)
- `cached_input_tokens` indicates cache hits (lower cost)
- `output_tokens` is generated tokens only
- Total cost = (input*tokens - cached_input_tokens) * input*rate + output_tokens * output_rate

---

### 4. `turn.failed`

**Description**: Turn encounters fatal error

**Frequency**: 0-1 per turn (only when errors occur)

**Fields**:

```typescript
interface TurnFailedEvent {
  type: "turn.failed";
  error: ThreadError;
}

interface ThreadError {
  message: string; // Human-readable error message
}
```

**Example**:

```json
{
  "type": "turn.failed",
  "error": {
    "message": "Model API request failed: timeout after 60s"
  }
}
```

**Notes**:

- Mutually exclusive with `turn.completed`
- Session may continue after error (not necessarily fatal)
- Check for this event to detect failures

---

### 5. `item.started`

**Description**: Work item created and begins processing

**Frequency**: 1 per item (pairs with `item.completed`)

**Fields**:

```typescript
interface ItemStartedEvent {
  type: "item.started";
  item: ThreadItem; // Type-specific item data
}
```

**Example** (reasoning):

```json
{
  "type": "item.started",
  "item": {
    "id": "item_0",
    "type": "reasoning",
    "text": "**Searching for README files**"
  }
}
```

**Example** (command):

```json
{
  "type": "item.started",
  "item": {
    "id": "item_1",
    "type": "command_execution",
    "command": "bash -lc ls",
    "aggregated_output": "",
    "status": "in_progress"
  }
}
```

**Notes**:

- Item lifecycle: `item.started` → `item.updated` (0+) → `item.completed`
- `item.updated` events are optional (depends on item type)
- `item` field structure varies by item type (see Item Type Schemas below)

---

### 6. `item.updated`

**Description**: Work item state changes during processing (progressive updates)

**Frequency**: 0+ per item (varies by item type)

**Fields**:

```typescript
interface ItemUpdatedEvent {
  type: "item.updated";
  item: ThreadItem; // Updated item data
}
```

**Example** (command output):

```json
{
  "type": "item.updated",
  "item": {
    "id": "item_1",
    "type": "command_execution",
    "command": "bash -lc ls",
    "aggregated_output": "docs\nsdk\nexamples\n",
    "status": "in_progress"
  }
}
```

**Notes**:

- Common for `command_execution` (streaming output)
- Less common for other item types
- `aggregated_output` grows progressively with each update
- Parse delta by comparing to previous update

---

### 7. `item.completed`

**Description**: Work item reaches terminal state

**Frequency**: 1 per item (pairs with `item.started`)

**Fields**:

```typescript
interface ItemCompletedEvent {
  type: "item.completed";
  item: ThreadItem; // Final item data
}
```

**Example** (command):

```json
{
  "type": "item.completed",
  "item": {
    "id": "item_1",
    "type": "command_execution",
    "command": "bash -lc ls",
    "aggregated_output": "docs\nsdk\nexamples\n",
    "exit_code": 0,
    "status": "completed"
  }
}
```

**Example** (message):

```json
{
  "type": "item.completed",
  "item": {
    "id": "item_3",
    "type": "agent_message",
    "text": "Repo contains docs, sdk, and examples directories."
  }
}
```

**Notes**:

- Final state may include additional fields (e.g., `exit_code` for commands)
- Use this event to extract final results
- Check `status` field for success/failure (when present)

---

### 8. `error` (Top-Level)

**Description**: Non-item-specific errors

**Frequency**: 0+ per session (only when errors occur)

**Fields**:

```typescript
interface ErrorEvent {
  type: "error";
  message: string; // Error description
}
```

**Example**:

```json
{
  "type": "error",
  "message": "Failed to initialize MCP server: connection refused"
}
```

**Notes**:

- Different from `turn.failed` (turn-level) and `error` items (item-level)
- May occur outside turn boundaries
- Indicates session-level issues

---

## Item Type Schemas

### Common Item Fields

**All items share these base fields**:

```typescript
interface BaseItem {
  id: string; // Unique item identifier (e.g., "item_0", "item_1")
  type: string; // Item type discriminator
}
```

**Item ID Format**: `item_<number>` (sequential integers starting at 0)

---

### 1. `agent_message` Item

**Purpose**: Assistant's final text response or structured JSON output

**Fields**:

```typescript
interface AgentMessageItem {
  id: string;
  type: "agent_message";
  text: string; // Response text (may be markdown or JSON string)
}
```

**Example** (text):

```json
{
  "id": "item_3",
  "type": "agent_message",
  "text": "Repo contains docs, sdk, and examples directories."
}
```

**Example** (JSON):

```json
{
  "id": "item_5",
  "type": "agent_message",
  "text": "{\"files\":[\"README.md\",\"package.json\"],\"status\":\"complete\"}"
}
```

**Notes**:

- `text` may contain markdown formatting
- When using `--output-schema`, `text` is JSON string (validate with schema)
- Parse as final response from agent
- May be only item in simple turns

---

### 2. `reasoning` Item

**Purpose**: Agent's internal reasoning/thinking process (chain-of-thought)

**Fields**:

```typescript
interface ReasoningItem {
  id: string;
  type: "reasoning";
  text: string; // Reasoning summary (often markdown formatted)
}
```

**Example**:

```json
{
  "id": "item_0",
  "type": "reasoning",
  "text": "**Searching for README files**\n\nI need to explore the repository structure to understand the codebase."
}
```

**Notes**:

- Often markdown formatted with `**Headers**`
- Shows agent's decision-making process
- May precede tool calls or messages
- Not present in all sessions (depends on model behavior)

---

### 3. `command_execution` Item

**Purpose**: Shell command execution with output and status

**Fields**:

```typescript
interface CommandExecutionItem {
  id: string;
  type: "command_execution";
  command: string; // Full shell command
  aggregated_output: string; // Combined stdout/stderr
  exit_code?: number; // Exit code (present when completed)
  status: CommandExecutionStatus; // Execution state
}

type CommandExecutionStatus =
  | "in_progress" // Command is running
  | "completed" // Command finished successfully (exit_code present)
  | "failed"; // Command exited with non-zero code
```

**Lifecycle Examples**:

**item.started** (initial):

```json
{
  "id": "item_1",
  "type": "command_execution",
  "command": "bash -lc ls",
  "aggregated_output": "",
  "status": "in_progress"
}
```

**item.updated** (progressive):

```json
{
  "id": "item_1",
  "type": "command_execution",
  "command": "bash -lc ls",
  "aggregated_output": "docs\nsdk\n",
  "status": "in_progress"
}
```

**item.completed** (final):

```json
{
  "id": "item_1",
  "type": "command_execution",
  "command": "bash -lc ls",
  "aggregated_output": "docs\nsdk\nexamples\n",
  "exit_code": 0,
  "status": "completed"
}
```

**Notes**:

- `aggregated_output` grows with each `item.updated` event
- `exit_code` only present in `item.completed`
- `status: "completed"` does not guarantee `exit_code: 0` (may be non-zero)
- Check `exit_code` for actual success/failure
- Stream output by parsing deltas between updates

---

### 4. `file_change` Item

**Purpose**: File modifications (add/update/delete operations)

**Fields**:

```typescript
interface FileChangeItem {
  id: string;
  type: "file_change";
  changes: FileUpdateChange[]; // List of file modifications
  status: PatchApplyStatus; // Overall patch result
}

interface FileUpdateChange {
  path: string; // File path relative to workspace
  kind: PatchChangeKind; // Type of modification
}

type PatchChangeKind =
  | "add" // New file created
  | "delete" // File removed
  | "update"; // Existing file modified

type PatchApplyStatus =
  | "completed" // All changes applied successfully
  | "failed"; // One or more changes failed
```

**Example**:

```json
{
  "id": "item_2",
  "type": "file_change",
  "changes": [
    { "path": "src/main.ts", "kind": "update" },
    { "path": "src/utils.ts", "kind": "add" },
    { "path": "old/legacy.ts", "kind": "delete" }
  ],
  "status": "completed"
}
```

**Notes**:

- `changes` is array (multiple files may change in one item)
- `kind` indicates operation type (add/update/delete)
- `path` is relative to workspace root
- `status: "failed"` may occur if permissions denied or file locked
- Use to track file modifications during execution

---

### 5. `mcp_tool_call` Item

**Purpose**: Model Context Protocol (MCP) tool invocation

**Fields**:

```typescript
interface McpToolCallItem {
  id: string;
  type: "mcp_tool_call";
  server: string; // MCP server name
  tool: string; // Tool name invoked
  status: McpToolCallStatus;
}

type McpToolCallStatus =
  | "in_progress" // Tool is executing
  | "completed" // Tool finished successfully
  | "failed"; // Tool execution failed
```

**Example**:

```json
{
  "id": "item_4",
  "type": "mcp_tool_call",
  "server": "github",
  "tool": "search_repositories",
  "status": "completed"
}
```

**Notes**:

- `server` matches MCP server name from config
- `tool` is tool identifier within that server
- Status transitions: `in_progress` → `completed`/`failed`
- Tool results incorporated into agent's context (not directly visible)

---

### 6. `web_search` Item

**Purpose**: Web search query performed by agent

**Fields**:

```typescript
interface WebSearchItem {
  id: string;
  type: "web_search";
  query: string; // Search query text
}
```

**Example**:

```json
{
  "id": "item_5",
  "type": "web_search",
  "query": "TypeScript best practices 2026"
}
```

**Notes**:

- Results not included in this item (incorporated into agent's reasoning)
- Query is user-visible intent
- Subsequent `reasoning` or `agent_message` items will reference results

---

### 7. `todo_list` Item

**Purpose**: Agent's task list with completion tracking

**Fields**:

```typescript
interface TodoListItem {
  id: string;
  type: "todo_list";
  items: TodoItem[];
}

interface TodoItem {
  text: string; // Task description
  completed: boolean; // Completion status
}
```

**Example**:

```json
{
  "id": "item_6",
  "type": "todo_list",
  "items": [
    { "text": "Analyze repository structure", "completed": true },
    { "text": "Identify main entry points", "completed": false },
    { "text": "Document API endpoints", "completed": false }
  ]
}
```

**Notes**:

- Progressive completion tracking via `item.updated` events
- `completed` transitions from `false` → `true`
- Useful for long-running multi-step tasks
- Provides visibility into agent's progress

---

### 8. `error` Item

**Purpose**: Non-fatal errors as items (vs. top-level error events)

**Fields**:

```typescript
interface ErrorItem {
  id: string;
  type: "error";
  message: string; // Error description
}
```

**Example**:

```json
{
  "id": "item_7",
  "type": "error",
  "message": "Failed to read file: permission denied"
}
```

**Notes**:

- Item-level errors (vs. turn-level or session-level)
- Non-fatal (turn continues after error item)
- Agent may recover and continue processing
- Check `message` for error details

---

### 9. `unknown` Item (Forward Compatibility)

**Purpose**: Unrecognized item types (future-proofing)

**Fields**:

```typescript
interface UnknownThreadItem {
  type: string; // Raw item type string (not recognized)
  // Additional fields preserved as raw JSON
}
```

**Example** (hypothetical future type):

```json
{
  "id": "item_8",
  "type": "code_review",
  "file": "src/main.ts",
  "issues": 5
}
```

**Notes**:

- SDK provides `UnknownThreadItem` for graceful handling
- New item types may be added in future versions
- Parse unknown types as generic objects
- Log warnings for unrecognized types

---

## Complete TypeScript Interfaces

### Event Union Type

```typescript
/**
 * All event types as discriminated union
 */
type ThreadEvent =
  | ThreadStartedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | ItemStartedEvent
  | ItemUpdatedEvent
  | ItemCompletedEvent
  | ErrorEvent;

interface ThreadStartedEvent {
  type: "thread.started";
  thread_id: string;
}

interface TurnStartedEvent {
  type: "turn.started";
}

interface TurnCompletedEvent {
  type: "turn.completed";
  usage: Usage;
}

interface TurnFailedEvent {
  type: "turn.failed";
  error: ThreadError;
}

interface ItemStartedEvent {
  type: "item.started";
  item: ThreadItem;
}

interface ItemUpdatedEvent {
  type: "item.updated";
  item: ThreadItem;
}

interface ItemCompletedEvent {
  type: "item.completed";
  item: ThreadItem;
}

interface ErrorEvent {
  type: "error";
  message: string;
}
```

### Item Union Type

```typescript
/**
 * All item types as discriminated union
 */
type ThreadItem =
  | AgentMessageItem
  | ReasoningItem
  | CommandExecutionItem
  | FileChangeItem
  | McpToolCallItem
  | WebSearchItem
  | TodoListItem
  | ErrorItem
  | UnknownThreadItem;

interface AgentMessageItem {
  id: string;
  type: "agent_message";
  text: string;
}

interface ReasoningItem {
  id: string;
  type: "reasoning";
  text: string;
}

interface CommandExecutionItem {
  id: string;
  type: "command_execution";
  command: string;
  aggregated_output: string;
  exit_code?: number;
  status: "in_progress" | "completed" | "failed";
}

interface FileChangeItem {
  id: string;
  type: "file_change";
  changes: FileUpdateChange[];
  status: "completed" | "failed";
}

interface FileUpdateChange {
  path: string;
  kind: "add" | "delete" | "update";
}

interface McpToolCallItem {
  id: string;
  type: "mcp_tool_call";
  server: string;
  tool: string;
  status: "in_progress" | "completed" | "failed";
}

interface WebSearchItem {
  id: string;
  type: "web_search";
  query: string;
}

interface TodoListItem {
  id: string;
  type: "todo_list";
  items: TodoItem[];
}

interface TodoItem {
  text: string;
  completed: boolean;
}

interface ErrorItem {
  id: string;
  type: "error";
  message: string;
}

interface UnknownThreadItem {
  type: string;
  [key: string]: any;
}
```

### Supporting Types

```typescript
/**
 * Token usage statistics
 */
interface Usage {
  input_tokens: number; // Total input tokens (including cached)
  cached_input_tokens: number; // Tokens served from cache
  output_tokens: number; // Generated output tokens
}

/**
 * Error information
 */
interface ThreadError {
  message: string; // Human-readable error message
}

/**
 * Command execution status
 */
type CommandExecutionStatus = "in_progress" | "completed" | "failed";

/**
 * Patch application status
 */
type PatchApplyStatus = "completed" | "failed";

/**
 * File change kind
 */
type PatchChangeKind = "add" | "delete" | "update";

/**
 * MCP tool call status
 */
type McpToolCallStatus = "in_progress" | "completed" | "failed";
```

---

## Token Usage Structure

### Usage Object Fields

The `usage` object in `turn.completed` events provides comprehensive token statistics:

```typescript
interface Usage {
  input_tokens: number; // Total input tokens (including cached)
  cached_input_tokens: number; // Tokens served from cache
  output_tokens: number; // Generated output tokens
}
```

### Field Descriptions

| Field                 | Type   | Description                                                     |
| --------------------- | ------ | --------------------------------------------------------------- |
| `input_tokens`        | number | Total input tokens sent to model (includes cached_input_tokens) |
| `cached_input_tokens` | number | Input tokens served from prompt cache (lower cost)              |
| `output_tokens`       | number | Generated output tokens (response)                              |

### Calculating Costs

```typescript
function calculateCost(
  usage: Usage,
  inputRate: number,
  outputRate: number
): number {
  const uncachedInputTokens = usage.input_tokens - usage.cached_input_tokens;
  const inputCost = uncachedInputTokens * inputRate;
  const outputCost = usage.output_tokens * outputRate;
  return inputCost + outputCost;
}
```

### Example Usage Data

```json
{
  "input_tokens": 24763,
  "cached_input_tokens": 24448,
  "output_tokens": 122
}
```

**Interpretation**:

- Total input: 24,763 tokens
- Cached (from previous turns): 24,448 tokens (98.7% cache hit rate)
- New input: 315 tokens (24,763 - 24,448)
- Output generated: 122 tokens

**Cost Calculation** (example rates):

- Uncached input: 315 tokens × $0.01/1K = $0.00315
- Output: 122 tokens × $0.03/1K = $0.00366
- Total: $0.00681

---

## Usage Patterns

### 1. Parsing JSONL Stream

```typescript
import * as fs from "fs";
import * as readline from "readline";

async function parseCodexJsonl(filePath: string): Promise<ThreadEvent[]> {
  const events: ThreadEvent[] = [];
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed) {
      try {
        const event = JSON.parse(trimmed) as ThreadEvent;
        events.push(event);
      } catch (error) {
        console.error("Failed to parse line:", line, error);
      }
    }
  }

  return events;
}
```

### 2. Completion Detection

```typescript
interface ExecutionResult {
  success: boolean;
  response?: string;
  usage?: Usage;
  error?: string;
}

function detectCompletion(events: ThreadEvent[]): ExecutionResult {
  // Check for turn completion
  const completed = events.find((e) => e.type === "turn.completed");
  if (completed) {
    const response = extractAgentResponse(events);
    return {
      success: true,
      response,
      usage: (completed as TurnCompletedEvent).usage,
    };
  }

  // Check for turn failure
  const failed = events.find((e) => e.type === "turn.failed");
  if (failed) {
    return {
      success: false,
      error: (failed as TurnFailedEvent).error.message,
    };
  }

  // Incomplete
  return {
    success: false,
    error: "Turn did not complete",
  };
}

function extractAgentResponse(events: ThreadEvent[]): string {
  const messages = events
    .filter(
      (e) => e.type === "item.completed" && e.item.type === "agent_message"
    )
    .map((e) => (e as ItemCompletedEvent).item as AgentMessageItem);

  // Return last message (typically the final response)
  return messages[messages.length - 1]?.text || "";
}
```

### 3. Session Resumption

```typescript
function extractSessionId(events: ThreadEvent[]): string | null {
  const startEvent = events.find((e) => e.type === "thread.started");
  return startEvent ? (startEvent as ThreadStartedEvent).thread_id : null;
}

// Usage
const output = await runCodexCommand("--json", "initial prompt");
const events = parseJsonlOutput(output);
const sessionId = extractSessionId(events);

if (sessionId) {
  // Resume in next prompt
  await runCodexCommand("--json", "--thread-id", sessionId, "follow-up");
}
```

### 4. Progressive Command Output

```typescript
function streamCommandOutput(events: AsyncIterable<ThreadEvent>): void {
  const commandStates = new Map<string, string>();

  for await (const event of events) {
    if (
      event.type === "item.updated" &&
      event.item.type === "command_execution"
    ) {
      const item = event.item as CommandExecutionItem;
      const previousOutput = commandStates.get(item.id) || "";
      const newOutput = item.aggregated_output.slice(previousOutput.length);

      if (newOutput) {
        console.log(newOutput); // Stream new output
        commandStates.set(item.id, item.aggregated_output);
      }
    }
  }
}
```

### 5. Token Usage Tracking

```typescript
interface TokenStats {
  totalInputTokens: number;
  totalCachedInputTokens: number;
  totalOutputTokens: number;
  turnCount: number;
}

function calculateTokenUsage(events: ThreadEvent[]): TokenStats {
  const completions = events.filter((e) => e.type === "turn.completed");

  return completions.reduce(
    (acc, event) => {
      const usage = (event as TurnCompletedEvent).usage;
      return {
        totalInputTokens: acc.totalInputTokens + usage.input_tokens,
        totalCachedInputTokens:
          acc.totalCachedInputTokens + usage.cached_input_tokens,
        totalOutputTokens: acc.totalOutputTokens + usage.output_tokens,
        turnCount: acc.turnCount + 1,
      };
    },
    {
      totalInputTokens: 0,
      totalCachedInputTokens: 0,
      totalOutputTokens: 0,
      turnCount: 0,
    }
  );
}
```

---

## Integration Notes for FlightPath

### How FlightPath Uses This Format

**Component**: `CodexResponseParser`

**Location**: `src/flightpath/cli/codex/CodexResponseParser.ts`

**Purpose**: Parse JSONL output from Codex CLI to extract responses, detect completion, and track token usage

### Key Integration Points

1. **Completion Detection**:
   - Parse JSONL stream line-by-line
   - Wait for `turn.completed` event
   - Handle `turn.failed` as error

2. **Response Extraction**:
   - Find all `item.completed` events with `type: "agent_message"`
   - Extract `text` field from last message
   - Return as agent response

3. **Token Usage**:
   - Extract `usage` object from `turn.completed`
   - Map to FlightPath's token statistics format
   - Display in dashboard/output panel

4. **Session Resumption**:
   - Extract `thread_id` from first `thread.started` event
   - Store in working file metadata
   - Pass to next prompt via `--thread-id` flag

5. **Error Handling**:
   - Detect `turn.failed` events
   - Extract error message
   - Report to user via notification

### Example Implementation

```typescript
export class CodexResponseParser implements IResponseParser {
  parseResponse(output: string): {
    response: string;
    usage: TokenUsage | null;
  } {
    const lines = output.split("\n").filter((line) => line.trim());
    const events: ThreadEvent[] = lines.map((line) => JSON.parse(line));

    // Extract response
    const response = this.extractAgentResponse(events);

    // Extract token usage
    const usage = this.extractTokenUsage(events);

    return { response, usage };
  }

  private extractAgentResponse(events: ThreadEvent[]): string {
    const messages = events
      .filter(
        (e) => e.type === "item.completed" && e.item.type === "agent_message"
      )
      .map((e) => (e.item as AgentMessageItem).text);

    return messages[messages.length - 1] || "";
  }

  private extractTokenUsage(events: ThreadEvent[]): TokenUsage | null {
    const completed = events.find((e) => e.type === "turn.completed");
    if (!completed) return null;

    const usage = (completed as TurnCompletedEvent).usage;
    return {
      inputTokens: usage.input_tokens - usage.cached_input_tokens,
      cachedInputTokens: usage.cached_input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.input_tokens + usage.output_tokens,
    };
  }
}
```

---

## TypeScript SDK Integration

### Installation

```bash
npm install @openai/codex-sdk
```

**Requirements**: Node.js 18+

### Package Information

- **NPM**: `@openai/codex-sdk`
- **GitHub**: `https://github.com/openai/codex/tree/main/sdk/typescript`
- **Source**: `https://github.com/openai/codex/tree/main/sdk/typescript/src`

### Key Source Files

1. **events.ts** - Event type definitions and discriminated unions
2. **items.ts** - Item data structures and type guards
3. **thread.ts** - Thread management and streaming API
4. **codex.ts** - Core Codex client implementation
5. **turnOptions.ts** - Turn configuration options
6. **threadOptions.ts** - Thread configuration options

### Usage Example: Streaming Events

```typescript
import { Codex } from "@openai/codex-sdk";

const codex = new Codex();
const thread = await codex.startThread();

const { events } = await thread.runStreamed("Analyze this codebase");

for await (const event of events) {
  switch (event.type) {
    case "thread.started":
      console.log(`Session ID: ${event.thread_id}`);
      break;

    case "turn.started":
      console.log("Agent is processing...");
      break;

    case "item.started":
      console.log(`Started: ${event.item.type} (${event.item.id})`);
      break;

    case "item.updated":
      if (event.item.type === "command_execution") {
        console.log(`Output: ${event.item.aggregated_output}`);
      }
      break;

    case "item.completed":
      console.log(`Completed: ${event.item.type} (${event.item.id})`);
      if (event.item.type === "agent_message") {
        console.log(`Response: ${event.item.text}`);
      }
      break;

    case "turn.completed":
      console.log(
        `Tokens: ${event.usage.input_tokens} in, ${event.usage.output_tokens} out`
      );
      break;

    case "turn.failed":
      console.error(`Error: ${event.error.message}`);
      break;
  }
}
```

### Usage Example: Buffered Turn

```typescript
// Alternative: Buffer all events until turn completes
const turn = await thread.run("Summarize repository");

// Access completed items
for (const item of turn.Items) {
  if (item.type === "agent_message") {
    console.log(item.text);
  }
}

// Access usage stats
if (turn.Usage) {
  console.log(`Used ${turn.Usage.output_tokens} output tokens`);
}
```

### Generating TypeScript Schema

Codex provides a command to generate TypeScript types from internal schema:

```bash
codex app-server generate-ts
```

This outputs TypeScript type definitions matching the current version's JSONL protocol.

---

## Real JSON Examples

### Example Session Stream

**Complete JSONL stream for a simple query**:

```jsonl
{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_0","type":"reasoning","text":"**Searching for README files**\n\nI need to explore the repository structure to understand the codebase."}}
{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"**Searching for README files**\n\nI need to explore the repository structure to understand the codebase."}}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","aggregated_output":"","status":"in_progress"}}
{"type":"item.updated","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","aggregated_output":"docs\n","status":"in_progress"}}
{"type":"item.updated","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","aggregated_output":"docs\nsdk\n","status":"in_progress"}}
{"type":"item.updated","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","aggregated_output":"docs\nsdk\nexamples\n","status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","aggregated_output":"docs\nsdk\nexamples\n","exit_code":0,"status":"completed"}}
{"type":"item.started","item":{"id":"item_2","type":"agent_message","text":"Repo contains docs, sdk, and examples directories."}}
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Repo contains docs, sdk, and examples directories."}}
{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122}}
```

**Interpretation**:

1. **Session start**: Thread ID for resumption
2. **Turn start**: User prompt submitted
3. **Reasoning** (item_0): Agent's thinking process
4. **Command execution** (item_1): Progressive output updates
5. **Agent message** (item_2): Final response
6. **Turn completion**: Token usage statistics

---

## Important Notes & Caveats

### 1. Documentation Discrepancies

**Field Name Changes** (v0.44.0+):

- Older documentation shows `"item_type"` but current CLI outputs `"type"`
- Older documentation shows `"assistant_message"` but current CLI outputs `"agent_message"`

**Impact**: Always use current SDK types rather than old documentation examples

### 2. Schema Evolution

- The `UnknownThreadItem` type provides forward compatibility
- New item types may be added in future versions
- Always handle unknown types gracefully

### 3. JSONL Parsing Considerations

- Each line is independent JSON (not a single JSON array)
- Empty lines should be filtered out
- Malformed lines should be handled gracefully
- Events arrive in chronological order but timing is not guaranteed

### 4. Output Redirect Behavior

- `--json` writes to stdout only
- Stderr may still contain progress indicators or errors
- Redirect stderr separately if needed: `codex exec --json "prompt" 2>stderr.log`

### 5. Performance Considerations

- Large command outputs can result in many `item.updated` events
- Consider buffering updates to avoid processing overhead
- Session log files can grow large for long-running sessions

---

## Related CLI Flags & Features

### Output Control Flags

**`--json`**:

- **Purpose**: Enable JSONL event stream to stdout
- **Format**: Newline-delimited JSON
- **Usage**: `codex exec --json "prompt"`

**`--output-last-message <path>` / `-o <path>`**:

- **Purpose**: Write final agent message to file
- **Format**: Plain text (not JSON)
- **Usage**: `codex exec --json --output-last-message summary.txt "prompt"`
- **Benefit**: Capture both machine-readable events (stdout) and human-readable summary (file)

**`--output-schema <schema-file>`**:

- **Purpose**: Request structured JSON response conforming to JSON Schema
- **Format**: JSON Schema specification
- **Usage**: `codex exec --output-schema schema.json "extract data"`
- **Note**: Validates final response against provided schema

### Session Management Flags

**`--thread-id <id>`**:

- **Purpose**: Resume existing conversation thread
- **Source**: `thread_id` from `thread.started` event
- **Usage**: `codex exec --thread-id "0199a213..." "follow-up prompt"`

---

## Related Resources

### Official Documentation

- [Codex CLI Features](https://developers.openai.com/codex/cli/features/)
- [Non-interactive Mode](https://developers.openai.com/codex/noninteractive/)
- [Command Line Options](https://developers.openai.com/codex/cli/reference/)
- [Codex SDK Documentation](https://developers.openai.com/codex/sdk/)
- [Advanced Configuration](https://developers.openai.com/codex/config-advanced/)

### GitHub Resources

- [OpenAI Codex Repository](https://github.com/openai/codex)
- [TypeScript SDK Source](https://github.com/openai/codex/tree/main/sdk/typescript)
- [TypeScript SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)
- [Codex exec.md Documentation](https://github.com/openai/codex/blob/main/docs/exec.md)
- [Codex config.md Documentation](https://github.com/openai/codex/blob/main/docs/config.md)

### Community Resources

- [Go SDK Package Documentation](https://pkg.go.dev/github.com/picatz/openai/codex)
- [Elixir Codex SDK](https://hexdocs.pm/codex_sdk/)
- [Promptfoo Codex Integration](https://www.promptfoo.dev/docs/providers/openai-codex-sdk/)

### GitHub Issues & Discussions

- [CLI flag to save trajectory/output as JSON #2288](https://github.com/openai/codex/issues/2288)
- [Hook feature request #2150](https://github.com/openai/codex/discussions/2150)
- [Native OS notification feature request #4998](https://github.com/openai/codex/issues/4998)
- [Notifications for approval prompts #3052](https://github.com/openai/codex/issues/3052)
- [JSON output mode docs out of date #4776](https://github.com/openai/codex/issues/4776)
- [Provide JSON Schema for --json flag output #1673](https://github.com/openai/codex/issues/1673)
- [Session ID in non-interactive prompts #1780](https://github.com/openai/codex/issues/1780)

---

## Changelog

### 2026-01-28

- Initial schema documentation
- Based on Codex CLI v0.44.0+ research
- 8 event types documented
- 9 item types documented (including forward compatibility)
- Complete TypeScript interfaces from `@openai/codex-sdk`
- Real-world JSON examples included
- FlightPath integration notes added

---

**Document Version**: 1.0
**Based on**: Codex CLI v0.44.0+, `@openai/codex-sdk` TypeScript types
**Research Source**: `docs/CODEX_CLI_JSON_FORMAT_RESEARCH.md`
**Analysis Date**: 2026-01-28

---

**End of Schema Reference**
