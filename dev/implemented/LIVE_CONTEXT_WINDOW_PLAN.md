# Live Context Window Usage — Plan

**Goal:** Replace the static end-of-prompt `{contextPct}%` text in `PromptItemDetails` with a live-updating vertical fill bar rendered directly in `PromptItem`. The bar should update in real time as a prompt runs, giving users visibility into context consumption and an early signal to abort runaway prompts.

---

## Current State

### Where context data lives

All six CLI log parsers already compute `contextWindowUsedTokens` and `contextWindowSize` — but only inside `extractResponse()`, which runs once at completion.

| Harness      | Context source event                                       | Fires mid-stream?                |
| ------------ | ---------------------------------------------------------- | -------------------------------- |
| **Copilot**  | `session.truncation` → `postTruncationTokensInMessages`    | **YES** — every turn             |
| **Claude**   | `assistant` event → `message.usage.input_tokens + cache_*` | YES — per-turn assistant message |
| **Gemini**   | `gemini` message event → `tokens.input`                    | YES — per response chunk         |
| **Qwen**     | assistant message → `promptTokenCount`                     | YES — per turn                   |
| **Codex**    | `event_msg` with `payload.type === "token_count"`          | YES — fires during execution     |
| **OpenCode** | per-step events accumulated by `OpenCodeEventMapper`       | YES — per step                   |

Every harness already emits usage-bearing events during streaming; it's just that `extractResponse` is the only place that reads them. This means **no polling is needed** — we can extract context window data from the same event stream already flowing through `CliLogMonitor.processEvent()`.

### Current UI

- `PromptStepDetails.tsx:55-58` — computes `contextPct` from `latestOutput.tokens` after completion via `calcContextPct()`
- `PromptStepDetails.tsx:128-132` — renders `{contextPct}%` as a plain text chip in the stats row (only for `COMPLETED` steps)
- `WorkflowStep.tsx` (`WorkflowStepItem`) — no context bar; delegates to `PromptStepDetails`
- `hooks/useContextPct.ts` — existing hook returning `getContextPct(index)` from completed step data; already used by `PromptChipRail`
- `PromptChipRail.tsx` — already shows `contextPct` as text per chip (Row 2); no bar yet

> **File name note:** The plan was originally drafted with `PromptItem.tsx` / `PromptItemDetails.tsx`. The actual files are `WorkflowStep.tsx` (component `WorkflowStepItem`) and `PromptStepDetails.tsx`.

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

### Layer 4 — Threading `onContextWindowUpdate` to the webview

`LogMonitorDependencies` is assembled inside **`CliExecutionRunner`**, not `CliIntegration` directly. The callback must flow through the existing `hostCallbacks` chain:

**`CliExecutionRunner` `hostCallbacks`** (add one field):

```typescript
hostCallbacks: {
  onStreamingEvents: (events) => ...;   // existing
  onResponseComplete: (response) => ...; // existing
  logResponse: (...) => ...;             // existing
  onContextWindowUpdate?: (used: number, size: number) => void;  // NEW
}
```

**`CliExecutionRunner`** passes it into `LogMonitorDependencies` when constructing `CliLogMonitor`.

**`CliIntegration`** wires the callback when constructing `CliExecutionRunner` (lines ~646–650):

```typescript
hostCallbacks: {
  onStreamingEvents: (events) => this.emitStreamingEvents(events),
  onResponseComplete: (response) => this.emitResponseComplete(response),
  logResponse: (response, statistics) => this.logResponse(response, statistics),
  onContextWindowUpdate: (used, size) =>
    this.onContextWindowUpdate?.(stepIndex, used, size),  // NEW
},
```

`CliIntegration` exposes `onContextWindowUpdate` as a callback field (same pattern as `onStreamingEvents`), wired by `WorkflowExecutor → FlightPathWebviewProvider`.

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

Clear `liveContextWindow[stepIndex]` in two places:

- When `clearRuntimeStateFromStep` fires (set-start-position / workflow reset)
- When `PROGRESS_UPDATE` fires for that stepIndex with a terminal status (`COMPLETED`, `FAILED`, `CANCELLED`) — so the bar transitions cleanly to showing data from `latestOutput.tokens` once the step is done

Without the second clear, the live value (last mid-run reading) would shadow `latestOutput.tokens` permanently for completed steps.

### Layer 6b — Update `useContextPct` hook

