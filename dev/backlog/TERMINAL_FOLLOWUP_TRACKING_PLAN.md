# Terminal Follow-up Tracking Plan

## Overview

When ctrlyoke completes a prompt in interactive mode, the CLI TUI often stays open.
Users can then type directly into that terminal, or the harness can auto-continue later
after an async subagent completes. Today both cases are largely invisible to ctrlyoke:
the original prompt completes, the per-prompt monitor shuts down, and any later activity
in the still-live session is no longer tracked.

This plan changes the design from "keep the prompt monitor alive longer" to a
**session-level watcher** that attaches to the live interactive session after prompt
completion and keeps observing that session until the PTY actually ends or ctrlyoke
reclaims it.

See also: `CONTINUATION_MODE_PLAN.md`. That plan is still the right answer for
ctrlyoke-originated follow-up prompts. This plan covers activity that ctrlyoke
does not dispatch itself:

- the user typing directly into the TUI
- the harness auto-continuing after an async subagent completes

---

## Problems To Solve

### 1. Manual terminal follow-ups are untracked

Current behavior:

1. ctrlyoke sends prompt N
2. Completion detected for prompt N
3. Prompt-scoped log monitoring stops
4. Terminal remains open
5. User types another prompt directly in the TUI
6. Harness responds
7. **ctrlyoke sees none of it**

Missing features:

- no output capture
- no history entry
- no token stats
- no dashboard visibility

### 2. Copilot CLI can appear to "finish" and then continue later

This is a different but related bug. In interactive mode, Copilot CLI can end its top-level
turn, fire a completion-like hook, then later resume automatically when a subagent finishes.
From ctrlyoke's perspective the session looked done, but the TUI was actually still alive
and still capable of producing more output.

Copilot's hook surface is richer than Claude's here:

- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `PreCompact`
- `SubagentStart`
- `SubagentStop`
- `Stop`

That means the fix is not just "track manual follow-ups". We also need to determine which
hooks actually fire in the async-subagent resume path so ctrlyoke stops treating the first
top-level stop as definitive session death.

---

## Core Design Shift: Session-Level Watcher

Do **not** try to stretch the existing prompt-scoped `CliLogMonitor` past prompt completion.
That monitor is intentionally terminal: it resolves the prompt, drains, closes the watcher,
and fires `onResponseComplete`.

Instead, add a separate **session-level watcher** with these properties:

- starts after a prompt completes while the PTY is still alive
- owns a session log path plus current read offset / cursor
- watches for new turns in the same live session
- can outlive any single prompt execution
- stops when:
  - the PTY exits
  - ctrlyoke starts a new run that takes ownership of the session
  - the terminal is explicitly closed
  - an inactivity timeout expires, if we choose to add one

This watcher should be attached to the integration / interactive session state,
not to a queue step.

---

## Proposed Tracking Model

### Trigger path

Use hook events as the primary trigger and the log as the source of truth for content.

- Hook events tell us that something happened in the live session
- Log tailing tells us what prompt text and response content actually occurred

For manual terminal follow-ups, the best trigger is `userPromptSubmit` when available.

For async auto-resume behavior, the interesting trigger set depends on harness:

- Copilot: investigate `SubagentStart`, `SubagentStop`, `UserPromptSubmit`, and `Stop`
- Claude: likely still infer from session log + PTY liveness because the hook surface is narrower

### Tracking target

Do **not** start by synthesizing queue steps.

Queue steps are executor-owned and assume `WorkflowExecutor.sendPrompt()` initiated them.
Manual terminal activity does not fit that lifecycle cleanly.

Initial target:

- create observed session-turn records outside the dispatch queue
- surface them in output history / dashboard as tracked session activity
- record prompt text, response text, timestamps, token stats, and session ID
- visually distinguish them from ctrlyoke-dispatched prompts

Queue/editor integration can be considered later if replay / undo / re-run becomes necessary.

---

## Implementation Sketch

### 1. Session watcher lifecycle

After an interactive prompt completes successfully:

- if the PTY is still alive, register or resume a session-level watcher
- seed it with:
  - `sessionId`
  - `logPath`
  - last processed log offset / timestamp
  - harness ID
  - workflow / terminal identity

The existing prompt monitor remains unchanged and still resolves the prompt normally.
The new watcher begins only after that.

### 2. Hook-driven wake-up

Use hook events to wake or steer the session watcher.

For follow-up tracking:

- `userPromptSubmit` means a new user-originated turn likely started

For Copilot async-subagent investigation:

- `SubagentStart` means the top-level agent delegated work
- `SubagentStop` may be the signal that the parent session is about to continue
- a second `Stop` after `SubagentStop` may represent the true terminal idle point
- `SessionStart` should be observed too in case Copilot internally starts a fresh nested session

