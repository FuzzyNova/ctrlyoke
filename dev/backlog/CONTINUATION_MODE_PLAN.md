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
Each prompt transition in restart mode involves:
1. Spawn new PTY session with `claude --resume <sessionId>`
2. Wait for Claude TUI to initialize
3. Claude re-reads workspace context
4. Wait for `SessionStart` hook
5. Prompt finally begins

(The old PTY session from prompt N is not explicitly killed — Claude exits naturally after
the Stop hook fires, closing its PTY. But the new session startup is still the bottleneck.)

In inject mode: Stop hook fires → write next prompt to PTY → Claude responds immediately.
No spawn, no startup, no session discovery wait.

---

## Setting

Settings live in the file-based config system (`~/.flightpath/settings.json` / `.flightpath/settings.json`). VS Code's `package.json` contributes.configuration is also required so the setting is discoverable via the VS Code settings UI and so `VSCODE_SETTINGS_KEY_MAP` in `WebviewSettingsSync.ts` can forward VS Code settings changes into the config file.

### 1. `src/types/FlightPathSettings.ts` — add to `execution` object

```typescript
execution: {
  mode: "interactive" | "headless";
  continuationMode: "restart" | "inject";  // ← new
  maxPromptTimeout: number;
  scriptTimeout: number;
  closeTerminalOnComplete: boolean;
};
```

Also add the default in `FLIGHTPATH_SETTINGS_DEFAULTS`:
```typescript
execution: {
  mode: "interactive",
  continuationMode: "restart",  // ← new
  ...
}
```

### 2. `schemas/settings-schema.json` — add to `execution.properties`

```json
"continuationMode": {
  "type": "string",
  "enum": ["restart", "inject"],
  "description": "Controls how follow-up prompts are sent in interactive mode. 'restart' kills and restarts the terminal (uses --resume). 'inject' keeps the TUI alive and writes the next prompt directly into the PTY."
}
```

### 3. `package.json` — add to `contributes.configuration.properties`

```json
"flightpath.interactiveContinuationMode": {
  "type": "string",
  "default": "restart",
  "enum": ["restart", "inject"],
  "enumDescriptions": [
    "Kill and restart the terminal for each prompt (current behavior). Uses --resume to restore session.",
    "Keep the TUI alive and inject follow-up prompts directly into the running terminal. Faster and avoids the Claude Code resume cache bug."
  ],
  "description": "[Interactive Mode] Controls how follow-up prompts are sent in interactive mode."
}
```

### 4. `src/ui/WebviewSettingsSync.ts` — add to `VSCODE_SETTINGS_KEY_MAP`

```typescript
"interactiveContinuationMode": "execution.continuationMode",
```

This forwards VS Code settings changes into the file-based config service.

### 5. `src/utils/ConfigurationUtils.ts` — add typed accessor

