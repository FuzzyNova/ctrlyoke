# Chat Completion Detection Problem

## Overview

FlightPath needs to detect when Copilot Chat has finished responding to a prompt in order to:

1. Proceed to the next prompt in a workflow
2. Run end condition validation scripts
3. Update the dashboard with completion status

This document details the challenges with current detection methods and proposes VS Code API improvements.

## The Problem

### Current State

When automating Copilot Chat via UI automation (`workbench.action.chat.open`), there is **no public API** to detect when a response is complete. Extensions must resort to fragile heuristics.

### Why `vscode.lm` API Doesn't Help

The Language Model API (`vscode.lm.selectChatModels()`) provides direct LLM access but **bypasses the agent harness entirely**:

- ❌ No tool calling (MCP servers, web search, sequential thinking)
- ❌ No file editing capabilities
- ❌ No workspace context awareness
- ❌ No agent modes (Edit, Ask, Plan)

The full Copilot Chat experience requires the Chat window, which has no completion API.

### Related Issues

- [Stack Overflow: How to detect Copilot Chat request status](https://stackoverflow.com/questions/79677226/how-to-detect-copilot-chat-request-status-pending-vs-completed-in-a-vscode-ex) - Same problem, no answer

## Current Detection Methods (All Flawed)

### Method 1: Log File Monitoring

**Approach**: Monitor `GitHub Copilot Chat.log` for completion markers.

**Location**: `%APPDATA%/Code/logs/{session}/{window}/exthost/GitHub.copilot-chat/GitHub Copilot Chat.log`

**Markers discovered**:

| Marker                                   | When It Appears        | Reliability                  |
| ---------------------------------------- | ---------------------- | ---------------------------- |
| `finish reason: [stop]`                  | New chat sessions only | ✅ Reliable for new sessions |
| `\| success \| ... \| [panel/editAgent]` | All responses          | ⚠️ Multiple per response     |
| `\| cancelled \|`                        | User cancellation      | ✅ Reliable                  |
| `request done: requestId:`               | New sessions only      | ⚠️ Same as finish reason     |

**Problems**:

1. **Continued sessions have no reliable marker**: When using `newChatSession: false`, the `finish reason: [stop]` marker never appears. Only `| success |` patterns show up.

2. **Multiple success markers per response**: A single user prompt can generate many `| success |` log entries:

   ```
   ccreq:1a80ead1 | success | gpt-5-mini | 6369ms | [panel/editAgent]
   ccreq:163fa82e | success | gpt-5-mini | 13878ms | [panel/editAgent]
   ```

   These have different `ccreq` IDs but are from the same user request (e.g., planning phase + execution phase).

3. **Unpredictable timing**: Individual tool calls can take 60+ seconds, making any fixed debounce unreliable.

4. **Log format is internal**: Can change without notice in any VS Code update.

### Method 2: Clipboard Polling (Deprecated)

**Approach**: After sending prompt, monitor clipboard for response content.

**Problems**:

- Invasive (overwrites user's clipboard)
- Unreliable timing
- No clear completion signal
- Removed from FlightPath

### Method 3: Language Model Tool API

**Approach**: Register a "completion signal" tool that Copilot calls when done.

**Problems**:

- Requires injecting instructions into every prompt
- Copilot may not call the tool reliably
- Pollutes chat context with meta-instructions
- Not deterministic

### Method 4: Inactivity Timeout

**Approach**: If no log activity for N seconds, assume completion.

**Current implementation**: `chatInactivityTimeout` setting (default: 300 seconds)

**Problems**:

- 5 minutes is too long for responsive UX
- Too short risks cutting off long responses
- Not a real detection, just a guess

## Proposed VS Code API Solutions

### Option 1: Chat Request Completion Event (Recommended)

Add an event that fires when any chat request completes:

```typescript
// In vscode.d.ts
export namespace chat {
  /**
   * Event fired when a chat request completes (response fully generated)
   */
  export const onDidCompleteChatRequest: Event<ChatRequestCompletionEvent>;
}

export interface ChatRequestCompletionEvent {
  /** Unique identifier for the chat session */
  readonly sessionId: string;

  /** Unique identifier for this specific request */
  readonly requestId: string;

  /** Whether the response completed successfully */
  readonly success: boolean;

  /** Reason for completion: 'stop', 'cancelled', 'error', 'length' */
  readonly finishReason: "stop" | "cancelled" | "error" | "length";

  /** Error details if finishReason is 'error' */
  readonly error?: Error;
}
```

**Usage**:

```typescript
const disposable = vscode.chat.onDidCompleteChatRequest((event) => {
  if (event.finishReason === "stop") {
    console.log(`Request ${event.requestId} completed successfully`);
    // Proceed with next prompt or validation
  }
});
```

**Pros**:

- Clean, event-driven API consistent with VS Code patterns
- No need to track request IDs upfront
- Works for any source of chat requests

**Cons**:

- Need to correlate events with our requests if multiple sources

### Option 2: Request ID Return + Awaitable Completion

Make chat commands return a request ID that can be awaited:

```typescript
// Sending a prompt returns a request ID
const requestId = await vscode.commands.executeCommand<string>(
  "workbench.action.chat.send",
  { message: "Hello" }
);

// New API to wait for completion
const result = await vscode.chat.waitForRequestCompletion(requestId, {
  timeout: 60000, // optional timeout
});

if (result.success) {
  console.log("Response complete");
}
```

**Pros**:

- Direct correlation between send and completion
- Promise-based, easy to use in async workflows
- Timeout built-in

**Cons**:

- Requires changes to existing commands
- More complex API surface

### Option 3: Chat Session State Observable

Expose chat session state that can be observed:

```typescript
export namespace chat {
  /**
   * Get the currently active chat session (if any)
   */
  export function getActiveSession(): ChatSession | undefined;
}

export interface ChatSession {
  readonly id: string;
  readonly state: "idle" | "processing" | "streaming";
  readonly onDidChangeState: Event<ChatSessionState>;
}
```

**Usage**:

```typescript
const session = vscode.chat.getActiveSession();
if (session) {
  session.onDidChangeState((state) => {
    if (state === "idle") {
      console.log("Chat is idle, response complete");
    }
  });
}
```

**Pros**:

- Rich state information
- Can detect when chat becomes busy or idle

**Cons**:

- Session-level, not request-level granularity
- May miss rapid request completion if multiple queued

### Option 4: Chat Participant Response Hook

For extensions that create chat participants, add a response lifecycle hook:

```typescript
const participant = vscode.chat.createChatParticipant("my-ext.agent", handler);

// New: Hook into any response in this participant's context
participant.onDidCompleteResponse((event) => {
  console.log("Response complete:", event.requestId);
});
```

**Pros**:

- Scoped to participant context
- Clean integration with existing API

**Cons**:

- Only works for custom participants
- Doesn't help with automating default Copilot

## Recommendation

**Primary**: Option 1 (Chat Request Completion Event) is the most VS Code-idiomatic and broadly useful.

**Secondary**: Option 2 (Request ID + Awaitable) would be ideal for automation use cases but requires more API changes.

## Workaround Until API Exists

For FlightPath, document these limitations:

1. **Recommend CLI mode** for reliable automation (Copilot CLI, Claude CLI)
2. **Chat mode with `newChatSession: true`** works reliably (finish reason marker)
3. **Chat mode with `newChatSession: false`** is best-effort only:
   - Uses inactivity timeout (default 5 minutes)
   - `treatChatTimeoutAsSuccess: true` treats timeout as completion
   - May miss completion or wait too long

## Implementation Notes

The internal log format suggests VS Code/Copilot Chat already tracks:

- Request IDs (`ccreq:XXXXXXXX`)
- Completion reasons (`finish reason: [stop]`)
- Request status (`| success |`, `| cancelled |`)

Exposing this through a public API should be feasible.

## Related VS Code Source

- Chat service implementation: `src/vs/workbench/contrib/chat/common/chatServiceImpl.ts`
- `_pendingRequests` map tracks in-flight requests (private, needs exposure)
- Copilot Chat extension: `GitHub.copilot-chat` (closed source)

## Next Steps

1. Open GitHub issue on microsoft/vscode proposing the API
2. Reference this document and Stack Overflow question
3. Gauge interest from VS Code team
4. If positive, submit PR implementing Option 1
