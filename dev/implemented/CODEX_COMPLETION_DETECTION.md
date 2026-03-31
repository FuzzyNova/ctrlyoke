# Codex CLI Completion Detection

**Status**: ✅ Implemented (December 2025)  
**Integration**: CodexCliProvider.ts  
**Related Files**: src/scripts/flightpath-codex-notify.js

## Overview

FlightPath uses Codex CLI's **notify hook** for reliable completion detection in interactive TUI mode. This approach is future-proof and won't break when Codex changes its log format.

## Problem

Previous implementation monitored `~/.codex/log/codex-tui.log` for specific patterns like:

- `INFO run_task: close time.busy=...` (completion)
- `Turn error:` (error)

When Codex updated its logging format, these patterns disappeared, breaking completion detection.

## Solution: Notify Hook

Codex provides a built-in notification system specifically designed for automation:

```toml
# ~/.codex/config.toml or via --config flag
notify = ["node", "/path/to/notification-script.js"]
```

When `agent-turn-complete` events occur, Codex executes the notification script with a JSON argument.

### Notification Format

```json
{
  "type": "agent-turn-complete",
  "thread-id": "b5f6c1c2-1111-2222-3333-444455556666",
  "turn-id": "12345",
  "cwd": "/path/to/project",
  "input-messages": ["User prompt text"],
  "last-assistant-message": "Assistant's final response"
}
```

## Architecture

### 1. Notification Handler Script

**Location**: `src/scripts/flightpath-codex-notify.js`

- Receives notification JSON from Codex as command-line argument
- Filters for `agent-turn-complete` events
- Extracts workspace directory from `cwd` field in notification
- Writes notification to `{workspace}/.flightpath/temp/codex-notifications/{thread-id}.json`
- FlightPath reads and deletes the file

**Why workspace-specific?** Prevents conflicts when multiple VS Code instances run FlightPath simultaneously.

### 2. Integration Configuration

**Method**: `CodexCliProvider.buildCliArgs()`

For interactive mode, adds:

```bash
--config notify='["node","/path/to/flightpath-codex-notify.js"]'
```

### 3. Completion Monitoring

**Method**: `CodexNotificationMonitor` (via `CodexCliProvider.notificationMonitor`)

Two monitoring modes:

#### With Thread ID (Preferred)

- Monitors specific file: `{thread-id}.json`
- Most efficient

#### Without Thread ID (Fallback)

- Monitors entire notification directory for any new `.json` files
- Tracks initial file list, detects new files
- Works since FlightPath is the only process creating these files

### 4. Execution Flow

```typescript
// 1. Start TUI with notify hook configured
codex --config notify='[...]' --model o3 ...

// 2. Monitor notification file in parallel with TUI stream
const notifyPromise = monitorNotificationFile(threadId, ...);
const tuiPromise = tuiProcessor.processStream(...);

// 3. Race: Notification wins (authoritative)
const result = await Promise.race([notifyPromise, tuiPromise]);

// 4. When notification detected, abort TUI processing
if (result.completed) {
  tuiAbortController.abort();
}
```

## Mode Comparison

| Mode                    | Completion Detection                       | Thread ID Required?                            |
| ----------------------- | ------------------------------------------ | ---------------------------------------------- |
| **Headless** (`--json`) | JSONL events (`{"type":"turn.completed"}`) | ✅ Automatic                                   |
| **Interactive** (TUI)   | Notify hook → notification file            | ⚠️ Optional (fallback to directory monitoring) |

## Benefits

1. **Future-Proof**: Uses official Codex automation API, not internal log formats
2. **Reliable**: Structured JSON notifications, not regex pattern matching
3. **Simple**: No log parsing, just file monitoring
4. **Clean**: Notification files auto-cleanup after reading
5. **Robust**: Fallback to directory monitoring if thread ID unavailable
6. **Isolated**: Workspace-specific directory prevents cross-instance conflicts

## Configuration

FlightPath automatically configures the notify hook for interactive mode. No user configuration required.

### Settings (No Changes Needed)

Existing settings work unchanged:

- `flightpath.cliExecutionMode`: "interactive" or "headless"
- `flightpath.provider`: "codex-cli"

## Debugging

### Enable Verbose Output

Set in VS Code settings:

```json
{
  "flightpath.showCliOutput": true
}
```

### Check Notification Files

```bash
# Windows
dir .flightpath\temp\codex-notifications

# macOS/Linux
ls -la .flightpath/temp/codex-notifications/
```

