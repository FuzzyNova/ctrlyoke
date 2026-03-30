# Live Context Window Usage — Plan

**Goal:** Replace the static end-of-prompt `{contextPct}%` text in `PromptItemDetails` with a live-updating vertical fill bar rendered directly in `PromptItem`. The bar should update in real time as a prompt runs, giving users visibility into context consumption and an early signal to abort runaway prompts.

---

## Current State

### Where context data lives

All six CLI log parsers already compute `contextWindowUsedTokens` and `contextWindowSize` — but only inside `extractResponse()`, which runs once at completion.

| Harness | Context source event | Fires mid-stream? |
|---------|---------------------|-------------------|
| **Copilot** | `session.truncation` → `postTruncationTokensInMessages` | **YES** — every turn |
| **Claude** | `assistant` event → `message.usage.input_tokens + cache_*` | YES — per-turn assistant message |
| **Gemini** | `gemini` message event → `tokens.input` | YES — per response chunk |
| **Qwen** | assistant message → `promptTokenCount` | YES — per turn |
| **Codex** | `event_msg` with `payload.type === "token_count"` | YES — fires during execution |
| **OpenCode** | per-step events accumulated by `OpenCodeEventMapper` | YES — per step |

Every harness already emits usage-bearing events during streaming; it's just that `extractResponse` is the only place that reads them. This means **no polling is needed** — we can extract context window data from the same event stream already flowing through `CliLogMonitor.processEvent()`.

### Current UI

- `PromptItemDetails.tsx:54-57` — computes `contextPct` from `latestOutput.tokens` after completion
- `PromptItemDetails.tsx:128-130` — renders `{contextPct}%` as a plain text chip in the stats row
- `PromptItem.tsx` — no context bar; just delegates to `PromptItemDetails`

### Current streaming pipeline

```
ILogParser.watchLogFile() (fs.watch)
  → CliLogMonitor.processEvent(event)
      → parser.extractStructuredEventsFromEvent(event)  // text/tool streaming
      → deps.onStreamingEvents(events)
      → [parser.isComplete → handleCompletion]

handleCompletion()
  → parser.extractResponse(allEvents)        // <- context window extracted here only
  → deps.onResponseComplete()
  → resolve({ parsedOutput })
```

The gap: context window data exists in events flowing through `processEvent`, but nothing reads it there.

---

## Architecture Plan

### Layer 1 — `ILogParser` interface (new method)

Add one optional method to `ILogParser`:

```typescript
/**
 * Extract live context window utilization from a single log event.
 *
 * Called by CliLogMonitor on every event as they stream in, so harnesses
 * can surface context usage incrementally without waiting for completion.
 * Returns null for events that carry no context window information.
 *
 * @param event - Single parsed log event
 * @returns { used, size } token counts, or null if event has no context info
 */
extractLiveContextWindow?(event: BaseCliEvent): { used: number; size: number } | null;
```

Making it optional (`?`) means `BaseLogParser` can provide a default no-op, so no existing parser breaks without implementing it.

**Add default no-op to `BaseLogParser`:**

```typescript
extractLiveContextWindow(_event: BaseCliEvent): { used: number; size: number } | null {
  return null;
}
```

### Layer 2 — Per-harness implementations

Each log parser implements `extractLiveContextWindow` by recognizing the same events it already tracks in `extractResponse`:

#### Claude (`ClaudeLogParser`)
```typescript
extractLiveContextWindow(event: BaseCliEvent) {
  // assistant events contain message.usage after each turn
  if (event.type === "assistant") {
    const usage = (event as any).message?.usage;
    if (!usage) return null;
    const used = (usage.input_tokens ?? 0)
      + (usage.cache_creation_input_tokens ?? 0)
      + (usage.cache_read_input_tokens ?? 0);
    const size = this.getContextWindowSize(); // already available via model field
    return used > 0 && size ? { used, size } : null;
  }
  return null;
}
```

