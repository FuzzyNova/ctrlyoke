# Codex CLI JSON Output Format Research

**Research Date:** 2026-01-28
**Codex CLI Version:** Based on latest available documentation (v0.44.0+)
**Research Scope:** Complete investigation of `--json` flag JSONL output format

## Executive Summary

The OpenAI Codex CLI provides a `--json` flag that outputs **JSON Lines (JSONL)** format to stdout, enabling programmatic consumption of real-time execution events. The format uses a streaming event-based architecture with strongly-typed events and items. Official TypeScript types are available via the `@openai/codex-sdk` package, and schema generation is possible via `codex app-server generate-ts`.

**Key Findings:**
- **8 Item Types**: agent_message, reasoning, command_execution, file_change, mcp_tool_call, web_search, todo_list, error
- **8 Event Types**: thread.started, turn.started, turn.completed, turn.failed, item.started, item.updated, item.completed, error
- **Progressive Streaming**: Items emit .started → .updated (0+) → .completed lifecycle
- **Token Usage**: Available in turn.completed events
- **Session Persistence**: Automatic JSONL logs saved to `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`

---

## 1. JSONL Output Format Overview

### Activation

```bash
codex exec --json "your prompt here"
```

### Output Characteristics

- **Format**: JSON Lines (JSONL) - one JSON object per line
- **Stream**: Writes to stdout in real-time as events occur
- **Purpose**: Machine-readable progress tracking for automation, CI/CD, and programmatic workflows
- **Pairing**: Can combine with `--output-last-message <path>` for both structured events and final summary

### Example JSONL Stream

```json
{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_0","type":"reasoning","text":"**Searching for README files**"}}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","aggregated_output":"","status":"in_progress"}}
{"type":"item.updated","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","aggregated_output":"docs\nsdk\nexamples\n","status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","aggregated_output":"docs\nsdk\nexamples\n","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Repo contains docs, sdk, and examples directories."}}
{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122}}
```

---

## 2. Event Type Definitions

All events follow a discriminated union pattern with a `type` field.

### 2.1 Thread Events

#### thread.started
- **When**: Session initialization
- **Purpose**: Provides thread_id for resumption
- **Fields**:
  - `type`: `"thread.started"`
  - `thread_id`: string (UUID format)

```json
{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}
```

#### turn.started
- **When**: User prompt submitted, agent begins processing
- **Purpose**: Marks beginning of turn boundary
- **Fields**:
  - `type`: `"turn.started"`

```json
{"type":"turn.started"}
```

#### turn.completed
- **When**: Turn finishes successfully
- **Purpose**: Provides token usage statistics
- **Fields**:
  - `type`: `"turn.completed"`
  - `usage`: Usage object

```json
{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122}}
```

**Usage Object:**
```typescript
{
  input_tokens: number          // Total input tokens (including cached)
  cached_input_tokens: number   // Tokens served from cache
  output_tokens: number         // Generated output tokens
}
```

#### turn.failed
- **When**: Turn encounters fatal error
- **Purpose**: Reports error details
- **Fields**:
  - `type`: `"turn.failed"`
  - `error`: ThreadError object

```typescript
{
  type: "turn.failed"
  error: {
    message: string
  }
}
```

### 2.2 Item Events

Items represent discrete units of work (commands, messages, reasoning, etc.). Each item follows a lifecycle:

**Lifecycle:** `item.started` → `item.updated` (0 or more) → `item.completed`

#### item.started
- **When**: Item is created and begins processing
- **Fields**:
  - `type`: `"item.started"`
  - `item`: ThreadItem object (type-specific)

#### item.updated
- **When**: Item state changes during processing (progressive updates)
- **Fields**:
  - `type`: `"item.updated"`
  - `item`: ThreadItem object with updated fields
- **Use Case**: Streaming command output, progressive file changes

#### item.completed
- **When**: Item reaches terminal state
- **Fields**:
  - `type`: `"item.completed"`
  - `item`: ThreadItem object in final state

