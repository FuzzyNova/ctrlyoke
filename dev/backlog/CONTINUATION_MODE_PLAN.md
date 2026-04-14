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

(The old PTY session from prompt N is not explicitly killed until the next prompt is sent, But the new session startup is still the bottleneck.)

In inject mode: Stop hook fires → write next prompt to PTY → Claude responds immediately.
No spawn, no startup, no session discovery wait.

---

## Setting

Settings live in the file-based config system (`~/.flightpath/settings.json` / `.flightpath/settings.json`). VS Code's `package.json` contributes.configuration is also required so the setting is discoverable via the VS Code settings UI and so `VSCODE_SETTINGS_KEY_MAP` in `WebviewSettingsSync.ts` can forward VS Code settings changes into the config file.

### 1. `src/types/FlightPathSettings.ts` — add to `execution` object

```typescript
execution: {
  mode: "interactive" | "headless";
  continuationMode: "restart" | "inject"; // ← new
  maxPromptTimeout: number;
  scriptTimeout: number;
  closeTerminalOnComplete: boolean;
}
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

| Call site                                                               | What it kills                                                                                                 | PTY killed?                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `WorkflowInstance.dispose()` (ext. deactivation)                        | `lastRunIntegrations.closeTerminal()` → `processManager.disposeTerminal()` → VS Code terminal only            | **No**                                |
| `WorkflowInstance.startWorkflowExecution()` finally                     | `execIntegration.dispose()` → `processManager.disposeProcess()` (if `closeTerminalWhenPromptCompletes=false`) | **No**                                |
| `WorkflowInstance.startWorkflowExecution()` pre-run cleanup             | `lastRunIntegrations.closeTerminal()` → VS Code terminal only                                                 | **No**                                |
| `WorkflowInstance.getIntegrationForPrompt()` harness switch (line 1827) | `closeTerminal()` → VS Code terminal only                                                                     | **No**                                |
| `CliTransportCoordinator.cancel()`                                      | `ptyManager.killSession()`                                                                                    | **Yes** — user abort only             |
| `PtyProcessManager.dispose()`                                           | All PTY sessions                                                                                              | **Yes** — extension deactivation      |
| `WebviewMessageRouter` KILL_TERMINAL                                    | Single PTY session by ID                                                                                      | **Yes** — user-initiated from webview |

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

#### The actual "terminal gone" bug — **FIXED**

**Root cause** (discovered via live log analysis): Both `loadWorkingFile()` (panel path)
and `loadWorkflowForClient()` (browser client path) only checked `this.instances` (live
instances) before creating a new `WorkflowInstance`. They never checked
`this.retiredInstances`. Since every completed workflow is immediately retired, switching
back to it always created a fresh instance with a new ID, orphaning the PTY sessions that
were keyed to the old instance ID. `replayWorkflowStateTo` for the new instance found 0
PTY sessions, so no `TERMINAL_STARTED` was sent — the terminal tab appeared blank.

**Secondary bug**: `retireWorkflow` disposed instances immediately when `isViewed=false`,
which happened whenever a new idle placeholder instance was created on re-run (before the
completion callback could check). PTY sessions were orphaned in `PtyProcessManager` with
no `WorkflowInstance` to hold the instance→PTY mapping.

**Fix** (in `WorkflowOrchestrator.ts`):

1. **`loadWorkflowForClient()` and `loadWorkingFile()`** — both now check
   `retiredInstances` by working file path before creating a new instance. If a retired
   instance for the same file already exists, it is reused (so PTY sessions keyed to that
   instance ID remain accessible).
2. **`retireWorkflow()`** — now checks `hasActivePty` in addition to `isViewed`. An
   instance is kept in `retiredInstances` (not disposed) if `isViewed || hasActivePty`.
   This ensures completed workflows with running TUI sessions are never silently discarded
   even when no client is currently viewing them at retire time.

**Result:** Switching away from a completed workflow and back correctly restores all
running terminals — identical behaviour to switching between idle and running workflows.

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

## Implementation — **DONE**

### 1. ~~Settings wiring~~ — **DONE**

- `src/types/FlightPathSettings.ts` — `continuationMode: "restart" | "inject"` added to `execution` type + default `"restart"`
- `schemas/settings-schema.json` — `continuationMode` enum added to `execution.properties`
- `src/utils/ConfigurationUtils.ts` — `getInteractiveContinuationMode()` added
- `src/ui/webview-react/components/settings/ExecutionSection.tsx` — continuation mode dropdown added under execution mode

> **Note:** `package.json` and `WebviewSettingsSync.ts` changes were not needed. The extension's settings UI talks directly to the file-based config service. `handleReadConfig`/`handleUpdateConfig` in `WebviewSettingsSync` strip the `flightpath.` prefix and resolve nested keys automatically — no manual mapping required.

### 2. ~~`CliIntegration.ts` — `runExecutionSession()`~~ — **DONE**

`shouldUseInjectMode(session)` guard added at the top of `runExecutionSession()`:
- Checks continuation mode setting, `promptIndex > 0`, and `hasInteractiveContext()`
- Calls `executionRunner.executeInteractiveInject(session)` when all three pass
- Falls through to restart mode if `injected: false` (PTY unavailable)

### 3. ~~`CliIntegration.ts` — inject path~~ — **DONE** (in `CliExecutionRunner`)

Implemented as `CliExecutionRunner.executeInteractiveInject()`:
- Writes `"\x1b[I" + session.promptArgument + "\r"` to the active PTY via `transportCoordinator.writeToCurrentPtySession()` — the focus-in VT sequence activates the TUI's input handler; `\r` submits
- After the write, yields one event loop tick (`setTimeout(resolve, 0)`) then checks `failureTracker.getPtyTermination()`. If the PTY died (e.g. Copilot CLI exits after each prompt), the inject falls back to restart mode. This is needed because `writeToCurrentPtySession` returns `true` even when the process just exited — `currentPtySession` is still set until node-pty's `onExit` callback fires asynchronously in the next event loop iteration.
- Calls `monitorLogFile()` with the stored log path and `startTime = new Date()` — `NotificationMonitorBase.monitorForCompletion()` uses `isFileNewerThan(stopFile, startTime)` so old stop files from prompt N are naturally filtered out
- Propagates session ID back to `session.setExtractedSessionId()`

> **Q2 resolved:** The submit sequence is `"\x1b[I" + promptText + "\r"`. Breakdown:
> - `\x1b[I` (ESC [ I) = focus-in VT sequence. Copilot CLI (and other TUIs using focus tracking) only activate their keyboard input handler after receiving this. Without it, text and Enter are silently ignored even though the PTY write succeeds. TUIs that don't use focus tracking (Claude CLI) safely ignore the sequence.
> - `\r` (CR, 0x0D) = the submit key. Confirmed by logging the exact bytes xterm.js sends when a user presses Enter (`hex=0d`). `\n` acts as a newline in multi-line input boxes; `\r\n` adds text but inserts a newline instead of submitting.

### 4. ~~`CliInteractiveStartupCoordinator.ts`~~ — **Not needed**

Inject mode bypasses the coordinator entirely — `startInteractiveProcess()` and `resolveSession()` are never called for injected prompts. `startTime = new Date()` passed to `monitorLogFile()` handles all filtering of prior-session log entries.

### 5. ~~Session ID Handling~~ — **Done**

Session ID reuse is automatic. `CliExecutionRunner.lastInteractiveContext` stores `{ logPath, sessionId }` after prompt N's `executeInTerminal()` completes. The stored `sessionId` is passed to `monitorLogFile()` for prompt N+1. `monitorForCompletion()` filters by `startTime` via `isFileNewerThan()`, so the old stop file is ignored.

### 6. Controller Assignment on Inject — **Deferred**

`ptyProcessManager.setPendingController()` not called for injected prompts — existing controller stays assigned. Implement if per-client inject triggering becomes a requirement.

### 7. ~~Investigate "terminal gone on switch-back" bug~~ — **DONE**

Root cause found and fixed. See the "Terminal Lifecycle" section above for the full
analysis. No further investigation needed — switching back to a completed workflow
with active PTY sessions now works correctly.

### 8. ~~`package.json`~~ — **Not needed**

The settings UI talks to the file-based config service directly. No `contributes.configuration` entry required.

### 9. ~~Inject on workflow resume~~ — **DONE**

Inject mode now works when **appending a prompt to a completed (retired) workflow whose TUI is still alive** — the common "append prompt → resume" flow.

**Problem:** When a workflow is resumed after completion, a new `CliIntegration` is created from scratch. Its `CliExecutionRunner.lastInteractiveContext` is `undefined`, and the first prompt has `promptIndex = 0`. The old `promptIndex === 0` guard was blocking inject entirely, but even without the guard, there was no saved context to inject into.

**Fix:**

- `PtySession` (`PtyProcessManager.ts`) — gained two new fields: `injectLogPath?: string` and `injectSessionId?: string | null`. These are written by `CliTransportCoordinator.updateCurrentPtyInjectContext()` after each prompt completes. They persist on the PTY object even after the `CliIntegration` that wrote them is discarded.

- `CliTransportCoordinator` — two new methods:
  - `updateCurrentPtyInjectContext(logPath, sessionId)` — saves inject context onto the current `PtySession`.
  - `adoptExistingPtySession(session, onExit)` — wires a new integration to an already-running PTY by setting `currentPtySession` and registering an additional `onExit` listener so the new integration's `failureTracker` is notified if that PTY exits.

- `CliExecutionRunner` — `updateCurrentPtyInjectContext?` added to `CliExecutionTransportCoordinator` interface; called in `executeInTerminal` and `executeInteractiveInject` whenever `lastInteractiveContext` is set or updated. `restoreInjectContext(logPath, sessionId)` public method re-hydrates `lastInteractiveContext` from saved PTY data.

- `CliIntegration` — `tryRestoreInjectContext(workflowId)` private method: looks up running PTY sessions for the workflow via `getPtyProcessManager().getSessionsForWorkflow(workflowId)`, finds any with `injectLogPath` set, calls `adoptExistingPtySession` + `restoreInjectContext` on the newest one. Called at the top of `runExecutionSession` when `isInteractive`. The `promptIndex === 0` guard in `shouldUseInjectMode` is removed — the `lastInteractiveContext` null-check is now the sole gate; if context was restored, inject proceeds.

**Implementation deviation from above plan — `liveInjectIntegrations` (actual):**

Rather than storing inject context on `PtySession` objects and reconstructing it in a new integration, the actual implementation keeps the entire `CliIntegration` alive across runs. The `WorkflowInstance` holds a `Map<string, HarnessIntegration>` (`liveInjectIntegrations`) keyed by the same harness ID used in `executionIntegrations` (e.g. `"copilot-cli"`). One entry per harness whose PTY session is still alive at end-of-run.

- **Multi-harness support**: A workflow with copilot-cli for prompt 1 and claude-cli for prompt 2 produces two entries. The next run's first prompt injects into whichever harness it targets — both live sessions are available.
- **Key correctness**: The map key is captured from `executionIntegrations.entries()` (the full Harness enum value), not from `getIntegrationMode()` which returns the provider short name (e.g. `"copilot"` ≠ `"copilot-cli"`). Using the wrong key caused a cache miss on restore — the fix captures the key at save time.
- **Restore**: At the top of `startWorkflowExecution`, all entries in `liveInjectIntegrations` are re-inserted into `executionIntegrations` (after `resetForNewRun()`) then cleared. `createIntegrationForMode` finds and returns the correct live instance; `shouldUseInjectMode` sees `lastInteractiveContext` and inject proceeds.
- **Cleanup**: Each entry registers an `onPtySessionEnded` callback that deletes it from the map and disposes it when the PTY exits. `WorkflowInstance.dispose()` iterates and disposes all remaining entries.

---

## Scope & Constraints

- **Interactive mode only.** Headless mode uses process exit for completion detection and
  has no TUI to inject into — inject mode has no effect there.
- **Claude CLI first.** Claude is the harness with the confirmed cache bug and the
  clearest benefit. Other hook-based harnesses (Codex, Qwen, Gemini, OpenCode) could
  support inject mode later if their TUI input semantics are compatible.
- **Copilot CLI:** The TUI stays alive between turns. Inject mode works once the focus-in
  VT sequence (`\x1b[I`) is prepended — without it the TUI's input handler ignores
  keyboard input even though the PTY write succeeds. Confirmed working after the fix.
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