Files should appear briefly during execution and be cleaned up after.

**Note**: Each workspace has its own notification directory, preventing conflicts between multiple VS Code instances.

### View Notification Script Logs

The notification script writes to stderr for debugging (doesn't interfere with stdout):

```bash
# Look for errors in Codex output
# Notification script errors will appear in terminal output
```

## Testing

### Manual Test

1. Set `flightpath.provider` to `codex-cli`
2. Set `flightpath.cliExecutionMode` to `interactive`
3. Run a simple prompt file
4. Watch for log message: `✅ Codex completion detected via notify hook (turn: ...)`

### Verification

Check the notification directory during execution:

```bash
# Should see {thread-id}.json appear and disappear
watch "ls ~/.flightpath/codex-notifications/"
```

## Troubleshooting

### Notification File Not Appearing

1. **Check script path**: Verify `out/scripts/flightpath-codex-notify.js` exists after build
2. **Check Node.js**: Ensure Node.js is in PATH (Codex needs to execute `node`)
3. **Check permissions**: Ensure script is readable

### Timeout Without Completion

1. **Check Codex version**: Requires Codex CLI with notify hook support
2. **Check notification directory**: Verify `~/.flightpath/codex-notifications/` is writable
3. **Enable debug logging**: Set `RUST_LOG=debug` to see Codex notify hook execution

### Thread ID Extraction Fails

- **Not a problem**: Fallback directory monitoring works without thread ID
- Monitor logs for: `📋 Monitoring notification directory for any new completion file`

## Future Enhancements

1. **Extract Thread ID from TUI stream**: Parse JSONL events from TUI output for more efficient monitoring
2. **Windows toast notifications**: Use Codex's `tui.notifications` for desktop alerts
3. **OTEL integration**: Export completion events to observability platform for analytics
4. **Multi-turn session tracking**: Correlate multiple turns within same thread

## Related Documentation

- [Codex Config Documentation](https://github.com/openai/codex/blob/main/docs/config.md#observability-and-telemetry)
- [Codex Advanced Features](https://github.com/openai/codex/blob/main/docs/advanced.md#tracing--verbose-logging)
- [FlightPath CLI Design](./COPILOT_CLI_DESIGN.md)
- [Interactive Terminal Design](./INTERACTIVE_TERMINAL_DESIGN.md)

## Implementation Notes

### Why Not OTEL Exporter?

OTEL exporters (otlp-http, otlp-grpc) require running a separate collector. The notify hook is simpler:

- No external dependencies
- No network configuration
- Just a script + file monitoring

### Why Not Log Parsing?

- **Brittle**: Log formats change frequently
- **Unreliable**: No guarantees about log patterns
- **Complex**: Requires regex maintenance

### Why File-Based IPC?

- **Cross-platform**: Works on Windows, macOS, Linux
- **Simple**: No socket/pipe complexity
- **Debuggable**: Can inspect notification files manually
- **Reliable**: Filesystem operations are atomic

### Why Workspace-Specific Directory?

**Location**: `{workspace}/.flightpath/temp/codex-notifications/` (not `~/.flightpath/codex-notifications/`)

**Reasons**:

1. **Multi-instance isolation**: Multiple VS Code windows can run FlightPath simultaneously without conflicts
2. **Consistent patterns**: Matches existing temp file usage (`.flightpath/temp/` for prompt files)
3. **Automatic cleanup**: Workspace-specific files are easier to manage and clean up
4. **No cross-workspace interference**: Each workspace has independent notification tracking

Codex provides the workspace path in `notification.cwd`, which the handler script uses to determine the correct directory.

## Code References

| File                                                  | Purpose                                      |
| ----------------------------------------------------- | -------------------------------------------- |
| `src/scripts/flightpath-codex-notify.js`                      | Notification handler script                  |
| `src/flightpath/harness/codex/CodexCliProvider.ts`            | Main integration logic                       |
| `src/flightpath/harness/codex/CodexNotificationMonitor.ts`    | Codex notification monitor                   |
| `src/flightpath/harness/shared/CliNotificationMonitor.ts`     | Shared monitoring utilities                  |
| `esbuild.js`                                                  | Copies notification script to `out/scripts/` |

## Change Log

- **2025-12-19**: Implemented notify hook completion detection
- **2025-12-19**: Added directory monitoring fallback for missing thread IDs
- **2025-12-19**: Deprecated log file monitoring (kept for reference)