### 2.3 Error Events

#### error (top-level)
- **When**: Non-item-specific errors occur
- **Fields**:
  - `type`: `"error"`
  - `message`: string

---

## 3. Item Type Definitions

### 3.1 Item Type Enumeration

```typescript
type ItemType =
  | "agent_message"     // Assistant's text response
  | "reasoning"         // Agent's thinking summary
  | "command_execution" // Shell command with output
  | "file_change"       // File modifications
  | "mcp_tool_call"     // Model Context Protocol tool invocation
  | "web_search"        // Web search query
  | "todo_list"         // Agent's task list
  | "error"             // Non-fatal error
  | "unknown"           // Unrecognized type (forward compatibility)
```

### 3.2 Common Fields

All items share these base fields:
- `id`: string (unique identifier, e.g., "item_0", "item_1")
- `type`: ItemType (discriminator)

### 3.3 AgentMessageItem

**Purpose:** Contains the assistant's final text response or structured JSON output

**Fields:**
```typescript
{
  id: string
  type: "agent_message"
  text: string  // Assistant's response (may be formatted markdown or JSON string)
}
```

**Example:**
```json
{
  "id": "item_3",
  "type": "agent_message",
  "text": "Repo contains docs, sdk, and examples directories."
}
```

### 3.4 ReasoningItem

**Purpose:** Shows agent's internal reasoning/thinking process

**Fields:**
```typescript
{
  id: string
  type: "reasoning"
  text: string  // Reasoning summary (often markdown formatted)
}
```

**Example:**
```json
{
  "id": "item_0",
  "type": "reasoning",
  "text": "**Searching for README files**\n\nI need to explore the repository structure to understand the codebase."
}
```

### 3.5 CommandExecutionItem

**Purpose:** Records shell commands executed by the agent with output and status

**Fields:**
```typescript
{
  id: string
  type: "command_execution"
  command: string                      // Full shell command
  aggregated_output: string            // Combined stdout/stderr
  exit_code?: number                   // Exit code (present when completed)
  status: CommandExecutionStatus       // Current execution state
}

type CommandExecutionStatus =
  | "in_progress"  // Command is running
  | "completed"    // Command finished successfully
  | "failed"       // Command exited with non-zero code
```

**Example (in_progress):**
```json
{
  "id": "item_1",
  "type": "command_execution",
  "command": "bash -lc ls",
  "aggregated_output": "",
  "status": "in_progress"
}
```

**Example (completed):**
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

**Progressive Updates:**
- Initial `item.started`: status="in_progress", aggregated_output="" (empty)
- `item.updated` events: aggregated_output grows as command produces output
- Final `item.completed`: exit_code present, status="completed" or "failed"

### 3.6 FileChangeItem

**Purpose:** Aggregates file modifications as patches

**Fields:**
```typescript
{
  id: string
  type: "file_change"
  changes: FileUpdateChange[]  // List of file modifications
  status: PatchApplyStatus     // Overall patch result
}

interface FileUpdateChange {
  path: string          // File path relative to workspace
  kind: PatchChangeKind // Type of modification
}

type PatchChangeKind =
  | "add"     // New file created
  | "delete"  // File removed
  | "update"  // Existing file modified

type PatchApplyStatus =
  | "completed"  // All changes applied successfully
  | "failed"     // One or more changes failed
```

**Example:**
```json
{
  "id": "item_2",
  "type": "file_change",
  "changes": [
    {"path": "src/main.ts", "kind": "update"},
    {"path": "src/utils.ts", "kind": "add"}
  ],
  "status": "completed"
}
```

### 3.7 McpToolCallItem

**Purpose:** Documents Model Context Protocol (MCP) tool invocations