#### Copilot (`CopilotLogParser`)
```typescript
extractLiveContextWindow(event: BaseCliEvent) {
  if (event.type === "session.truncation") {
    const used = (event as any).data?.postTruncationTokensInMessages;
    const size = (event as any).data?.tokenLimit ?? COPILOT_CLI_CONTEXT_WINDOW_SIZE;
    return used != null ? { used, size } : null;
  }
  return null;
}
```

#### Codex (`CodexLogParser`)
```typescript
extractLiveContextWindow(event: BaseCliEvent) {
  if ((event as any).event_msg?.payload?.type === "token_count") {
    const info = (event as any).event_msg.payload.info;
    const last = info?.last_token_usage;
    if (!last) return null;
    const used = (last.input_tokens ?? 0) + (last.cached_input_tokens ?? 0);
    const size = this.getContextWindowSize();
    return used > 0 && size ? { used, size } : null;
  }
  return null;
}
```

#### Gemini (`GeminiLogParser`)
```typescript
extractLiveContextWindow(event: BaseCliEvent) {
  if (event.type === "gemini" && (event as any).tokens?.input != null) {
    const used = (event as any).tokens.input;
    const size = this.getContextWindowSize();
    return used > 0 && size ? { used, size } : null;
  }
  return null;
}
```

#### Qwen (`QwenLogParser`)
```typescript
extractLiveContextWindow(event: BaseCliEvent) {
  // assistant messages carry promptTokenCount
  const pct = (event as any).promptTokenCount;
  if (pct != null && pct > 0) {
    const size = this.getContextWindowSize();
    return size ? { used: pct, size } : null;
  }
  return null;
}
```

#### OpenCode (`OpenCodeLogParser`)
```typescript
extractLiveContextWindow(event: BaseCliEvent) {
  // After each step, OpenCodeEventMapper accumulates lastStepTotal
  // The parser already updates this.lastStepTotal in processEvent-equivalent logic.
  // Return the running total if we've seen a step completion.
  if (this.lastStepTotal > 0 && this.contextWindowSize) {
    return { used: this.lastStepTotal, size: this.contextWindowSize };
  }
  return null;
}
```

> **Note:** Each harness already knows its context window size from model constants — no new infrastructure needed.

### Layer 3 — `CliLogMonitor` wiring

Add `onContextWindowUpdate` to `LogMonitorDependencies`:

```typescript
export interface LogMonitorDependencies {
  // ... existing fields ...
  /** Called when a streaming event reveals updated context window utilization */
  onContextWindowUpdate?: (used: number, size: number) => void;
}
```

In `processEvent()`, after calling `extractStructuredEventsFromEvent`, add:

```typescript
// Extract live context window data if available
if (this.deps.onContextWindowUpdate && parser.extractLiveContextWindow) {
  const ctx = parser.extractLiveContextWindow(event);
  if (ctx) {
    this.deps.onContextWindowUpdate(ctx.used, ctx.size);
  }
}
```

This piggybacks on the existing event loop — zero additional file I/O.

### Layer 4 — `CliIntegration` → Webview bridge

`CliIntegration` already wires `onStreamingEvents` through to the webview provider. The same pattern applies:

In `CliIntegration` (wherever `LogMonitorDependencies` is assembled):

```typescript
onContextWindowUpdate: (used, size) => {
  this.onContextWindowUpdate?.(stepIndex, used, size);
},
```

`CliIntegration` exposes a callback that callers (WorkflowExecutor → FlightPathWebviewProvider) wire up.

### Layer 5 — New webview message type

In `WebviewMessageTypes.ts`, add:

```typescript
/**
 * Live context window update message (extension -> webview).
 * Fired per-event during prompt execution; used to animate the context bar.
 */
export interface ContextWindowUpdateMessage {
  type: typeof MESSAGE_TYPES.CONTEXT_WINDOW_UPDATE;
  stepIndex: number;
  used: number;
  size: number;
}
```

Add `CONTEXT_WINDOW_UPDATE` to `MESSAGE_TYPES` in `DashboardConstants.ts`.

