# Continuation Mode Plan

## Overview

Add a `continuationMode` setting that controls how FlightPath sends follow-up prompts
to a running interactive CLI session. The current behavior (`restart`) kills the terminal
and spawns a new Claude process with `--resume <sessionId>`. The new `inject` mode keeps
the existing TUI session alive and writes the next prompt directly into the PTY, avoiding
terminal teardown latency and bypassing the Claude Code resume cache bug (where filtering
of resumed messages breaks prompt cache hits).

`--resume` is **not removed**. It remains the mechanism for resuming sessions from prior
FlightPath runs (across extension restarts). `inject` mode only applies to within-run
sequential prompts where the TUI is already running.

---

## Motivation

### Resume Cache Bug (Anthropic upstream)
When Claude Code resumes a session via `--resume`, it filters conversation history
(`filterUnresolvedToolUses`, `filterOrphanedThinkingOnlyMessages`, etc.) before sending
to the API. This changes the message structure, breaking the cache prefix match. The
entire conversation history is re-processed at full input token cost (~10x more expensive
than a cache hit) on every resumed turn. Anthropic will likely fix this, but inject mode
sidesteps it entirely by never restarting the process.

### Terminal Teardown Latency
Each prompt transition currently involves:
1. Kill terminal session
2. Wait for PTY cleanup
3. Spawn new Claude process
4. Wait for Claude TUI to initialize
5. Claude re-reads workspace context
6. Prompt finally begins

In inject mode: Stop hook fires → write next prompt to PTY → Claude responds immediately.
No startup overhead.

---

## Setting

```json
// package.json contributes.configuration.properties
"flightpath.interactiveContinuationMode": {
  "type": "string",
  "default": "restart",
  "enum": ["restart", "inject"],
  "enumDescriptions": [
    "Kill and restart the terminal for each prompt (current behavior). Uses --resume to restore session.",
    "Keep the TUI alive and inject follow-up prompts directly into the running terminal. Faster and avoids the Claude Code resume cache bug."
  ],
  "description": "Controls how follow-up prompts are sent in interactive mode."
}
```

Add accessor to `ConfigurationUtils`:
```typescript
static getInteractiveContinuationMode(): "restart" | "inject" {
  return ConfigurationUtils.get<"restart" | "inject">(
    "interactiveContinuationMode",
    "restart"
  );
}
```

---

## How It Works

### Current Flow (restart mode)
```
Prompt N completes → Stop hook fires → FlightPath detects completion
→ killTerminal()
→ spawnNew(`claude "${promptN+1}" -r ${sessionId} [args]`)
→ wait for SessionStart hook
→ monitor for next Stop hook
```

### Inject Mode Flow
```
Prompt N completes → Stop hook fires → FlightPath detects completion
→ writeToTerminal(promptN+1 text + "\n")
→ monitor for next Stop hook (same session, same PTY)
```

No kill. No spawn. No `--resume`. The Claude TUI receives the text as if a human typed it.

### First Prompt
The first prompt in a workflow always starts Claude normally (potentially with `--resume`
if `resumeSession: true` on the first step). Inject mode only activates for subsequent
prompts within the same run.

### Session ID Tracking
In inject mode, the session ID naturally carries forward — Claude is still in the same
session. `SessionStart` won't fire again for follow-up prompts (Claude didn't restart),
so session ID tracking must be adjusted: retain the session ID from the initial
`SessionStart` notification for the duration of the inject-mode chain.

---

## Implementation

### 1. `ConfigurationUtils.ts`
Add `getInteractiveContinuationMode()` accessor.

### 2. `CliIntegration.ts` — `runExecutionSession()`
After Stop hook fires for prompt N and there is a prompt N+1:
- Check `ConfigurationUtils.getInteractiveContinuationMode()`
- If `"inject"`: call `injectPromptIntoTerminal(promptText)` instead of the normal
  kill → restart cycle
- If `"restart"`: existing behavior unchanged

### 3. `CliIntegration.ts` — `injectPromptIntoTerminal()`
New private method:
```typescript
private async injectPromptIntoTerminal(promptText: string): Promise<void> {
  // Write prompt text to the active PTY session
  // PtyProcessManager or the active terminal reference handles the write
  // Append "\n" to submit (equivalent to pressing Enter in the TUI)
}
```

The exact PTY write API depends on how `PtyProcessManager` exposes writes to an
existing session. May require surfacing a `write(sessionId, text)` method if not
already available.

### 4. `CliInteractiveStartupCoordinator.ts`
In inject mode, the coordinator's `waitForSessionStart()` must be skipped for follow-up
prompts (Claude didn't restart, so `SessionStart` won't fire). The session ID from the
initial start should be passed through.

### 5. Session ID Handling
`CliSessionResolverAdapter` or equivalent must be told: "in inject mode, reuse the
session ID from prompt N for prompt N+1 without waiting for a new SessionStart."

### 6. `package.json`
Add setting declaration under `contributes.configuration.properties`.

---

## Scope & Constraints

- **Interactive mode only.** Headless mode uses process exit for completion detection and
  has no TUI to inject into — inject mode has no effect there.
- **Claude CLI first.** Claude is the harness with the confirmed cache bug and the
  clearest benefit. Other hook-based harnesses (Codex, Qwen, Gemini, OpenCode) could
  support inject mode later if their TUI input semantics are compatible.
- **Copilot CLI:** Uses log file monitoring rather than Stop hooks; different completion
  detection path. Evaluate separately.
- **`resumeSession` on follow-up prompts:** In inject mode, the `resumeSession` field on
  prompt N+1 is effectively a no-op — the session is already live. Log a debug note if
  `resumeSession: false` is set on a follow-up prompt in inject mode (the session
  continues regardless since the TUI is shared).
- **Unexpected process exit:** Existing unexpected-exit detection remains active. If
  Claude dies mid-workflow in inject mode, FlightPath falls back to the normal error
  handling path.
- **User aborts/cancels:** Cancel should kill the terminal as normal regardless of mode.

---

## UI

- The setting is exposed in the GlobalSettings drawer under the "Execution" section,
  alongside `cliExecutionMode`.
- No per-workflow or per-prompt override needed — this is a machine-level execution
  preference.

---

## Open Questions

1. Does `PtyProcessManager` already expose a `write()` method for an active session,
   or does it need to be added?
2. Does the Claude TUI interpret a bare `\n` (newline) as prompt submission, or does
   it need `\r` or a specific key sequence? Verify against Claude Code's TUI input
   handling.
3. Multi-line prompts: if the prompt text contains newlines, Claude's TUI may interpret
   intermediate newlines as submissions. May need to use the `--input-format` flag or
   paste mode if Claude supports it, or escape newlines differently.