`hooks/useContextPct.ts` already provides `getContextPct(index)` from completed step data and is used by `PromptChipRail`. Update it to also check `liveContextWindow` from `workflowStore` as a higher-priority source so `PromptChipRail` automatically gets live updates for the running step without additional prop threading:

```typescript
export function useContextPct() {
  const { liveOrderedEntries, historyOutputs, liveContextWindow } =
    useWorkflowStore();
  const { isViewingHistory } = useUiStore();

  return function getContextPct(index: number): number | undefined {
    // Live data takes priority (running step)
    const live = liveContextWindow?.[index];
    if (live?.size) {
      return calcContextPct(live.used, live.size);
    }
    // Fall back to completed step data
    const entries =
      isViewingHistory && historyOutputs
        ? historyOutputs.orderedEntries
        : liveOrderedEntries;
    // ... existing logic unchanged ...
  };
}
```

This means `PromptChipRail` requires zero additional changes to receive live context data.

### Layer 7 — UI changes

#### `WorkflowStep.tsx` (`WorkflowStepItem`) — Add vertical context bar

> **File note:** The plan refers to `PromptItem.tsx` — the actual file is `WorkflowStep.tsx`, component `WorkflowStepItem`.

The context bar is a narrow column on the right edge of the step item. It:

- Is always the same height as the item's content area (`self-stretch`)
- Fills from the bottom upward proportional to `pct`
- Shows the percentage number above the fill
- Uses existing VS Code semantic color tokens — intensifies as it fills
- Is hidden when `contextPct === undefined`

**Data flow:**

```typescript
// WorkflowStepItem receives:
liveContextWindow?: { used: number; size: number };  // from store for running step

// Derive pct (inside WorkflowStepItem):
const ctx = liveContextWindow ?? (latestOutput?.tokens?.contextWindowSize
  ? { used: latestOutput.tokens.contextWindowUsed ?? 0,
      size: latestOutput.tokens.contextWindowSize }
  : undefined);
const contextPct = ctx?.size ? Math.round((ctx.used / ctx.size) * 100) : undefined;
```

**Render — right-side vertical bar (added inside the `flex items-start gap-2` div, after the content column):**

```tsx
{
  contextPct !== undefined && (
    <div className="flex-shrink-0 flex flex-col items-center w-3 self-stretch ml-0.5">
      {/* Track */}
      <div className="flex-1 w-1.5 rounded-full bg-panel-border overflow-hidden relative">
        {/* Fill — color class derived from contextPct thresholds */}
        <div
          key={contextPct}
          className={`absolute bottom-0 left-0 right-0 rounded-full animate-ctx-update ${
            contextPct >= 85
              ? "bg-error-fg opacity-90"
              : contextPct >= 70
                ? "bg-warning-fg opacity-70"
                : "bg-description-fg opacity-50"
          }`}
          style={{ height: `${contextPct}%` }}
        />
      </div>
      {/* Percentage label — below the bar */}
      <span className="text-[8px] leading-none text-description-fg opacity-75 mt-0.5">
        {contextPct}
      </span>
    </div>
  );
}
```

Color cues use existing Tailwind tokens (`bg-error-fg`, `bg-warning-fg`, `bg-description-fg`):

- 0–70%: `bg-description-fg opacity-50` (neutral)
- 70–85%: `bg-warning-fg opacity-70` (warning)
- 85–100%: `bg-error-fg opacity-90` (danger)

**Update animation — brightness flash on each value change:**

Add `key={contextPct}` to the fill div. React unmounts and remounts the element whenever the value changes, automatically restarting the CSS animation. Pair with a new one-shot `animate-ctx-update` class:

```tsx
<div
  key={contextPct} // ← remount on update → restarts animation
  className={`absolute bottom-0 left-0 right-0 rounded-full animate-ctx-update ${colorClass}`}
  style={{ height: `${contextPct}%` }}
/>
```

`animate-ctx-update` is defined in `tailwind.config.js` (add alongside existing keyframes):

```js
// keyframes:
"ctx-update": {
  "0%":   { filter: "brightness(2)" },
  "100%": { filter: "brightness(1)" },
},
// animation:
"ctx-update": "ctx-update 0.4s ease-out",
```

A `brightness(2)` flash fading to normal in 0.4 s. Plays once per value change, then stops — not continuous. The `key` remount also snaps the bar to the new height instantly (so `transition-all duration-300` is **removed** from the fill div; the flash is the update signal).

