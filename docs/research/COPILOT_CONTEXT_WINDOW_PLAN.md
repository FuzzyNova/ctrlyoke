# Copilot Headless Context Window Support Plan

## Problem

When Copilot CLI runs in headless mode with `--output-format json`, the stdout JSONL stream contains
no input token data. The `result` event only carries timing and code-change metrics. Output tokens
per turn are available via `assistant.message.data.outputTokens`, but input tokens — which are what
drive context window fill — are absent entirely.

This means `CopilotResponseParser.parseJsonLines()` currently emits `inputTokens: 0` and omits
`contextWindowUsedTokens`, so the dashboard cannot show context window usage for headless runs.

---

## Why Post-Parse Is the Permanent Architecture

Real-time context tracking during execution is possible for Claude and Codex because their usage
data arrives in-stream via stdout. Copilot's context data (`session.truncation` events) is written
only to the session log file at `~/.copilot/session-state/<sessionId>/events.jsonl` — never to
stdout, regardless of output format.

The session ID needed to locate that log file only appears in the final `result` event at the very
end of the JSONL stream. This creates a chicken-and-egg problem: you cannot start tailing the log
for real-time updates during execution because you do not have the session ID until execution ends.

A workaround exists (watch the session-state directory for new entries from execution start, match
by recency or prompt), but it is fragile under concurrent sessions and meaningfully more complex.
The post-parse log read is therefore the correct permanent architecture for Copilot headless, not a
stepping stone to something else.

---

## Data Source

Copilot writes `session.truncation` events to the session log on every model call turn, before the
response. Each event contains:

```json
{
  "type": "session.truncation",
  "data": {
    "tokenLimit": 128000,
    "preTruncationTokensInMessages": 47200,
    "postTruncationTokensInMessages": 47200,
    "tokensRemovedDuringTruncation": 0,
    ...
  }
}
```

- `postTruncationTokensInMessages` — tokens actually sent to the model this turn (= input tokens)
- `tokenLimit` — the model's context window size

The event fires on every turn, so for a multi-turn session the last occurrence represents the
highest context fill and is what we want for the final usage stat.

`CopilotLogParser` already parses these events in `extractResponse()` (interactive mode path).
`CopilotLogParser.getLogPath(sessionId)` already resolves the log file path for a known session ID,
handling both new (`<id>/events.jsonl`) and old (`<id>.jsonl`) log formats.

---

## Implementation

Four changes across three files. No schema changes. No UI changes.

---

### Step 1 — `CopilotLogParser`: add `extractTruncationDataFromLog(sessionId)`

New static method. Reads the session log for a known session ID and returns the data from the last
`session.truncation` event. Static because it needs no instance state.

```typescript
/**
 * Extract context window data from a session log by session ID.
 *
 * Reads the last `session.truncation` event from the session log, which fires
 * once per model call turn and contains the most accurate context fill data.
 * Returns the final (highest) values from a multi-turn session.
 *
 * Used by CopilotCliProvider.augmentParsedOutput() to patch missing input token
 * data in JSON-mode headless output.
 *
 * @param sessionId - Session UUID from the `result` event in JSONL stdout
 * @returns Truncation data if found, undefined if log unavailable or unreadable
 */
static async extractTruncationDataFromLog(
  sessionId: string
): Promise<{ postTruncationTokensInMessages: number; tokenLimit: number } | undefined> {
  const logPath = await CopilotLogParser.getLogPath(sessionId);
  if (!logPath) {
    return undefined;
  }

  try {
    const content = fs.readFileSync(logPath, "utf-8");
    let last: { postTruncationTokensInMessages: number; tokenLimit: number } | undefined;

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed);
        if (
          event.type === "session.truncation" &&
          typeof event.data?.postTruncationTokensInMessages === "number" &&
          typeof event.data?.tokenLimit === "number"
        ) {
          last = {
            postTruncationTokensInMessages: event.data.postTruncationTokensInMessages,
            tokenLimit: event.data.tokenLimit,
          };
        }
      } catch {
        // Skip malformed lines
      }
    }

    return last;
  } catch {
    return undefined;
  }
}
```

---

### Step 2 — `ICliProvider`: add optional `augmentParsedOutput?`

New optional method on the interface. Called by `CliIntegration` after `responseParser.parse()`
completes. Returns the (potentially modified) output. Only Copilot implements it.

Add to `ICliProvider` in `src/flightpath/harness/shared/interfaces/ICliProvider.ts`:

```typescript
/**
 * Augment parsed output after the response parser runs (optional).
 *
 * Called by CliIntegration immediately after responseParser.parse() in headless mode.
 * Use for post-parse data enrichment that requires async work the synchronous parser
 * cannot do (e.g., reading session log files to retrieve token usage data).
 *
 * Return the same or a modified UniversalCliOutput. Must not throw.
 *
 * @param output - Output from responseParser.parse()
 * @returns Enriched output (or same object if no changes needed)
 */
augmentParsedOutput?(output: UniversalCliOutput): Promise<UniversalCliOutput>;
```