Add the new message union to `ExtensionToWebviewMessage`.

### Layer 6 — Webview store (`workflowStore`)

Add live context state per step:

```typescript
// In store state
liveContextWindow: Record<number, { used: number; size: number }>;

// In store actions
updateLiveContextWindow: (stepIndex: number, used: number, size: number) => void;
clearLiveContextWindow: (stepIndex: number) => void;  // called on step start/clear
```

The message handler in the store (where `CLI_STREAMING_EVENTS` etc. are handled) adds:

```typescript
case MESSAGE_TYPES.CONTEXT_WINDOW_UPDATE:
  store.updateLiveContextWindow(msg.stepIndex, msg.used, msg.size);
  break;
```

Clear `liveContextWindow[stepIndex]` when `clearRuntimeStateFromStep` fires.

### Layer 7 — UI changes

#### `PromptItem.tsx` — Add vertical context bar

The context bar is a narrow column on the right edge of the prompt item. It:
- Is always the same height as the item's content area
- Fills from the bottom upward proportional to `pct`
- Shows the percentage number above the bar (or below — consider below to avoid overlap with drag handle area)
- Uses a subdued accent color (e.g., the existing VS Code token color variable) that intensifies as it fills
- Is hidden when `contextPct === undefined`

**Data flow:**
```typescript
// PromptItem receives:
liveContextWindow?: { used: number; size: number };  // from store for running step
// latestOutput.tokens already carries final context for completed step

// Derive pct:
const ctx = liveContextWindow ?? (latestOutput?.tokens
  ? { used: latestOutput.tokens.contextWindowUsed ?? 0,
      size: latestOutput.tokens.contextWindowSize ?? 0 }
  : undefined);
const contextPct = ctx?.size ? Math.round((ctx.used / ctx.size) * 100) : undefined;
```

**Render — right-side vertical bar:**

```tsx
{contextPct !== undefined && (
  <div className="flex-shrink-0 flex flex-col items-center w-3 self-stretch ml-1">
    {/* Percentage label */}
    <span className="text-[8px] leading-none text-description-fg opacity-75 mb-0.5">
      {contextPct}
    </span>
    {/* Track */}
    <div className="flex-1 w-1.5 rounded-full bg-panel-border overflow-hidden relative">
      {/* Fill */}
      <div
        className="absolute bottom-0 left-0 right-0 rounded-full bg-description-fg opacity-50 transition-all duration-300"
        style={{ height: `${contextPct}%` }}
      />
    </div>
  </div>
)}
```

Color cues:
- 0–70%: `opacity-50` (neutral)
- 70–85%: `opacity-70` + amber hue (warning)
- 85–100%: `opacity-90` + red hue (danger)

These thresholds map to CSS classes based on `contextPct`, no inline styles needed.

**Prop addition to `PromptItemProps`:**

```typescript
/** Live context window usage (updated during running step; falls back to latestOutput for completed) */
liveContextWindow?: { used: number; size: number };
```

#### `PromptItemDetails.tsx` — Remove context % chip

Remove the `{contextPct}%` span from the stats row (lines 128–130). The rest of the stats row (sessionId, duration) stays as-is. The condition guarding the row already has `|| sessionId || durationSeconds !== undefined`, so the row still renders correctly when context chip is absent.

---

## Data Flow Summary

```
Log event arrives
  → CliLogMonitor.processEvent(event)
      → parser.extractStructuredEventsFromEvent(event)  [existing — text streaming]
      → parser.extractLiveContextWindow(event)           [NEW]
          → deps.onContextWindowUpdate(used, size)       [NEW callback]
              → FlightPathWebviewProvider.postMessage({
                  type: CONTEXT_WINDOW_UPDATE,
                  stepIndex,
                  used,
                  size
                })
                  → workflowStore.updateLiveContextWindow(stepIndex, used, size)
                      → React re-render → PromptItem bar fills
```

---

## Headless Mode — Context Sidecar