**Fields:**
```typescript
{
  id: string
  type: "mcp_tool_call"
  server: string           // MCP server name
  tool: string             // Tool name invoked
  status: McpToolCallStatus
}

type McpToolCallStatus =
  | "in_progress"  // Tool is executing
  | "completed"    // Tool finished successfully
  | "failed"       // Tool execution failed
```

**Example:**
```json
{
  "id": "item_4",
  "type": "mcp_tool_call",
  "server": "github",
  "tool": "search_repositories",
  "status": "completed"
}
```

### 3.8 WebSearchItem

**Purpose:** Captures web search queries performed by the agent

**Fields:**
```typescript
{
  id: string
  type: "web_search"
  query: string  // Search query text
}
```

**Example:**
```json
{
  "id": "item_5",
  "type": "web_search",
  "query": "TypeScript best practices 2026"
}
```

**Note:** Results are not included in this item; they're incorporated into subsequent reasoning/agent_message items.

### 3.9 TodoListItem

**Purpose:** Maintains agent's task list with completion tracking

**Fields:**
```typescript
{
  id: string
  type: "todo_list"
  items: TodoItem[]
}

interface TodoItem {
  text: string      // Task description
  completed: boolean
}
```

**Example:**
```json
{
  "id": "item_6",
  "type": "todo_list",
  "items": [
    {"text": "Analyze repository structure", "completed": true},
    {"text": "Identify main entry points", "completed": false},
    {"text": "Document API endpoints", "completed": false}
  ]
}
```

### 3.10 ErrorItem

**Purpose:** Reports non-fatal errors as items (vs. top-level error events)

**Fields:**
```typescript
{
  id: string
  type: "error"
  message: string  // Error description
}
```

**Example:**
```json
{
  "id": "item_7",
  "type": "error",
  "message": "Failed to read file: permission denied"
}
```

### 3.11 UnknownThreadItem

**Purpose:** Forward compatibility for unrecognized item types

**Fields:**
```typescript
{
  type: ItemType  // Raw item type string
  // Additional fields preserved as raw JSON
}
```

**Note:** Used by SDK to handle new item types without breaking existing code.

---

## 4. TypeScript SDK Integration

### 4.1 Installation

```bash
npm install @openai/codex-sdk
```

**Requirements:** Node.js 18+

### 4.2 Package Location

- **NPM:** `@openai/codex-sdk`
- **GitHub:** `https://github.com/openai/codex/tree/main/sdk/typescript`
- **Source:** `https://github.com/openai/codex/tree/main/sdk/typescript/src`

### 4.3 Key Source Files

The TypeScript SDK provides strongly-typed interfaces in these files:

1. **events.ts** - Event type definitions and discriminated unions
2. **items.ts** - Item data structures and type guards
3. **thread.ts** - Thread management and streaming API
4. **codex.ts** - Core Codex client implementation
5. **turnOptions.ts** - Turn configuration options
6. **threadOptions.ts** - Thread configuration options

### 4.4 Usage Example: Streaming Events

```typescript
import { Codex } from '@openai/codex-sdk';

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
      console.log(`Tokens: ${event.usage.input_tokens} in, ${event.usage.output_tokens} out`);
      break;

    case "turn.failed":
      console.error(`Error: ${event.error.message}`);
      break;
  }
}
```

### 4.5 Usage Example: Buffered Turn

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

### 4.6 TypeScript Type Definitions

The SDK provides complete type safety through discriminated unions:

```typescript
// ThreadEvent union type (from events.ts)
type ThreadEvent =
  | ThreadStartedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | ItemStartedEvent
  | ItemUpdatedEvent
  | ItemCompletedEvent
  | ThreadErrorEvent

// ThreadItem union type (from items.ts)
type ThreadItem =
  | AgentMessageItem
  | ReasoningItem
  | CommandExecutionItem
  | FileChangeItem
  | McpToolCallItem
  | WebSearchItem
  | TodoListItem
  | ErrorItem
  | UnknownThreadItem
```

### 4.7 Generating TypeScript Schema