```typescript
static getInteractiveContinuationMode(): "restart" | "inject" {
  return configService.get("execution").continuationMode;
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

### Controller Handoff on Injection
Any client (controller or viewer) may send a continuation prompt. When a client sends an
inject-mode continuation, it **automatically takes control** of the terminal — mirroring
the existing `restart` mode precedent where the client that triggers a `--resume` spawn
is assigned as the new controller by `PtyProcessManager.consumePendingController()`.

Rationale: injecting a prompt is an active editorial act equivalent to spawning a new
terminal. Having the injecting client own the resulting session is the consistent and
expected UX. Multi-viewer scenarios where a mobile client injects while a desktop client
should stay in control are edge cases not worth special-casing at this stage.

Implementation: before writing the injected text to the PTY, call
`ptyProcessManager.setPendingController(workflowId, clientId)` with the injecting
client's ID so the assignment is ready when the webview-side session update is broadcast.

---

### Terminal Lifecycle (Confirmed Current Behaviour — No Change Needed)

After investigating all teardown call sites, **PTY sessions (node-pty) are already kept
alive after workflow completion and are not killed on workflow switching**. The
"teardown-on-navigation" fear was unfounded for the PTY path.

#### Full teardown call site map

| Call site | What it kills | PTY killed? |
|---|---|---|
| `WorkflowInstance.dispose()` (ext. deactivation) | `lastRunIntegrations.closeTerminal()` → `processManager.disposeTerminal()` → VS Code terminal only | **No** |
| `WorkflowInstance.startWorkflowExecution()` finally | `execIntegration.dispose()` → `processManager.disposeProcess()` (if `closeTerminalWhenPromptCompletes=false`) | **No** |
| `WorkflowInstance.startWorkflowExecution()` pre-run cleanup | `lastRunIntegrations.closeTerminal()` → VS Code terminal only | **No** |
| `WorkflowInstance.getIntegrationForPrompt()` harness switch (line 1827) | `closeTerminal()` → VS Code terminal only | **No** |
| `CliTransportCoordinator.cancel()` | `ptyManager.killSession()` | **Yes** — user abort only |
| `PtyProcessManager.dispose()` | All PTY sessions | **Yes** — extension deactivation |
| `WebviewMessageRouter` KILL_TERMINAL | Single PTY session by ID | **Yes** — user-initiated from webview |

`closeTerminal()` and `dispose()` only operate on `CliProcessManager.terminal`
(VS Code terminal, used in the legacy shell-integration path). In the node-pty path
`CliProcessManager.currentProcess` is undefined (the process runs inside the PTY), so
`disposeProcess()` is also a no-op. PTY sessions die only via natural process exit,
user cancel, or explicit kill from the webview.

#### Implications — PTY process

- **PTY sessions outlive workflow completion** — no explicit teardown on switch or
  completion in the node-pty path.
- **`FrozenOverlay` behaviour** is correct: it dims only when `TERMINAL_ENDED` has
  fired (PTY process actually exited), not on workflow completion.

#### The actual "terminal gone" bug — root cause unknown, needs live debugging

The observed "terminal disappears on switch-back" is **not** a PTY kill, and it is
**not** triggered by `TERMINAL_ENDED`. All harnesses — including Claude — keep their TUI
running after responding. The process waits at the prompt; the user sees the process-exit
footer only after explicitly quitting. `TERMINAL_ENDED` therefore never fires for a
completed workflow.

Since `TERMINAL_ENDED` never fires, `setActiveOutputTab(workflowId, "output")` in that
handler is never reached. `activeOutputTab` stays as `"terminal"` across workflow
switches. Yet the terminal is still visually absent on switch-back.

**Suspected area:** The xterm.js DOM reattachment path triggered by SWITCH_WORKFLOW.
`replayWorkflowStateTo()` sends `TERMINAL_STARTED` for live PTY sessions; the webview's
TERMINAL_STARTED handler checks idempotency (returns early if sessionId already in store)
and then calls `terminalRegistry.attach()` to reinsert the DOM element. A race or
state-inconsistency in that `mount()` async path may cause the container to be populated
but not visible, or the reattach to silently fail.

**Status:** Requires live debugging during implementation — cannot be diagnosed from code
inspection alone. This is a known risk item for the inject mode implementation; the
"terminal tab stays active but appears blank on switch-back" issue should be investigated
as part of the inject mode dev cycle.

#### VS Code terminal path — not dead code but effectively legacy

`CliTransportCoordinator.startInteractiveProcess` falls through to the VS Code
shell-integration path (`createFreshTerminal`) only when `getPtyProcessManager()`
returns null. In normal VS Code operation the PTY manager is always initialized. The
fallback fires only in tests or a startup race. Keep it; do not remove.

#### Multi-harness workflow (e.g. prompt 1 = claude, prompt 2 = copilot)

When switching harnesses mid-workflow (`getIntegrationForPrompt`, line 1827),
`closeTerminal()` is called on the previous harness's integration. In the PTY path this
is a no-op: the claude PTY session from prompt 1 remains alive while copilot's PTY
session spawns for prompt 2. Both sessions coexist.

At the end of the workflow `dispose()` is called on both integrations. Neither kills a
PTY session. Both harness TUIs remain alive and injectable.

**Confirmed: multi-harness workflows already give each harness a live terminal after
completion.** No code changes needed for this scenario.

---

## Implementation

### 1. Settings wiring (four files)
- `src/types/FlightPathSettings.ts` — add `continuationMode` to `execution` type and defaults
- `schemas/settings-schema.json` — add `continuationMode` to `execution.properties`
- `package.json` — add `flightpath.interactiveContinuationMode` to contributes.configuration
- `src/ui/WebviewSettingsSync.ts` — add `"interactiveContinuationMode": "execution.continuationMode"` to `VSCODE_SETTINGS_KEY_MAP`
- `src/utils/ConfigurationUtils.ts` — add `getInteractiveContinuationMode()` reading `configService.get("execution").continuationMode`

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

### 6. Controller Assignment on Inject
Before writing the injected prompt to the PTY, call
`ptyProcessManager.setPendingController(workflowId, injectingClientId)`.
`PtyProcessManager` already persists the controller via `workflowRunControllers`; the
next `TERMINAL_CONTROLLER_CHANGED` broadcast (triggered by the existing flow or by a
small explicit `assignController()` call) propagates the change to all webview clients.

### 7. Investigate "terminal gone on switch-back" bug
**Prerequisite for inject mode to be usable.** Root cause not yet identified from code
inspection; requires live debugging during implementation.

Suspected path: `SWITCH_WORKFLOW` → `replayWorkflowStateTo()` sends `TERMINAL_STARTED`
→ TERMINAL_STARTED idempotency check returns early (sessionId already in store) → skips
`terminalRegistry.attach()` re-call → xterm DOM element is never reinserted into the
container for the newly active panel.

Investigation entry point: `terminalMessageHandlers.ts` TERMINAL_STARTED handler
(lines 90-111) and `TerminalInstance.tsx` `mount()` effect. Add debug logging around
`terminalRegistry.attach()` call to confirm whether it's being invoked and whether the
DOM insertion succeeds when switching back to a completed workflow.

### 8. `package.json`
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

### Workflow Status Dropdown — Terminal Presence Indicator
For each workflow listed in the status dropdown, show a small terminal icon when that
workflow has one or more running (non-exited) PTY sessions open. Overlay the count on
the icon when there are two or more sessions (e.g., one AI-CLI + one shell).

- Source the session counts from `PtyProcessManager.getSessionsForWorkflow(workflowId)`
  filtered to `status === TERMINAL_SESSION_STATUS.RUNNING`.
- The indicator is informational only — no click action required at this stage.
- Kept alive terminals from completed workflows will naturally appear here, letting the
  user know a TUI is still available for inject-mode follow-ups.

---

## Open Questions

1. ~~Does `PtyProcessManager` already expose a `write()` method for an active session?~~
   **Resolved:** `PtyProcessManager.writeToSession(sessionId, data)` already exists
   (line 341 of `PtyProcessManager.ts`). No new method needed.
2. Does the Claude TUI interpret a bare `\n` (newline) as prompt submission, or does
   it need `\r` or a specific key sequence? Verify against Claude Code's TUI input
   handling.
3. Multi-line prompts: if the prompt text contains newlines, Claude's TUI may interpret
   intermediate newlines as submissions. May need to use the `--input-format` flag or
   paste mode if Claude supports it, or escape newlines differently.
4. ~~Where exactly is the terminal teardown-on-navigation triggered?~~
   **Resolved:** There is no teardown-on-navigation. `closeTerminal()` and `dispose()` in
   the node-pty path only affect VS Code terminals, not PTY sessions. PTY sessions already
   outlive workflow completion and workflow switching — no code change needed.
