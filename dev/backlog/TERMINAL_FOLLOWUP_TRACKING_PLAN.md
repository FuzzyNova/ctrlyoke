# Terminal Follow-up / Session-Resume Tracking Plan

## Why this is now a priority

Every interactive harness ctrlyoke drives (Claude, Copilot, Codex, Qwen, Antigravity,
OpenCode) has converged on the same behavior: **"I'll run this task in the background and
wait for it to finish"** as the first move of a long workflow. The harness kicks off the
background task, ends its top-level turn, and **fires the Stop hook**. ctrlyoke treats that
Stop as the end of the prompt, marks the step completed, tears down the per-prompt monitor,
and stops tailing the log. When the background task finishes, the harness **auto-resumes the
same live session** and produces more output — tool calls, reasoning, a real final answer —
and ctrlyoke captures **none of it**: no output-window streaming, no history entry, no token
stats.

ctrlyoke's entire value proposition is being the standard capture-and-organize layer over AI
harnesses (search, undo/redo, full-fidelity history browsing). That promise breaks the moment
backgrounding becomes routine, which it now has. **Fixing session-resume tracking is the
priority feature.** Capturing genuine _user_ typed input in the TUI is a real but **secondary**
benefit and comes later.

### Primary scenario to fix

> The AI backgrounds a task, ends its turn (Stop hook fires), ctrlyoke marks the step
> completed, then the AI auto-resumes the same session when the background task completes.
> **Assume the AI is still working on the step we prematurely marked complete.**

### Secondary scenario — user steers in the TUI (now in scope as capture-only)

- User types directly into the still-open TUI (either mid-step or after a workflow finishes).
  This is captured and displayed as a **"user steer" event** in the ctrlyoke output/history.
  It is **display-only and never modifies workflow state** — no new queue step, no revert.
  Promoting a steer into an _editable queue step_ with undo/redo remains deferred; capture +
  display is in scope. See "User steer events" below.

---

## Decisions locked in

These were worked through and are settled; the rest of the plan builds on them.

1. **Two layers, not one.**
   - **Layer 1 — universal output capture (Tier 1):** every harness gets a post-completion
     session watcher that keeps tailing the live session log and captures any resumed output
     into the step's output window + history. **Stop detection is unchanged.** This is the
     safety net — output is never lost, regardless of what the signal investigation finds.
   - **Layer 2 — deterministic signal-gated completion (per-harness):** for harnesses where
     the session log carries a clear "a background task is still pending" marker, use it to
     **hold completion** — don't fire completion at a Stop when we can see the agent will
     auto-resume. Where no usable signal exists for a harness, it stays Layer-1-only.