In headless mode the CLI runs as a child process and stdout is consumed by `IResponseParser`. But every CLI harness still writes to its persistent log directory regardless of how it's invoked — the same log files that interactive mode monitors. We exploit this with a **context sidecar**: a lightweight parallel log watcher that runs alongside the headless child process, using the existing `ILogParser` infrastructure purely for context window data.

### How the sidecar works

`CliIntegration.executeHeadlessWithPromptFile` already records `this.actualPromptSent` and `startTime` before spawning the process. The sidecar is started concurrently with the spawn, then torn down when the process exits:

```typescript
// Pseudocode in executeHeadlessWithPromptFile, around the spawnProcess call:
const sidecar = this.startContextWindowSidecar(startTime, onContextWindowUpdate);
try {
  const result = await this.spawnProcess(...);
  return await executeCallback(result);
} finally {
  sidecar.stop();
}
```

### `startContextWindowSidecar` helper

Lives on `CliIntegration` (or extracted to a helper class). It:

1. **Discovers the log file** — polls `this.provider.logParser.discoverSessionLog(this.actualPromptSent, startTime)` in a loop with ~500 ms backoff, up to ~15 seconds. The same discovery logic interactive mode already uses.

2. **Seeks to end** — calls `logParser.seekToEnd(logPath)` so we skip historical events from previous sessions in the same log file. Already exists on `ILogParser`.

3. **Watches the file** — calls `logParser.watchLogFile(logPath, onEntry, startTime)`, exactly as `CliLogMonitor` does.

4. **Extracts context** — in the `onEntry` callback, calls `logParser.extractLiveContextWindow(entry)`. If non-null, fires `onContextWindowUpdate(used, size)`.

5. **Returns a `{ stop() }` handle** — `stop()` closes the `fs.FSWatcher` and cancels any pending discovery timer.

```typescript
private startContextWindowSidecar(
  startTime: Date,
  onContextWindowUpdate: (used: number, size: number) => void
): { stop: () => void } {
  const parser = this.provider.logParser;
  if (!parser.extractLiveContextWindow || !parser.discoverSessionLog) {
    return { stop: () => {} };  // parser doesn't support live context
  }

  let watcher: fs.FSWatcher | null = null;
  let stopped = false;
  let discoveryTimer: NodeJS.Timeout | undefined;

  const discover = async () => {
    let attempts = 0;
    while (!stopped && attempts < 30) {  // ~15s max
      const logPath = await parser.discoverSessionLog(
        this.actualPromptSent ?? "",
        startTime
      );
      if (logPath) {
        parser.seekToEnd?.(logPath);
        watcher = parser.watchLogFile(
          logPath,
          (entry) => {
            if (stopped) return;
            const ctx = parser.extractLiveContextWindow!(entry);
            if (ctx) onContextWindowUpdate(ctx.used, ctx.size);
          },
          startTime
        );
        return;
      }
      await new Promise((r) => { discoveryTimer = setTimeout(r, 500); });
      attempts++;
    }
  };

  void discover();

  return {
    stop: () => {
      stopped = true;
      if (discoveryTimer) clearTimeout(discoveryTimer);
      watcher?.close();
    },
  };
}
```

### Why this is the right approach

- **No new infrastructure** — reuses `discoverSessionLog`, `seekToEnd`, `watchLogFile`, and the new `extractLiveContextWindow` already built for interactive mode.
- **No polling** — `watchLogFile` uses `fs.watch` (event-driven). The discovery retry loop only runs until the file appears, typically within 1–2 seconds.
- **Zero interference** — the sidecar is purely additive. It doesn't touch stdout parsing or the `IResponseParser` path.
- **Automatic cleanup** — `finally` in `executeHeadlessWithPromptFile` ensures the watcher is always closed when the process exits.
- **Works for all harnesses** — all six CLIs write log files regardless of headless vs. interactive.

### Headless data flow