Important: this must not depend on browser/desktop notification settings. Internal tracking
hooks should be enabled by tracking logic itself, not only when notification toggles are on.

### 3. Distinguish real user prompts from tool traffic

For Claude-style logs, not every `user` event is a human prompt. Tool results also arrive
as `user` events. Filter using content blocks:

```typescript
function isHumanPrompt(event: ClaudeProviderEvent): boolean {
  if (event.type !== "user") return false;
  const content = event.message?.content ?? [];
  return content.some(
    (block: any) => block.type === "text" && block.text?.trim()
  );
}
```

Additional guards:

- only consider events after the watcher's current offset / timestamp
- suppress prompts ctrlyoke injected itself in continuation inject mode
- require the watcher to correlate a prompt boundary with subsequent assistant output

### 4. Capture the observed turn

When the session watcher detects a new turn:

- extract prompt text from the log
- begin buffering subsequent assistant/tool events
- close the observed turn when the harness reaches the next stable completion point
- persist:
  - prompt text
  - response text
  - structured events
  - tokens / context window stats
  - session ID
  - timestamps
  - origin marker like `terminal-followup` or `session-auto-continue`

### 5. History / dashboard presentation

Show observed turns in history/output with an explicit visual distinction:

- terminal follow-up
- auto-continued session activity

The key requirement is visibility and replay of output, not queue mutability.

---

## Copilot Async-Subagent Investigation Plan

Before implementing Copilot-specific completion fixes, verify the actual hook sequence in the
problem case:

1. Start a Copilot interactive session that delegates to a subagent
2. Observe which hooks fire when the top-level agent appears to stop
3. Observe which hooks fire when the subagent completes
4. Observe whether the parent session emits:
   - `SubagentStop`
   - another `UserPromptSubmit`
   - another `Stop`
   - `SessionStart`
   - none of the above

Questions to answer:

- Does `Stop` fire before the session is truly idle?
- Is `SubagentStop` the best signal that the parent may resume?
- Is there a second definitive `Stop` after the resumed parent turn?
- Does Copilot ever create a new session boundary for the resumed activity?

Possible outcomes:

- If `SubagentStop` consistently precedes resumed parent output, keep the session watcher alive
  through that boundary and do not treat the first `Stop` as final session idleness.
- If a second `Stop` always fires after resumed output, use the first as prompt completion and
  the second as session-level idle confirmation.
- If no useful hook fires, fall back to PTY liveness + log activity for Copilot.

---

## Edge Cases & Challenges

### Race: terminal follow-up vs ctrlyoke-dispatched prompt

If the user types in the terminal while ctrlyoke is about to resume or restart the session:

- the session log remains authoritative
- snapshot the session watcher's last processed offset before ctrlyoke reclaims the PTY
- drain any intervening events before shutdown / restart

### Session reuse with `--resume`

If the same session log keeps growing across resumed runs:

- offset-based tracking still works
- the watcher must persist its last consumed position, not just session ID

### Inject mode overlap

Injected ctrlyoke prompts can look like manual terminal prompts in the log.

Mitigation:

- maintain a short-lived "pending inject" correlation marker
- when the matching user/log event appears, attribute it to ctrlyoke dispatch, not manual follow-up

### finalStep interaction

If a workflow has a `finalStep`, prompt completion and session-idle semantics may diverge.
The session watcher should attach to the live terminal session, not to "queue empty" alone.

### False positives from programmatic user-role events

Some harnesses may emit user-role messages that are not real user prompts.
The tracker should require both:

- a plausible prompt boundary
- subsequent assistant activity attributable to that boundary

---

## Relationship to Continuation Mode

|                          | Session-Level Follow-up Tracking          | Continuation Mode (inject)               |
| ------------------------ | ----------------------------------------- | ---------------------------------------- |
| **Who sends the prompt** | User or harness, outside ctrlyoke         | ctrlyoke                                 |
| **Ownership of the turn**| Observed after the fact                   | Fully owned by ctrlyoke                  |
| **Tracking fidelity**    | Best-effort, session-level observation    | Full                                     |
| **Best for**             | Manual TUI use, async harness continuation| Workflow-driven follow-up execution      |

The two features are complementary:

- user types in terminal → tracked by session watcher
- harness auto-continues later → tracked by session watcher
- ctrlyoke sends next prompt via inject mode → tracked as a normal dispatched prompt

---

## Open Questions

1. Should session watchers time out after inactivity?
2. Should observed turns be stored only in history/timeline at first, or also projected into
   the visible step list?
3. Should the feature be always-on for live interactive sessions, or gated by a setting?
4. For Copilot specifically, what exact hook sequence occurs around `SubagentStop` and resumed
   parent output?
