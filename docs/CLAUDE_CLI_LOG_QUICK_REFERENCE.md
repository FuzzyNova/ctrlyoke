# Claude CLI Log File - Quick Reference

**Location:** `C:\Users\<username>\.claude\projects\<project-path>\<session-id>.jsonl`

**Format:** JSONL (one JSON object per line)

---

## Essential Event Types

| Type                    | When              | Key Fields                                                  |
| ----------------------- | ----------------- | ----------------------------------------------------------- |
| `user`                  | User sends prompt | `message.content`, `uuid`, `timestamp`                      |
| `assistant`             | Claude responds   | `message.content[]`, `message.stop_reason`, `message.usage` |
| `file-history-snapshot` | File modified     | `snapshot.trackedFileBackups`                               |
| `progress`              | Hook executes     | `data.hookEvent`, `data.command`                            |
| `system`                | Hook completes    | `subtype`, `hookCount`, `hookErrors`                        |
| `summary`               | Turn ends         | `summary`, `leafUuid`                                       |
| `queue-operation`       | Queue operation   | `operation`, `sessionId`                                    |

---

## Content Block Types (in assistant messages)

| Type          | Purpose            | Key Field                      |
| ------------- | ------------------ | ------------------------------ |
| `thinking`    | Claude's reasoning | `thinking` (text), `signature` |
| `text`        | Regular response   | `text` (markdown)              |
| `tool_use`    | Tool invocation    | `id`, `name`, `input`          |
| `tool_result` | Tool output        | `tool_use_id`, `content`       |

---

## Common Tools

| Tool    | Purpose            | Input Fields                             |
| ------- | ------------------ | ---------------------------------------- |
| `Read`  | Read file          | `file_path`, `offset`, `limit`           |
| `Write` | Create/write file  | `file_path`, `content`                   |
| `Edit`  | Edit file in-place | `file_path`, `old_string`, `new_string`  |
| `Bash`  | Execute command    | `command`, `description`, `timeout`      |
| `Grep`  | Search content     | `pattern`, `path`, `glob`, `output_mode` |
| `Glob`  | Find files         | `pattern`, `path`                        |

---

## Stop Reasons

| Value             | Meaning                  |
| ----------------- | ------------------------ |
| `null`            | Still streaming          |
| `"end_turn"`      | Normal completion        |
| `"tool_use"`      | Stopped to execute tools |
| `"max_tokens"`    | Hit token limit          |
| `"stop_sequence"` | Hit stop sequence        |

---

## Session Fields

Every event includes:

- `sessionId` - UUID for this session
- `version` - Claude CLI version (e.g., "2.1.15")
- `cwd` - Current working directory
- `gitBranch` - Git branch (if in repo)
- `timestamp` - ISO 8601 timestamp
- `uuid` - Unique event ID

---

## Message Linking

Events are linked via UUIDs:

- `parentUuid` - Points to previous message
- `uuid` - This event's unique ID
- `message.id` - Anthropic API message ID (same across streaming chunks)

**Example chain:**

```
user message (uuid: A, parentUuid: null)
  → assistant thinking (uuid: B, parentUuid: A, message.id: msg_01X)
  → assistant response (uuid: C, parentUuid: A, message.id: msg_01X)
  → tool result (uuid: D, parentUuid: C)
```

---

## Token Usage

In `message.usage`:

```json
{
  "input_tokens": 10, // New tokens
  "cache_creation_input_tokens": 15009, // Cache created
  "cache_read_input_tokens": 12834, // Cache read
  "output_tokens": 857, // Response tokens
  "service_tier": "standard"
}
```

**Total input:** `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`

---

## Completion Detection

**Method 1: Check stop_reason**

```typescript
if (event.type === "assistant" && event.message?.stop_reason === "end_turn") {
  // Response complete
}
```

**Method 2: Watch for summary**

```typescript
if (event.type === "summary") {
  // Conversation turn complete
}
```

---

## Session Resumption

**Extract session ID:**

```typescript
const firstEvent = parseFirstLine(logFile);
const sessionId = firstEvent.sessionId;
```

**Resume command:**

```bash
claude --session <sessionId>
```

---

## Common Patterns

### Get all assistant text