Codex provides a command to generate TypeScript types from the internal schema:

```bash
codex app-server generate-ts
```

This outputs TypeScript type definitions matching the current version's JSONL protocol.

---

## 5. Session Persistence

### 5.1 Automatic JSONL Logs

Codex automatically saves per-session JSONL logs for all executions (both interactive and non-interactive).

**Location:** `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`

**Default Path:** `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`

**Example:** `~/.codex/sessions/2026/01/28/rollout-0199a213-81c0-7800-8aa1-bbab2a035a53.jsonl`

### 5.2 Rollout File Format

Each session file contains:
1. **Metadata header** (first line): Session information (ID, source, timestamp, model provider)
2. **Event stream** (subsequent lines): All events from the session in chronological order

### 5.3 Archived Sessions

Sessions can be moved to `$CODEX_HOME/archived_sessions/` when archived.

### 5.4 Use Cases for Session Logs

- **Debugging**: Replay exact event sequence for troubleshooting
- **Analytics**: Analyze token usage, command patterns, error rates
- **Session Resumption**: Extract thread_id for continuing conversations
- **Audit Trail**: Complete record of agent actions

---

## 6. Completion Detection & Notify Hook

### 6.1 Notify Hook Overview

Codex supports running external programs when specific events occur via the `notify` configuration.

**Configuration Location:** `config.toml`

**Current Event Support:** `agent-turn-complete` only

### 6.2 Configuration Example

```toml
# Play sound when turn completes
notify = ["bash", "-lc", "afplay /System/Library/Sounds/Blow.aiff"]

# Or run custom script
notify = ["/path/to/notify-script.py"]
```

### 6.3 Notify Script Example

The script receives event data as a JSON argument:

```python
#!/usr/bin/env python3
import json
import sys
import subprocess

def main() -> int:
    notification = json.loads(sys.argv[1])

    if notification.get("type") != "agent-turn-complete":
        return 0

    title = f"Codex: {notification.get('last-assistant-message', 'Turn Complete!')}"

    # Send desktop notification (macOS example)
    subprocess.run([
        "osascript", "-e",
        f'display notification "{title}" with title "Codex CLI"'
    ])

    return 0

if __name__ == "__main__":
    sys.exit(main())
```

### 6.4 Use Cases

- **Desktop notifications**: Alert when long-running tasks complete
- **Chat webhooks**: Send Slack/Discord messages on completion
- **CI updates**: Update build status or metrics
- **Sound alerts**: Audio feedback for background tasks

### 6.5 Limitations & Future Enhancements

**Current Limitations:**
- Only `agent-turn-complete` event supported
- No support for approval requests, file writes, or other events

**Requested Features** (active GitHub issues):
- `approval-requested` - Notify when agent needs user permission
- `file-write` - Alert when files are modified
- `job-completed` - Broader completion events beyond turns

---

## 7. Related CLI Flags & Features

### 7.1 Output Control Flags

#### `--json`
- **Purpose**: Enable JSONL event stream to stdout
- **Format**: Newline-delimited JSON
- **Usage**: `codex exec --json "prompt"`

#### `--output-last-message <path>` / `-o <path>`
- **Purpose**: Write final agent message to file
- **Format**: Plain text (not JSON)
- **Usage**: `codex exec --json --output-last-message summary.txt "prompt"`
- **Benefit**: Capture both machine-readable events (stdout) and human-readable summary (file)

#### `--output-schema <schema-file>`
- **Purpose**: Request structured JSON response conforming to JSON Schema
- **Format**: JSON Schema specification
- **Usage**: `codex exec --output-schema schema.json "extract data"`
- **Note**: Validates final response against provided schema

### 7.2 Session Management Flags

#### `--thread-id <id>`
- **Purpose**: Resume existing conversation thread
- **Source**: `thread_id` from `thread.started` event
- **Usage**: `codex exec --thread-id "0199a213..." "follow-up prompt"`