```
Headless process spawned
  ↓ (concurrently)
  ├── spawnProcess() captures stdout → IResponseParser.parse() at exit
  └── startContextWindowSidecar()
        → discoverSessionLog() [polls until log appears, ~1-2s]
        → seekToEnd(logPath)   [skip prior session history]
        → watchLogFile(logPath, onEntry)
             → extractLiveContextWindow(entry)
                 → onContextWindowUpdate(used, size)
                     → FlightPathWebviewProvider.postMessage(CONTEXT_WINDOW_UPDATE)
                         → workflowStore → PromptItem bar fills
Process exits → sidecar.stop() → watcher.close()
```

---

## Files to Modify

| File | Change |
|------|--------|
| `src/flightpath/harness/shared/interfaces/ILogParser.ts` | Add optional `extractLiveContextWindow?` method |
| `src/flightpath/harness/shared/BaseLogParser.ts` | Add default no-op implementation |
| `src/flightpath/harness/claude/ClaudeLogParser.ts` | Implement `extractLiveContextWindow` |
| `src/flightpath/harness/copilot/CopilotLogParser.ts` | Implement `extractLiveContextWindow` |
| `src/flightpath/harness/codex/CodexLogParser.ts` | Implement `extractLiveContextWindow` |
| `src/flightpath/harness/gemini/GeminiLogParser.ts` | Implement `extractLiveContextWindow` |
| `src/flightpath/harness/qwen/QwenLogParser.ts` | Implement `extractLiveContextWindow` |
| `src/flightpath/harness/opencode/OpenCodeLogParser.ts` | Implement `extractLiveContextWindow` |
| `src/flightpath/harness/CliLogMonitor.ts` | Add `onContextWindowUpdate` to deps; call in `processEvent` |
| `src/flightpath/harness/CliIntegration.ts` | Add `startContextWindowSidecar()`; wire into `executeHeadlessWithPromptFile` |
| `src/flightpath/harness/CliIntegration.ts` | Wire `onContextWindowUpdate` from `CliLogMonitor` to caller (interactive) |
| `src/types/DashboardConstants.ts` | Add `CONTEXT_WINDOW_UPDATE` to `MESSAGE_TYPES` |
| `src/types/WebviewMessageTypes.ts` | Add `ContextWindowUpdateMessage` type + union |
| `src/ui/FlightPathWebviewProvider.ts` | Add `updateLiveContextWindow()` method + call from CliIntegration |
| `src/ui/webview-react/store/workflowStore.ts` | Add `liveContextWindow` state + `updateLiveContextWindow` action |
| `src/ui/webview-react/store/workflowStore.ts` | Handle `CONTEXT_WINDOW_UPDATE` message |
| `src/ui/webview-react/components/prompts/PromptItem.tsx` | Add vertical bar + `liveContextWindow` prop |
| `src/ui/webview-react/components/prompts/PromptItemDetails.tsx` | Remove `{contextPct}%` chip from stats row |
| Caller of `PromptItem` (PromptsList or similar) | Pass `liveContextWindow` from store |

---

## Open Questions

1. **Bar position:** Right side of item or left side (alongside the status icon column)? Right is less disruptive to the existing layout. Left could feel more natural as a "progress stripe". The current plan puts it on the right.

2. **Label position:** Above the bar keeps it visible when the bar is short; below the bar is less likely to crowd the percentage number against the drag handle. Current plan: above.

3. **Show bar for pending steps?** Could show an empty track for all steps as a visual affordance, or only show it once context data exists. Current plan: only render when `contextPct !== undefined`.

4. **Final prompt items (`FinalPromptFooter`):** `PromptItemDetails` is shared with `FinalPromptFooter` — the chip removal there is automatic. But `FinalPromptFooter` likely uses its own layout. Verify it doesn't need a bar added separately.

5. **Color semantics:** Using opacity of `description-fg` keeps the bar theme-consistent without adding new CSS variables. Alternatively, map to existing semantic tokens: warning, error. Worth a quick look at what the VS Code theme exposes.