**Prop addition to `WorkflowStepProps`:**

```typescript
/** Live context window usage (updated during running step; falls back to latestOutput for completed) */
liveContextWindow?: { used: number; size: number };
```

**Wiring in `WorkflowStepsPanel`:**

`WorkflowStepsPanel` reads `liveContextWindow` from `workflowStore` and passes it for the current running step:

```typescript
// In WorkflowStepsPanel, when rendering the current pending step:
const liveCtx = liveContextWindow?.[index];
// Pass as prop to SortableWorkflowStepWrapper → WorkflowStepItem
```

For done (completed) steps, `liveContextWindow[index]` is cleared on step completion, so `latestOutput.tokens` data is used via the fallback path.

#### `PromptStepDetails.tsx` — Reorder stats row + remove context % chip ✅ Done

> **File note:** The plan refers to `PromptItemDetails.tsx` — the actual file is `PromptStepDetails.tsx`.

**Already implemented.** Stats row is now `[duration] · [sessionId {copy}]` — context % removed (moves to bar), duration moved first. The `calcContextPct` import and `contextPct` local variable were also removed. Row guard is now `sessionId || durationSeconds !== undefined`.

#### `PromptChipRail.tsx` — Add thin bar to each chip

Each `ChipContent` already receives `contextPct: number | undefined`. Add a 1–2px wide bar on the right edge of the chip that fills from the bottom upward, using the same color thresholds as the wide view.

**Render — add inside `ChipContent` as a right-edge absolute bar:**

The chip `<div>` needs `relative` added to its className, then the bar is absolutely positioned on the right edge:

```tsx
function ChipContent({ slotNumber, status, contextPct, canReorder, onChipClick, onOpenContextMenu }: ChipProps) {
  return (
    <div
      className={`relative flex flex-col px-1 py-1 border-b border-panel-border hover:bg-toolbar-hover-bg transition-colors${...}`}
      ...
    >
      {/* existing Row 1: slot number + status icon */}
      {/* existing Row 2: context % text */}

      {/* Right-edge context bar */}
      {contextPct !== undefined && (
        <div className="absolute right-0 top-0 bottom-0 w-[2px] overflow-hidden">
          <div
            key={contextPct}
            className={`absolute bottom-0 left-0 right-0 animate-ctx-update ${
              contextPct >= 85
                ? "bg-error-fg opacity-90"
                : contextPct >= 70
                ? "bg-warning-fg opacity-70"
                : "bg-description-fg opacity-50"
            }`}
            style={{ height: `${contextPct}%` }}
          />
        </div>
      )}
    </div>
  );
}
```

Since `useContextPct` (Layer 6b) is updated to check `liveContextWindow` first, **no other changes are needed in `PromptChipRail.tsx`** — live updates flow through automatically.

> **Note on chip text row:** The existing Row 2 (`{contextPct}%` text) is kept in the chip for now since the chip is very narrow and the text provides the numeric value the bar can't show at 2px wide. If desired it can be removed later — but the text is not shown in the wide view (that's the bar only), so the chip and wide view serve complementary roles. Revisit during implementation.

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

> **Implementation note:** `actualPromptSent` lives on `CliExecutionSession` (accessible via `session.getActualPromptText()`), not on `CliIntegration`. The sidecar is best started inside `CliExecutionRunner.executeHeadless()` after `CliTransportCoordinator.executeHeadless()` spawns the process, with the prompt text passed down as a parameter. Alternatively, add a `startContextWindowSidecar()` method on `CliIntegration` that receives `(session, onContextWindowUpdate)` so it can read `session.getActualPromptText()`.