### 7.3 Documentation Flags

**Note:** No `--experimental-json` flag exists. The standard `--json` flag is the official JSON output mechanism.

---

## 8. Go SDK Type Reference

For reference, a community-maintained Go SDK also provides complete type definitions:

**Package:** `github.com/picatz/openai/codex`
**Documentation:** `https://pkg.go.dev/github.com/picatz/openai/codex`

The Go types mirror the TypeScript SDK and can serve as an additional reference for field names and structures.

---

## 9. Practical Implementation Recommendations

### 9.1 For FlightPath Integration

Based on the research, here are recommendations for the FlightPath Codex CLI provider:

#### Completion Detection Strategy

**Primary Method: JSONL Event Parsing**
```typescript
// Parse each line as separate JSON event
const lines = output.split('\n').filter(line => line.trim());
for (const line of lines) {
  const event = JSON.parse(line);

  if (event.type === 'turn.completed') {
    // Turn completed successfully
    return {
      success: true,
      usage: event.usage
    };
  }

  if (event.type === 'turn.failed') {
    // Turn failed
    return {
      success: false,
      error: event.error.message
    };
  }
}
```

**Fallback Method: Notify Hook**
- Configure notify hook in Codex config to write completion marker file
- Poll for marker file existence
- Less reliable than parsing JSONL stream

#### Token Usage Extraction

```typescript
interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

function extractTokenUsage(events: ThreadEvent[]): TokenUsage | null {
  const turnComplete = events.find(e => e.type === 'turn.completed');

  if (turnComplete && turnComplete.usage) {
    return {
      inputTokens: turnComplete.usage.input_tokens,
      cachedInputTokens: turnComplete.usage.cached_input_tokens,
      outputTokens: turnComplete.usage.output_tokens,
      totalTokens: turnComplete.usage.input_tokens + turnComplete.usage.output_tokens
    };
  }

  return null;
}
```

#### Agent Response Extraction

```typescript
function extractAgentResponse(events: ThreadEvent[]): string {
  // Find all completed agent_message items
  const messages = events
    .filter(e => e.type === 'item.completed' && e.item.type === 'agent_message')
    .map(e => (e.item as AgentMessageItem).text);

  // Return last message (typically the final response)
  return messages[messages.length - 1] || '';
}
```

#### Progressive Command Output

```typescript
function streamCommandOutput(events: AsyncIterable<ThreadEvent>) {
  const commandStates = new Map<string, string>();

  for await (const event of events) {
    if (event.type === 'item.updated' && event.item.type === 'command_execution') {
      const item = event.item as CommandExecutionItem;
      const previousOutput = commandStates.get(item.id) || '';
      const newOutput = item.aggregated_output.slice(previousOutput.length);

      if (newOutput) {
        console.log(newOutput); // Stream new output
        commandStates.set(item.id, item.aggregated_output);
      }
    }
  }
}
```

### 9.2 Error Handling

```typescript
interface ExecutionResult {
  success: boolean;
  response?: string;
  usage?: TokenUsage;
  error?: string;
  items?: ThreadItem[];
}

async function parseCodexOutput(jsonlOutput: string): Promise<ExecutionResult> {
  const events: ThreadEvent[] = [];
  const lines = jsonlOutput.split('\n').filter(line => line.trim());

  try {
    for (const line of lines) {
      events.push(JSON.parse(line));
    }
  } catch (error) {
    return {
      success: false,
      error: `Failed to parse JSONL: ${error.message}`
    };
  }

  // Check for turn failure
  const failure = events.find(e => e.type === 'turn.failed');
  if (failure) {
    return {
      success: false,
      error: failure.error.message
    };
  }

  // Check for turn completion
  const completion = events.find(e => e.type === 'turn.completed');
  if (!completion) {
    return {
      success: false,
      error: 'Turn did not complete'
    };
  }

  // Extract results
  const items = events
    .filter(e => e.type === 'item.completed')
    .map(e => e.item);

  return {
    success: true,
    response: extractAgentResponse(events),
    usage: extractTokenUsage(events),
    items
  };
}
```