Add the `UniversalCliOutput` import to `ICliProvider.ts` — it is already imported in the
implementing classes, just not in the interface file.

---

### Step 3 — `CopilotCliProvider`: implement `augmentParsedOutput`

Guards:
- Skip if `rawTextOutput: true` (interactive/plain-text path — token data comes from stderr stats)
- Skip if `inputTokens` is already non-zero (future-proof if Copilot ever adds it to stdout)
- Skip if no session ID (cannot locate log)
- Skip if log read fails (silently — the existing `contextWindowSize` constant fallback remains)

```typescript
/**
 * Augment JSON-mode headless output with context window data from the session log.
 *
 * Copilot's --output-format json stdout contains output tokens per turn but no input tokens.
 * The session.truncation events in the session log file contain both postTruncationTokensInMessages
 * (= input tokens sent to the model) and tokenLimit (= context window size).
 *
 * This is the permanent architecture for Copilot headless — session ID is not available until
 * the final result event, so real-time log tailing during execution is not feasible.
 */
async augmentParsedOutput(output: UniversalCliOutput): Promise<UniversalCliOutput> {
  // Plain-text mode: token data comes from stderr stats in parseTokenCounts(), not needed here.
  if (output.metadata.rawTextOutput) {
    return output;
  }

  const sessionId = output.metadata.sessionId;
  if (!sessionId) {
    return output;
  }

  // Already have input token data — Copilot may add this to JSON output in a future version.
  if (output.metadata.usage && output.metadata.usage.inputTokens > 0) {
    return output;
  }

  const truncation = await CopilotLogParser.extractTruncationDataFromLog(sessionId);
  if (!truncation) {
    Log.debug(`[CopilotCliProvider] No truncation data in session log for ${sessionId}`);
    return output;
  }

  const { postTruncationTokensInMessages, tokenLimit } = truncation;
  const outputTokens = output.metadata.usage?.outputTokens ?? 0;

  Log.debug(
    `[CopilotCliProvider] Context from session log: ${postTruncationTokensInMessages}/${tokenLimit} tokens`
  );

  return {
    ...output,
    metadata: {
      ...output.metadata,
      usage: {
        ...output.metadata.usage,
        inputTokens: postTruncationTokensInMessages,
        outputTokens,
        totalTokens: postTruncationTokensInMessages + outputTokens,
        contextWindowUsedTokens: postTruncationTokensInMessages,
        contextWindowSize: tokenLimit,
      },
    },
  };
}
```

---

### Step 4 — `CliIntegration`: call `augmentParsedOutput` after `parse()`

In `CliIntegration.ts`, in the headless completion callback where `parse()` is called
(currently around line 1464):

```typescript
// Parse result using provider's response parser (returns UniversalCliOutput)
let parsedOutput = this.provider.responseParser.parse(
  result.stdout,
  result.stderr,
  result.exitCode
);

// Let provider augment parsed output with data unavailable during synchronous parsing
// (e.g., Copilot reads session log for context window stats after process exits).
if (this.provider.augmentParsedOutput) {
  parsedOutput = await this.provider.augmentParsedOutput(parsedOutput);
}
```

The callback is already async, so no signature changes are needed.

---

## Fallback Behaviour

If the session log is missing or unreadable (log dir not present, permissions issue, race condition
on Windows where the file handle is briefly locked):

- `extractTruncationDataFromLog` returns `undefined` silently
- `augmentParsedOutput` returns the original output unchanged
- The dashboard displays output tokens only, with `contextWindowSize` from the
  `COPILOT_CLI_CONTEXT_WINDOW_SIZE` constant already set by `parseJsonLines()`
- No error is surfaced to the user; the debug log records the miss

This is the same graceful degradation already in place for session ID log discovery.

---

## What Does Not Change

- `IResponseParser.parse()` stays synchronous — no interface change
- `parsePlainText()` is unaffected — it already reads input tokens from stderr stats
- The `COPILOT_CLI_CONTEXT_WINDOW_SIZE` constant remains as a fallback for `contextWindowSize`
  in case the log read fails (it is already set in `parseJsonLines()`)
- No schema changes, no settings changes, no UI changes

---

## Files Changed

| File | Change |
|------|--------|
| `src/flightpath/harness/copilot/CopilotLogParser.ts` | Add static `extractTruncationDataFromLog(sessionId)` |
| `src/flightpath/harness/shared/interfaces/ICliProvider.ts` | Add optional `augmentParsedOutput?` + `UniversalCliOutput` import |
| `src/flightpath/harness/copilot/CopilotCliProvider.ts` | Implement `augmentParsedOutput()` |
| `src/flightpath/harness/CliIntegration.ts` | Call `augmentParsedOutput` after `parse()` |
