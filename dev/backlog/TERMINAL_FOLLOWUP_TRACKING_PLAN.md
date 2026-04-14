# Terminal Follow-up Tracking Plan

## Overview

When FlightPath completes a prompt in interactive mode, the Claude TUI stays running.
Users naturally type follow-up questions directly into the terminal — but those follow-ups
are invisible to FlightPath: no history entry, no output capture, no undo/redo, no token
stats. This plan proposes **passive log monitoring** to detect user-typed follow-ups and
retroactively bring them into FlightPath's tracking layer.

See also: `CONTINUATION_MODE_PLAN.md` — a complementary (and possibly superior) approach
that proactively injects follow-up prompts through FlightPath rather than passively
observing them. The two features serve different interaction styles and can coexist.

---

## Current Behavior

1. FlightPath sends prompt N → Stop hook fires → completion detected → log monitoring stops
2. Terminal remains open
3. User types follow-up directly in the TUI
4. Claude responds
5. **FlightPath sees none of this** — no queue entry, no output capture, no history

---

## Proposed: Passive Log Tail After Completion

After Stop hook fires for the last queued prompt, instead of fully stopping log
observation, FlightPath enters a **follow-up watch mode**:

- Continue tailing the JSONL session log
- If a new `user` event appears that looks like a typed prompt (not a tool_result),
  synthesize a queue entry for it
- Monitor the subsequent `assistant` events as if FlightPath had sent the prompt
- Emit output to the dashboard (history, output panel, token stats)
- Stop follow-up watching when the session ends, a new FlightPath workflow run starts,
  or the terminal is closed

---

## Implementation Sketch

### 1. Follow-up Watch Mode Entry

In `CliIntegration` (or `ClaudeNotificationMonitor`), after the final prompt's Stop hook
fires and there are no more queued prompts:

- Do NOT tear down the log monitor
- Transition the log watcher to a passive "tail" state

### 2. Distinguishing User Prompts from Tool Results

Not every `user` event in the JSONL is a human-typed message. Claude's log also uses
`user` events for `tool_result` blocks returned after tool executions. To filter:

```typescript
function isHumanPrompt(event: ClaudeProviderEvent): boolean {
  if (event.type !== "user") return false;
  const content = event.message?.content ?? [];
  // A real user prompt has at least one text block
  // Tool results have tool_result blocks, not text blocks
  return content.some(
    (block: any) => block.type === "text" && block.text?.trim()
  );
}
```

Caveat: if the user's follow-up happens during an active tool use cycle, the `user` event
ordering may interleave with tool_result events. Use the `type` field to filter reliably.

### 3. Synthetic Queue Entry

When a human prompt is detected in the log tail:

- Extract the prompt text from the `text` block
- Create a synthetic `PromptItem` (flagged as `source: "terminal-followup"`)
- Add to `WorkflowInstance`'s queue as an observed (not dispatched) entry
- Begin capturing subsequent `assistant` events as the response

### 4. Output Capture

Reuse the existing `OutputCaptureBuffer` and log-parsing pipeline. The synthetic entry
flows through the same output extraction path as a FlightPath-dispatched prompt —
the log contains the full event stream regardless of how the prompt was submitted.

### 5. History / Dashboard

The synthetic entry appears in the output history view with a visual indicator
(e.g., a small "terminal" icon or "(follow-up)" label) to distinguish it from
FlightPath-dispatched prompts. Token stats are extracted from the log events as normal.

---

## Edge Cases & Challenges

### Race: User types in terminal + FlightPath queues a new prompt simultaneously

If the user types a follow-up AND queues a FlightPath prompt at roughly the same time:

- FlightPath's queued prompt will kill the terminal and restart with `--resume`
- The terminal follow-up may or may not have been submitted before the kill
- The JSONL log is authoritative and chronologically ordered — use event timestamps
  to determine which events belong to the terminal follow-up vs the FlightPath prompt

Mitigation: when FlightPath is about to dispatch a new prompt (kill + restart), snapshot
the last known log file offset. Any log events between the last tracked offset and the
kill are the "in-flight terminal follow-up" events. Attempt to capture them before the
kill completes.

### Session boundary ambiguity

If `--resume` restarts into the same session ID, the JSONL file gets new entries appended.
The offset-based tail approach handles this naturally — only events after the
"follow-up watch mode entry" offset are considered.

### Inject mode overlap (CONTINUATION_MODE_PLAN.md)

If inject mode is active, FlightPath prompts are also delivered via PTY write and would
appear in the log as `user` events with `text` blocks — identical to a human-typed
follow-up. Need to suppress the synthetic-entry creation for prompts FlightPath itself
injected (track a "pending inject" flag, clear it when the corresponding user event is seen).

### False positives

Some Claude workflows emit user-role messages programmatically (e.g., MCP tool callbacks).
The `source: "terminal-followup"` heuristic may misclassify these. A secondary check:
only treat `user` events as follow-ups if they occur **after** the Stop hook for the
preceding turn (i.e., Claude has already finished responding and is idle).

---

## Relationship to Continuation Mode

|                          | Terminal Follow-up Tracking               | Continuation Mode (inject)               |
| ------------------------ | ----------------------------------------- | ---------------------------------------- |
| **Who sends the prompt** | The user, directly in the TUI             | FlightPath (via PTY write)               |
| **FlightPath features**  | Retroactively applied (best-effort)       | Fully applied (attachments, properties)  |
| **Tracking fidelity**    | Passive observation, may miss edge cases  | Full — FlightPath owns the turn          |
| **Effort to use**        | Zero — just type in the terminal          | Must go through FlightPath UI / workflow |
| **Best for**             | Quick one-off follow-ups, debugging turns | Multi-step workflows with context needs  |

The two features are complementary. A possible combined UX:

- Type in terminal → passively tracked (this plan)
- Send via FlightPath with `continuationMode: inject` → fully tracked, fast (continuation mode plan)
- Send via FlightPath with `continuationMode: restart` → fully tracked, slower (current behavior)

---

## Open Questions

1. Should the follow-up watch mode have a timeout? (e.g., stop tailing after 30 minutes
   of inactivity so we don't hold file handles open forever)
2. Should follow-up entries be replayable via undo/redo? (They weren't dispatched by
   FlightPath so replay would require re-injecting the prompt text — possible but adds
   complexity)
3. Should follow-up watch mode be opt-in (a setting) or always-on when the terminal is idle?
4. How does this interact with workflows that have `finalStep` defined? The finalStep may
   suppress queue-empty follow-up watching since the workflow isn't "done" yet.