```typescript
private startContextWindowSidecar(
  promptText: string,
  startTime: Date,
  onContextWindowUpdate: (used: number, size: number) => void
): { stop: () => void } {
  const parser = this.provider.logParser;
  if (!parser?.extractLiveContextWindow) {
    return { stop: () => {} };  // parser doesn't support live context
  }

  let watcher: fs.FSWatcher | null = null;
  let stopped = false;
  let discoveryTimer: NodeJS.Timeout | undefined;

  const discover = async () => {
    let attempts = 0;
    while (!stopped && attempts < 30) {  // ~15s max
      const logPath = await parser.discoverSessionLog(
        promptText,
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

| File                                                            | Change                                                                                       |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/flightpath/harness/shared/interfaces/ILogParser.ts`        | Add optional `extractLiveContextWindow?` method                                              |
| `src/flightpath/harness/shared/BaseLogParser.ts`                | Add default no-op implementation                                                             |
| `src/flightpath/harness/claude/ClaudeLogParser.ts`              | Implement `extractLiveContextWindow`                                                         |
| `src/flightpath/harness/copilot/CopilotLogParser.ts`            | Implement `extractLiveContextWindow`                                                         |
| `src/flightpath/harness/codex/CodexLogParser.ts`                | Implement `extractLiveContextWindow`                                                         |
| `src/flightpath/harness/gemini/GeminiLogParser.ts`              | Implement `extractLiveContextWindow`                                                         |
| `src/flightpath/harness/qwen/QwenLogParser.ts`                  | Implement `extractLiveContextWindow`                                                         |
| `src/flightpath/harness/opencode/OpenCodeLogParser.ts`          | Implement `extractLiveContextWindow`                                                         |
| `src/flightpath/harness/CliLogMonitor.ts`                       | Add `onContextWindowUpdate?` to `LogMonitorDependencies`; call in `processEvent`             |
| `src/flightpath/harness/CliIntegration.ts`                      | Add `startContextWindowSidecar()`; wire into headless execution path                         |
| `src/flightpath/harness/CliIntegration.ts`                      | Wire `onContextWindowUpdate` from `CliLogMonitor` to caller (interactive)                    |
| `src/types/DashboardConstants.ts`                               | Add `CONTEXT_WINDOW_UPDATE` to `MESSAGE_TYPES`                                               |
| `src/types/WebviewMessageTypes.ts`                              | Add `ContextWindowUpdateMessage` type + union                                                |
| `src/ui/FlightPathWebviewProvider.ts`                           | Add `updateLiveContextWindow()` method + call from CliIntegration                            |
| `src/ui/webview-react/store/workflowStore.ts`                   | Add `liveContextWindow` state + `updateLiveContextWindow` + `clearLiveContextWindow` actions |
| `src/ui/webview-react/store/workflowStore.ts`                   | Handle `CONTEXT_WINDOW_UPDATE` message; clear on `clearRuntimeStateFromStep`                 |
| `src/ui/webview-react/hooks/useContextPct.ts`                   | Check `liveContextWindow[index]` first before falling back to completed data                 |
| `src/ui/webview-react/components/prompts/WorkflowStep.tsx`      | Add vertical bar + `liveContextWindow` prop to `WorkflowStepItem`                            |
| `src/ui/webview-react/components/prompts/PromptStepDetails.tsx` | Remove `{contextPct}%` chip from stats row; remove unused `calcContextPct` call              |
| `src/ui/webview-react/components/layout/WorkflowStepsPanel.tsx` | Read `liveContextWindow` from store; pass to `WorkflowStepItem` for current step             |
| `src/ui/webview-react/components/prompts/PromptChipRail.tsx`    | Add 2px right-edge bar to `ChipContent`; add `relative` to chip container                    |
| `src/ui/webview-react/tailwind.config.js`                       | Add `ctx-update` keyframe + animation for the brightness flash                               |

---

## Open Questions

1. **Bar position:** Right side of item or left side (alongside the status icon column)? Right is less disruptive to the existing layout. Left could feel more natural as a "progress stripe". The current plan puts it on the right.

2. **Label position:** ✅ Decided — label below the bar track. Bar fills up from the bottom; number sits beneath it.

3. **Show bar for pending steps?** Could show an empty track for all steps as a visual affordance, or only show it once context data exists. Current plan: only render when `contextPct !== undefined`.

4. **Final prompt items (`FinalStepFooter`):** `PromptStepDetails` is shared with `FinalStepFooter` — the chip removal there is automatic. `FinalStepFooter` does NOT get a bar since it has its own layout and doesn't use `WorkflowStepItem`. Live context for the final step is a separate concern; skip for now.

5. **Color semantics:** Use existing Tailwind tokens `bg-error-fg` / `bg-warning-fg` / `bg-description-fg` — these map to `--vscode-errorForeground`, `--vscode-editorWarning-foreground`, `--vscode-descriptionForeground`. No new CSS variables needed.

6. **Chip text row in PromptChipRail:** The existing Row 2 (`{contextPct}%` text) is kept since the 2px bar alone can't show the numeric value in a narrow chip. Wide view shows bar only (no text chip in `PromptStepDetails`). This is intentional — the two views are complementary. Revisit if the text feels redundant after seeing it in action.