2. **No reverting a completed workflow.** We do **not** un-finalize a workflow back to running.
   The correct fix is _better idle detection_ — don't optimistically commit in the first place
   when a resume is coming. The deterministic signal is what makes this possible without a
   revert. (Layer 1 may still flicker a step's status while capturing on harnesses that have
   no signal; that's cosmetic and does not touch workflow control flow.)

3. **The idle signal gates _everything_ downstream of a step**, not just end conditions:
   end-condition evaluation, next-step dispatch/inject, and workflow finalization all wait for
   confirmed idle. All three assume "Stop == work done"; the signal is what makes that
   assumption true.

4. **Human input in the TUI is captured as a display-only "user steer" event, never a step.**
   A genuine user prompt typed into the live TUI — mid-step or after completion — is surfaced
   in the ctrlyoke output/history as a "user steer" event and never changes workflow state (no
   new queue step, no revert). This closes a current gap where `user` events in the session log
   are ignored, so mid-step steering was invisible. See "User steer events" below.

5. **No blind waits, no fixed settle delay.** We do not guess idle or add latency when there's
   nothing pending. The default path (no pending background task) commits **immediately**, exactly
   like today. We only hold when the log gives positive evidence of a pending task — and a
   **bounded backstop** caps the hold so a never-completing background task (e.g. a dev server)
   or an abandoned task can't deadlock the workflow.

### Why gate-on-idle instead of settle-window or revert

The only true signal that the AI is "done" is that it _stays_ idle — you can't tell "done"
from "waiting on a background task" from the Stop hook alone (same hook, same live PTY). A
fixed settle window trades latency against correctness on _every_ completion and still misses
long background tasks. Reverting a finalized workflow is the messiest possible code path
(completion notifications already fired, history finalized, a next prompt possibly already
injected). A **deterministic per-harness "is a task pending?" read** dominates both: zero
latency when nothing is pending, a precise hold when something is, and no revert.

---

## Root cause, in code

1. **Stop hook is authoritative and terminal.** In `CliLogMonitor.monitor()`
   (`src/core/harness/CliLogMonitor.ts`), when a `notificationMonitor` exists (all CLI
   harnesses) log-based `parser.isComplete()` is deliberately ignored — completion comes only
   from the Stop hook via `NotificationMonitorBase.monitorForCompletion()` →
   `handleCompletion("Stop hook")`. The code comment there even anticipates the
   "waiting for a background agent" case but assumes the Stop hook _won't_ fire then.
   **It now does fire.**

2. **`handleCompletion` is one-shot and tears everything down** — closes the `fs.watch`
   watcher, clears timers, fires `onResponseComplete`, resolves the monitor promise
   (`CliLogMonitor.ts` ~lines 201–322). Nothing watches the log afterward.

3. **The session is still alive and the re-attach seed survives.** In interactive inject mode
   the PTY is kept alive between prompts and `CliExecutionRunner.lastInteractiveContext`
   retains `{ logPath, sessionId, spawnedWith, spawnedWithSessionId }`
   (`src/core/harness/shared/CliExecutionRunner.ts` ~line 597). Across runs the whole
   integration is parked in `WorkflowInstance.liveInjectIntegrations` when `canReuseForInject()`
   is true. The harness keeps appending to the same session log — we simply stop reading past
   the Stop offset.

Completion propagates `onResponseComplete` → `HarnessIntegration.responseCompleteEmitter` →
`WorkflowExecutor.waitForResponseComplete()` (~line 1688), which resolves and runs end
conditions + advances in the same breath. Layer 2 has to split that: resolve
streaming/UI-completion on the Stop, but gate the end-condition/advance/finalize on the
idle signal.

---

## Harness signal investigation

The signal is **per-harness and empirical.** Method: take a contrastive pair per harness — a
session that hit the background-wait bug vs. a clean completion — and diff the log around the
Stop boundary to find a structural (not text-based) "task still pending" marker. For each
harness, confirm three things:

1. **A pending-task marker exists** in the log and is present/flushed by the time the Stop
   hook fires.
2. **The harness auto-resumes** the same session on its own when the task completes (vs.
   sitting idle waiting for a human poke — if it needs a poke, it can't be gated and stays
   Layer-1-only).
3. **A completion/resume marker** correlates back to the launch, so a hold ends promptly on
   the real event rather than on a timer.

### Claude Code — CONFIRMED ✅

Investigated `~/.claude/projects/c--dev-ctrlyoke/c612a5c6-…jsonl` (a session that backgrounded
coverage runs and waited) against a clean session (`5be6f6f5-…jsonl`). Findings:

- **Every `end_turn` fires the Stop hook**, including the "I'll wait for the background run"
  pauses (each produces a `system` event `subtype: "stop_hook_summary"`). So the Stop hook
  alone cannot distinguish a pause from a real end — confirming the root cause directly.
- **Launch marker:** assistant `tool_use`, `name: "Bash"`, `input.run_in_background === true`.
  Its `tool_use` `id` (e.g. `toolu_…L21fwach`) is the correlation key. (Note: the immediate
  `tool_result` after a background launch is only the launch _ack_ — it is **not** completion.)
- **Completion / resume marker:** a `user` message whose content contains
  `<task-notification>…<tool-use-id>toolu_…</tool-use-id>…`. This injected message is what
  **wakes Claude and drives the auto-resume** (answering point 2 — Claude self-resumes). It
  also carries an `<output-file>` for the task's captured output.
- **The rule that separated all 8 stops correctly in real data:**
  **at a Stop, is the _most-recent_ background launch still un-notified?** If yes → the agent
  will auto-resume → hold. If no → commit now.
  - The 5 "waiting" stops (L75, L307/308, L337, L452, L700) each had the most-recent launch
    un-notified; each was followed by a `<task-notification>` and a resume.
  - The 3 real final stops (L461, L573, L723) each had their most-recent launch already
    notified → commit.
  - Two early "zombie" launches (`3FgYNP7o`, `w8Ft3zd8`) were superseded and **never
    notified**. A naive "any outstanding background task" rule would treat the real final
    stops as pending and **deadlock**. The **most-recent-launch** rule is immune: a newer
    launch always displaces a zombie, and the newest launch always notifies before the true
    final summary.
  - Structural > textual: L307 had empty assistant text yet was a genuine wait; parsing the
    "I'll wait…" sentence would have missed it. Use the launch/notification structure, not the
    prose.
- **Backstop still required:** a background process that never completes (dev server) or a
  genuinely abandoned task leaves "most-recent un-notified" true forever. Cap the hold with a
  generous bound; because we only hold on positive evidence, the backstop rarely fires.

Implementation shape for Claude: `ClaudeLogParser` tracks the most-recent background `Bash`
launch id and clears it when a matching `<task-notification>` arrives, exposing something like
`hasPendingBackgroundWork(): boolean` on the parser. `<task-notification>` is a `user` event —
make sure it is **not** misclassified as a human follow-up prompt by the Layer-1 watcher's
`isHumanPrompt` filter.

### Copilot CLI — CONFIRMED ✅

Investigated `~/.copilot/session-state/4402ccc7-…/events.jsonl` (backgrounded a 60s async
PowerShell job and waited) against a clean session (`fa0319d7-…`). Copilot's markers are
**fully structured — no text parsing needed**, cleaner than Claude's:

- **Every `assistant.turn_end` fires the Stop hook** (`hook.start`/`hook.end` follow it),
  including the "Ending turn — will resume when the job completes" pause. Same root cause.
- **Launch marker:** `tool.execution_complete` whose `data.toolTelemetry.properties.executionMode
  === "async"`, with the shell id in `data.result.content`
  (`"<command started in background with shellId: 0>"`). The launching tool args also carry
  `mode: "async"` (e.g. `powershell`/`bash` tools). Correlation key = **shellId** (small, stable).
- **Completion / resume marker:** a first-class `system.notification` event with
  `data.kind.type === "shell_completed"` (or `"shell_failed"`), `data.kind.shellId`,
  `data.kind.exitCode`. This wakes Copilot, which **self-resumes** (a `turn_start` fires
  immediately after) — so it is gate-able. No regex needed; key off `kind.type`/`kind.shellId`.
- **Rule that separated all stops in real data: at a Stop, is any async shell still without a
  matching `shell_completed`/`shell_failed`?** The waiting stop (L24) showed pending shellId
  `0`; the resumed work and real final showed none; the clean log had zero `system.notification`
  and every stop pending-free (commits immediately, today's behavior).
- **No zombie problem (unlike Claude):** a terminating command _always_ emits
  `shell_completed`/`shell_failed`, so "any pending shellId" is safe here. Only a
  never-terminating shell (dev server) stays pending → that is exactly the backstop case.

So the _detection rule is legitimately per-harness_ even though both fit the same
`hasPendingBackgroundWork()` parser abstraction: Claude = "most-recent launch un-notified"
(dodges superseded-never-notify tasks); Copilot = "any async shellId without a completion
notification" (structured completion is guaranteed for terminating commands).

Verify markers against a fresh log when Copilot bumps CLI versions (see the 1.0.x
event-drop caveats in `harness-cli-providers.instructions.md`).

### Codex / Qwen / Antigravity / OpenCode — TODO

Investigate on demand as each is observed to background-and-wait. Any harness without a clean
marker stays Layer-1-only (capture, no gating).

---

## Layer 1 — Session Activity Watcher (universal)

Do **not** stretch the per-prompt `CliLogMonitor` past its Stop — it is intentionally terminal.
Add a distinct, longer-lived **`SessionActivityWatcher`**.

- **Owner:** `CliIntegration` (owns `lastInteractiveContext`, PTY liveness, and is the object
  parked in `liveInjectIntegrations`).
- **Start:** after a prompt's interactive execution resolves with the PTY still alive. Seed
  from the finished monitor / `lastInteractiveContext`: `logPath`, `sessionId`, harness id,
  workflow identity (`instanceId`, `workingFilePath`, `promptIndex`), and the **byte/line
  offset the completion drained to** (extend `CliLogMonitor` to return its final offset).
- **One reader at a time:** suspend the watcher while any `sendPrompt`/`CliLogMonitor` is
  active on the same log (the next dispatched prompt is the authoritative reader); resume it on
  completion if the PTY is still alive. This cleanly handles the mid-workflow case.
- **Stop when:** the PTY exits (`onPtySessionEnded`/`getPtyTermination`), the integration is
  disposed/reclaimed, or the terminal is closed.
- **What it does:** tail from the seeded offset with the harness `ILogParser`; classify new
  content (resumed AI activity vs. a real human prompt via `isHumanPrompt`, suppressing
  ctrlyoke's own injected prompts); stream resumed events through the existing
  `onStreamingEvents` / `onContextWindowUpdate` callbacks; append to the step's output +
  history record (append, don't replace, so pre-Stop and post-resume content coexist), visually
  marked as "session resumed / auto-continued."

Reuse the event-processing core of `CliLogMonitor` (offset-filtered read → push →
`extractStructuredEventsFromEvent` → stream → context-window update → `isComplete`) rather than
duplicating it (DRY).

### User steer events (display-only, both contexts)

A genuine human `user` message in the session log becomes a **"user steer" event** — a new
output/history event type that is rendered in the ctrlyoke output and **never changes workflow
state** (no queue step, no revert, no status change beyond display). This lives in the shared
tail/stream core (Phase 1), so it fires in **both** contexts with one implementation:

- **Mid-step steering:** the active `CliLogMonitor` sees the user's `user` event while a prompt
  runs. Today these are ignored (the monitor only surfaces the assistant response) — this closes
  that gap so mid-step steering is visible.
- **Post-completion follow-up:** the `SessionActivityWatcher` sees it after the step/workflow
  finished, renders the steer, and captures the assistant output that follows — no revert.

A `user` event in the log is one of four things; only the last is a steer:

1. **tool result / tool-only content** → ignore (not a prompt).
2. **a ctrlyoke-injected prompt** → attribute to dispatch, not a steer. Requires the pending-inject
   correlation marker, or we would mislabel our own injected prompts as user steers.
3. **a harness resume signal that is itself a `user` event** → Claude's `<task-notification>` is a
   `user` message and must render as a resume signal, not a steer. (Copilot's completion is a
   `system.notification`, so it is naturally exempt.)
4. **genuine human text** (via the existing `isHumanPrompt` non-empty-text-block filter) →
   **"user steer" event.**

---

## Layer 2 — Signal-gated completion (per-harness, where a signal exists)

Split `WorkflowExecutor.waitForResponseComplete` into two concerns:

- **UI/streaming completion** fires on the raw Stop (optimistic; step shows output as done).
- **Control-flow commitment** (end condition → advance / retry / stop / finalize) waits for
  **confirmed idle**, defined by the harness signal: at a Stop, ask the parser
  `hasPendingBackgroundWork()`.
  - **Not pending → commit immediately** (today's behavior, zero latency).
  - **Pending → hold:** keep the step running, keep the watcher capturing, and wait for the
    harness resume marker (Claude: `<task-notification>`) → resumed work → next Stop →
    re-check. End the hold on that real event, or on the bounded backstop, whichever first.

Because control flow only commits from a genuinely idle session, the retry cases stop being
racy: `resumeSessionOnRetry: true` injects into an idle live session (no interleaving);
`resumeSessionOnRetry: false` kills + respawns a settled session (no in-flight work abandoned).
**This is why the "1 TerminalInstance per session" change is _not_ needed** and is explicitly
rejected here — it would trade a solvable timing problem for an unsolvable
two-sessions-editing-the-same-tree consistency problem
(`src/ui/webview-react/components/output/TerminalInstance.tsx` + the harness-keyed
`liveInjectIntegrations`/`executionIntegrations` maps). Concurrent same-harness sessions are a
separate future feature that would need worktree isolation, not a retry side effect.

---

## Edge cases & races

- **Mid-workflow next-step dispatch:** the one-reader rule keeps the watcher parked while step
  N+1's `CliLogMonitor` owns the log. With Layer 2, next-step dispatch itself waits for idle,
  so N+1 isn't injected into an about-to-resume session.
- **Offset correctness across `--resume`:** the session log grows monotonically; the watcher
  must persist and hand off its byte/line offset, not just the session id, so the watcher and
  the next prompt monitor never double-count or skip.
- **Inject correlation:** an injected ctrlyoke prompt appears as a `user` event; keep a
  short-lived pending-inject marker so the matching `user` event is attributed to dispatch, not
  a manual follow-up. Distinct from Claude's `<task-notification>` `user` events, which are
  resume signals, not prompts.
- **Double completion:** guard re-completion with a `completed`-style flag as
  `CliLogMonitor.handleCompletion` already does.
- **PTY dies during a resumed turn / a hold:** treat like the existing `isPtyTerminated` path —
  flush buffered events, persist partial output, stop the watcher, release any hold.
- **Backstop expiry:** if a hold hits the bound with no resume, commit and log it; Layer 1 has
  still captured anything that did arrive.

---

## Implementation phases

**Phase 0 — signal investigation.** Claude ✅ and Copilot ✅ confirmed (above). Codex / Qwen /
Antigravity / OpenCode on demand. Each harness that lacks a clean marker stays Layer-1-only.

**Phase 1 — shared tail/stream loop.** Extract the event-processing core of `CliLogMonitor`
into a unit shared by `CliLogMonitor` and `SessionActivityWatcher`. Add **user-steer event
emission** here (classify human `user` events per the four-way rule) so mid-step steering and
post-completion follow-ups are both captured from one place.

**Phase 2 — `SessionActivityWatcher` + capture (Layer 1, universal).** Implement the watcher,
own it in `CliIntegration`, seed from `lastInteractiveContext` + final offset, enforce the
one-reader rule. Add an `onSessionActivityResumed` emitter and wire resumed streaming/append +
status + user-steer events into `WorkflowInstance`/dashboard. Ships the "output is never lost"
and "user steer is captured" guarantees.

**Phase 3 — signal-gated completion (Layer 2, Claude first).** Add `hasPendingBackgroundWork()`
to `ILogParser`/`ClaudeLogParser`. Split UI-completion from control-flow commitment in
`WorkflowExecutor`; gate end-condition/dispatch/finalize on the signal with the bounded
backstop. Extend to Copilot and others as their signals are confirmed.

**Phase 4 — presentation polish & optional gating setting.**

**Phase 5 (later) — promote user steers / observed turns into editable queue steps, undo/redo,
executor first-class observed steps.** (Capture + display of user steers ships in Phase 1–2;
only step-promotion is deferred here.)

---

## Relationship to Continuation Mode

Complementary. AI backgrounds a task and auto-resumes → session watcher (+ Layer 2 hold).
User types in the terminal → session watcher (secondary). ctrlyoke sends the next prompt via
inject → normal dispatched prompt.

---

## Open questions

1. Backstop bound for the Layer-2 hold: fixed generous duration, or "pending AND no log
   activity for N seconds"? (Leaning: the latter — a live-but-slow task keeps the hold, a truly
   dead one releases it.)
2. Layer-1 mid-workflow attribution: folding resumed step-N output into step N+1's monitor —
   acceptable long-term, or must the watcher own the log even with a next prompt queued?
3. Always-on for live interactive sessions, or gated by a setting?
4. Remaining harness signals (Codex / Qwen / Antigravity / OpenCode) — investigate on demand;
   any without a clean marker stay Layer-1-only. (Claude ✅ and Copilot ✅ confirmed.)