```typescript
const textBlocks = event.message.content
  .filter((c) => c.type === "text")
  .map((c) => c.text);
```

### Get tool calls

```typescript
const toolCalls = event.message.content
  .filter((c) => c.type === "tool_use")
  .map((c) => ({ id: c.id, name: c.name, input: c.input }));
```

### Calculate total output tokens

```typescript
const total = events
  .filter((e) => e.type === "assistant")
  .reduce((sum, e) => sum + (e.message?.usage?.output_tokens || 0), 0);
```

---

## File Backups

When files are modified, backups are tracked:

```json
{
  "trackedFileBackups": {
    "src\\file.ts": {
      "backupFileName": "c912590346f725e1@v1",
      "version": 1,
      "backupTime": "2026-01-17T17:38:06.177Z"
    }
  }
}
```

**Backup location:** `.claude/projects/<project>/backups/<backupFileName>`

---

## Sidechain/Agent Conversations

Agent events have:

- `isSidechain: true`
- `agentId` field (e.g., "a4f1822")
- Separate log file: `agent-<agentId>.jsonl`
- Different `sessionId` from parent

---

## Hooks

**Progress event (hook starting):**

```json
{
  "type": "progress",
  "data": {
    "type": "hook_progress",
    "hookEvent": "SessionStart",
    "hookName": "SessionStart:startup",
    "command": "node script.js"
  }
}
```

**System event (hook completed):**

```json
{
  "type": "system",
  "subtype": "stop_hook_summary",
  "hookCount": 1,
  "hookErrors": [],
  "hookInfos": [{ "command": "node script.js" }]
}
```

---

## Quick Tips

1. **Always parse line-by-line** - It's JSONL, not a JSON array
2. **Watch for streaming** - Same `message.id` appears multiple times
3. **Check stop_reason** - Only `null` means still streaming
4. **Filter by type** - Most parsing starts with `event.type === 'assistant'`
5. **Follow the chain** - Use `parentUuid` to rebuild conversation
6. **Cache saves money** - `cache_read_input_tokens` are heavily discounted
7. **Tools are async** - `tool_use` → `tool_result` → next `assistant` message
8. **Slugs are random** - e.g., "synthetic-sniffing-wind" (ignore these)

---

## FlightPath Use Cases

| Need              | Strategy                                           |
| ----------------- | -------------------------------------------------- |
| Detect completion | Watch `stop_reason === 'end_turn'`                 |
| Resume session    | Extract `sessionId` from first event               |
| Show token stats  | Parse `usage` from final assistant message         |
| Monitor tools     | Filter `content` for `tool_use` and `tool_result`  |
| Track errors      | Check `hookErrors` in system events                |
| Display response  | Extract `text` blocks from final assistant message |

---

## Example Parsing Flow

```typescript
// 1. Read log file
const lines = fs.readFileSync(logPath, "utf-8").split("\n");

// 2. Parse each line
const events = lines
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

// 3. Get session ID (from any event)
const sessionId = events[0]?.sessionId;

// 4. Find last assistant message
const assistantMessages = events.filter((e) => e.type === "assistant");
const lastMessage = assistantMessages[assistantMessages.length - 1];

// 5. Check if complete
const isComplete = lastMessage?.message?.stop_reason === "end_turn";

// 6. Extract response text
const responseText = lastMessage?.message?.content
  .filter((c) => c.type === "text")
  .map((c) => c.text)
  .join("\n");

// 7. Get token usage
const tokens = lastMessage?.message?.usage;
console.log(`Output tokens: ${tokens?.output_tokens}`);
console.log(`Cache read: ${tokens?.cache_read_input_tokens}`);
```

---

## Gotchas

1. **Backslashes in paths** - Windows paths use `\\` in JSON
2. **Duplicate events** - Same `message.id` may appear 2-3 times (streaming)
3. **Null stop_reason** - Doesn't mean error, means still streaming
4. **Tool results as user** - `tool_result` events have `type: "user"`
5. **Empty lines** - Log files often end with blank line
6. **Large signatures** - Thinking signatures can be 2000-5000+ chars
7. **Cache variations** - Different cache types (5m, 1h ephemeral)

---

For complete documentation, see: `CLAUDE_CLI_LOG_STRUCTURE.md`