### 9.3 Session Resumption

```typescript
function extractSessionId(jsonlOutput: string): string | null {
  const firstLine = jsonlOutput.split('\n')[0];
  if (!firstLine) return null;

  try {
    const event = JSON.parse(firstLine);
    if (event.type === 'thread.started') {
      return event.thread_id;
    }
  } catch {
    return null;
  }

  return null;
}

// Usage
const output = await runCodexCommand('--json', 'initial prompt');
const sessionId = extractSessionId(output);

if (sessionId) {
  // Resume in next prompt
  await runCodexCommand('--json', '--thread-id', sessionId, 'follow-up');
}
```

---

## 10. Important Notes & Caveats

### 10.1 Documentation Discrepancies

**Field Name Changes (v0.44.0+):**
- Older documentation shows `"item_type"` but current CLI outputs `"type"`
- Older documentation shows `"assistant_message"` but current CLI outputs `"agent_message"`
- **Impact:** Always use current SDK types rather than old documentation examples

### 10.2 Schema Evolution

- The `UnknownThreadItem` type provides forward compatibility
- New item types may be added in future versions
- Always handle unknown types gracefully

### 10.3 JSONL Parsing Considerations

- Each line is independent JSON (not a single JSON array)
- Empty lines should be filtered out
- Malformed lines should be handled gracefully
- Events arrive in chronological order but timing is not guaranteed

### 10.4 Output Redirect Behavior

- `--json` writes to stdout only
- Stderr may still contain progress indicators or errors
- Redirect stderr separately if needed: `codex exec --json "prompt" 2>stderr.log`

### 10.5 Performance Considerations

- Large command outputs can result in many `item.updated` events
- Consider buffering updates to avoid processing overhead
- Session log files can grow large for long-running sessions

---

## 11. Related Resources

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

## 12. Conclusion

The Codex CLI `--json` flag provides a comprehensive, well-structured JSONL output format with:

✅ **Strong Type Safety**: TypeScript/Go SDK types available
✅ **Real-time Streaming**: Progressive updates via item.updated events
✅ **Complete Metadata**: Token usage, command outputs, file changes
✅ **Session Persistence**: Automatic JSONL logs for all executions
✅ **Extensibility**: Forward-compatible with unknown item types
✅ **Programmatic Access**: Official SDK with async generators

The format is production-ready and suitable for automation, monitoring, and integration into tools like FlightPath. The TypeScript SDK provides excellent developer experience with type safety and streaming support.

**Recommended Integration Approach:**
1. Use `--json` flag for all non-interactive executions
2. Parse JSONL stream line-by-line for real-time processing
3. Detect completion via `turn.completed` or `turn.failed` events
4. Extract token usage from `turn.completed.usage`
5. Extract response from last `agent_message` item
6. Handle progressive updates for long-running commands
7. Store `thread_id` for session resumption

---

**Research Sources:**

- [Codex CLI Features](https://developers.openai.com/codex/cli/features/)
- [Non-interactive mode](https://developers.openai.com/codex/noninteractive/)
- [CLI flag to save trajectory/output as JSON #2288](https://github.com/openai/codex/issues/2288)
- [Command line options](https://developers.openai.com/codex/cli/reference/)
- [codex/docs/exec.md](https://github.com/openai/codex/blob/main/docs/exec.md)
- [codex/sdk/typescript/README.md](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)
- [Architecture Guide — Codex SDK](https://hexdocs.pm/codex_sdk/02-architecture.html)
- [Go SDK Package Documentation](https://pkg.go.dev/github.com/picatz/openai/codex)
- [Hook feature request #2150](https://github.com/openai/codex/discussions/2150)
- [Advanced Configuration](https://developers.openai.com/codex/config-advanced/)
