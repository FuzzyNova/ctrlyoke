# Steer Message Plan

## Overview

Today the only way to steer a live, interactive CLI harness session is to type
directly into the xterm TUI rendered by
`src/ui/webview-react/components/output/TerminalInstance.tsx`. Anything typed
into the prompt editor (`CodeMirrorEditor.tsx` inside `PromptEditor.tsx`) is
always queued: it waits for the current prompt to finish before it is sent,
even if a harness session is already sitting there idle mid-turn, ready to
take a follow-up.

This plan adds a **steer message**: a way to send the prompt editor's current
draft directly into an already-running interactive PTY session, immediately,
without adding a step to the queue. It reuses the follow-up detection already
built for background work (`dev/implemented/TERMINAL_FOLLOWUP_TRACKING_PLAN.md`)
to pick up the harness's response to the injected turn — no new completion
plumbing is needed on that side.

Steering is available only when:

- the active workflow has a live, running interactive AI-CLI session
  (`SESSION_KINDS.AI_CLI`, `TERMINAL_SESSION_STATUS.RUNNING`), and
- the editor is in **new-prompt mode**, step type **prompt** (not script).

All prompt overrides (harness, model, agent, skills, permissions, execution
mode) are ignored for a steer send — the message goes to whatever session is
already live. Changing any of those would require tearing down and
recreating the TUI, which defeats the purpose of steering into a session
that's already running.

---

## UX Decision

Considered three shapes for exposing this in the editor:

1. **Split button on Send** (chosen) — `EditorFooter`'s existing
   `btn-editor-run` becomes a split button: the primary action stays "Run",
   and a dropdown arrow reveals "Send Steer Message". Disabled/hidden when no
   live interactive session exists for the active workflow, with a tooltip
   explaining why. When enabled, its tooltip explains that all overrides are
   ignored and the text is sent directly to the live session.
2. A third `Prompt / Script / Steer` entry in `EditorSection`'s step-type
   switcher, swapping the footer to a bare "Send Steer" button with the
   overrides UI hidden.
3. A permanently visible third button next to Queue/Run.

**Rejected (2)**: `stepType` (`STEP_TYPES.PROMPT` / `STEP_TYPES.SCRIPT`) is a
field that gets persisted onto a queued step
(`src/types/DashboardConstants.ts` `STEP_TYPES`, threaded through
`editorStore.ts`'s `stepType`/`setStepType`). A steer message is never
queued, so it has no step to carry that field — forcing it into the same
switcher conflates "what kind of step am I authoring" with "fire this at the
live session right now," and raises awkward questions (what does Update/
Delete mean in Steer mode? what happens to the switcher when a queued prompt
is being edited?).

**Rejected (3)**: a permanent third button competes for footer space in an
already narrow bar (see `EditorFooter.tsx`'s `isMediumWidth`/`isSmallWidth`
collapsing) for an action that's usually unavailable (no live session), and
suggests steering is a peer of Run/Queue rather than a special-case override
of Run's normal dispatch.

**Chosen (1)** keeps the editor's job the same (compose text) and only adds
an alternate dispatch action for the same draft, which matches the actual
mechanics: same text, different destination.

### Scope and behavior

- Steer is available **only in new-prompt mode** (`selectionTarget.kind ===
EDITOR_TARGET_KINDS.NEW_PROMPT`), never while editing an existing queued
  step. Steering is an out-of-band action unrelated to the queue; mixing it
  with Update/Delete semantics on an existing step is confusing.
- Steer is available **only in prompt mode** (`stepType === STEP_TYPES.PROMPT`),
  not script mode — scripts don't talk to a harness session.
- On send, the editor draft is **cleared**, same as a normal Run — consistent
  with the existing new-prompt-mode behavior and avoids accidental resends of
  stale text.
- The properties drawer, quick pickers (`HarnessQuickPicker`,
  `ModelQuickPicker`, `AgentQuickPicker`, `SkillsQuickPicker`,
  `PermissionsQuickPicker`, `ContextQuickPicker`) stay visible and usable as
  normal — they still apply to a subsequent Run/Queue of the same draft
  before it's sent. They simply have no effect on a steer send; the tooltip
  on the steer menu item is the only place this is called out.
- No confirmation modal — steering should feel as immediate as typing into
  the TUI directly.
- Proactively add the sent steer text to the run's response/history feed, the
  way the user's TUI keystrokes are effectively already visible in the
  terminal — so users have a persistent, non-ephemeral record without having
  to scroll xterm scrollback. (Not required for the mechanism to work — the
  provider parsers already classify these via `TERMINAL_FOLLOWUP_TRACKING_PLAN.md`'s
  "user-steer" event handling — but doing it improves discoverability of what
  was actually sent, since prompt-reference expansion may differ from what
  the user typed.)

---

## Availability Gate

The steer control's enabled/disabled state is driven by:

```
terminalStore.activeSessionIds[activeWorkflowId] → sessionId
terminalStore.sessions[activeWorkflowId].find(s => s.id === sessionId)
  → session.kind === SESSION_KINDS.AI_CLI
  && session.status === TERMINAL_SESSION_STATUS.RUNNING
```

This is the session currently shown in the terminal rail for the active
workflow — i.e. "whatever interactive session the user is already looking
at," not an independent picker. If a workflow ever has more than one
concurrent AI-CLI session (parallel steps — see
`dev/implemented/PARALLEL_STEPS_PLAN.md`), steering always targets the
rail-active one; a session picker is out of scope for this plan (see Not In
Scope).

A new hook, `useActiveInteractiveSession(workflowId)` (mirroring the shape of
the existing `useActiveWorkflowExternalOwner` hook referenced in
`EditorSection.tsx`), should encapsulate this lookup so `EditorFooter`/
`EditorSection` don't reach into `terminalStore` directly. It returns the
live session (or `undefined`), letting the UI derive both "is steer
available" and, for the tooltip's disabled reason, a human string ("No live
harness session for this workflow" vs. "Process exited").

---

## Dispatch Path (extension host)

### Reuse, don't reinvent, prompt-reference resolution

A steer message still needs `@file`, `#sym:`, `~change`, `$step:N` and slash
tokens resolved the same way a normal queued prompt does — those are part of
what the user typed, not part of the ignored overrides. The existing
pipeline for this lives in `CliPromptPreparer` (`buildPromptSections`) and
`CliIntegration.formatCategorizedReferences` /
`CliIntegration.formatCategorizedInstruction` — see the excerpted format in
`CliIntegration.ts:488-529`:

```
Following these agent instructions @agent.1.md[, @agent.2.md],
using these secrets @secrets.md,
using these available skills @skills.md,
using these file references @src/foo.ts, @src/bar.ts,
with this prior conversation context @context.md,
and these attachment excerpts @excerpts.1.md[, @excerpts.2.md],
follow the instructions in @prompt.md
```

For a steer send, call `buildPromptSections`/`formatCategorizedReferences`
with **no resolved agent, no resolved skills, and no resolved
harness/model/permission properties** — only the direct workspace file refs
and prompt-text categories the user actually typed inline get formatted. The
categorized-instruction sentence degrades gracefully when a category is
empty (already documented in the JSDoc: "absent categories omitted"), so
this should fall out of the existing formatter without new branching, though
this needs verification once implementation starts — flagged as a risk
below.

### New message type

Add to `MESSAGE_TYPES` in `src/types/DashboardConstants.ts`, alongside the
other Terminal I/O entries:

```ts
// Steer messages — webview → extension: inject a categorized prompt directly
// into an already-running interactive PTY session. Never queued; ignores all
// prompt overrides (harness/model/agent/skills/permissions).
SEND_STEER_MESSAGE: "sendSteerMessage", // { workflowId, sessionId, text }
```

`text` is the raw prompt-editor draft (pre-reference-expansion); expansion
happens on the extension host, same as `EXECUTE_PROMPT`.

### Extension-host handler

Route this in `WebviewMessageRouter.ts` next to the other
`registerTerminal()` entries, but dispatch to a new handler (not
`terminalHandlers.handleInput`, which is raw keystroke routing for
`TERMINAL_INPUT` and does not go through prompt-reference resolution at
all). The handler needs to:

1. Resolve the target `WorkflowInstance` / execution integration for
   `workflowId` — specifically the live `CliIntegration` whose PTY session
   ID matches `sessionId` (guard: if the session no longer matches a live
   PTY, no-op with a user-facing notification — the session may have ended
   between the button becoming enabled and the click landing).
2. Run the reduced prompt-preparation path described above to produce the
   final categorized text.
3. Write that text directly to the PTY via whatever write path
   `CliTransportCoordinator`/`PtyProcessManager` already uses for interactive
   turn dispatch (`PtyProcessManager.ts` — `session.pty.write(data)`, see the
   existing interrupt-signal calls at `PtyProcessManager.ts:595,653-654,749-750`
   for the write surface shape) followed by the harness's turn-submit
   sequence (Enter/newline) — this must match whatever the normal interactive
   dispatch path already does today for submitting a queued prompt into an
   open TUI, so it should reuse that code rather than duplicate it.
4. Optionally emit a history/response-feed entry recording the steer text was
   sent (see UX section above) — check whether `SessionActivityWatcher` /
   the provider's "user-steer" classification already produces a receipt
   event on its own that the dashboard can surface, before adding a second,
   redundant one from the dispatch side.

### `canReuseForInject` is unrelated

`HarnessIntegration.canReuseForInject()` / `CliIntegration.canReuseForInject()`
(`HarnessIntegration.ts:302-312`, `CliIntegration.ts:1682-1698`) governs
whether an integration is kept alive **across separate workflow runs** so
the _next_ run can resume the same PTY via inject mode. Steering targets a
session that is already alive **within the current run** — it does not go
through `canReuseForInject`, `WorkflowInstance.executeLoadedPromptFile`, or
the queue/execution-state machine at all. This is worth stating explicitly
in the implementation so nobody tries to route steer dispatch through the
inject-mode continuation path by analogy — they're unrelated mechanisms that
happen to share the word "inject."

---

## Type/Message Changes

- `src/types/DashboardConstants.ts`: add `SEND_STEER_MESSAGE` to
  `MESSAGE_TYPES` (see above).
- `src/ui/WebviewMessageRouter.ts`: register the new handler.
- New handler file/class (naming TBD at implementation time — could live in
  `terminalHandlers.ts` if it's kept thin and just delegates to
  `WorkflowInstance`/`CliIntegration`, or in a new
  `SteerMessageHandler.ts` if the prompt-preparation reuse needs its own
  seam).
- `src/ui/webview-react/hooks/`: new `useActiveInteractiveSession.ts`.
- `src/ui/webview-react/components/editor/EditorFooter.tsx`: split-button
  variant of `btn-editor-run` in the new-prompt-mode branch.
- `src/ui/webview-react/components/editor/PromptEditor.tsx`: new
  `sendSteerMessage` callback alongside `executePrompt`, gated the same way
  Run/Queue's disabled states are today.

No changes to `schemas/workflow-schema.json` or `CtrlYokeTypes.ts` — steer
messages are never persisted into a workflow file.

---

## Edge Cases

- **Session ends between enabling the button and the click landing.** The
  handler must re-check liveness server-side (not just trust the webview's
  gate) and no-op with a clear notification rather than silently dropping
  the message or throwing.
- **User is a viewer, not controller, of the terminal
  (`session.isController === false`).** Steering happens on the extension
  host directly against the PTY, independent of the webview's
  controller/viewer keystroke-routing distinction (`TerminalInstance.tsx`'s
  `onData` gating) — so it should work the same for a viewer as a
  controller. Confirm this is the desired behavior (a non-controlling
  client can still steer) since it's a step up in privilege from what that
  client can currently do (view-only, no `TERMINAL_INPUT`).
- **Multiple concurrent PTYs for one workflow.** Steer always targets
  `activeSessionIds[workflowId]`, the rail-active one — switching rail tabs
  before sending changes the target. No cross-session picker in this plan.
- **Draft contains unresolved/invalid `@`/`#` references.** Same validation
  path as normal prompt submission should apply — don't special-case steer
  to skip the existing `createContextReferenceLintExtension` validation.
- **Harness has no notion of a mid-turn interjection** (e.g. some CLIs may
  only accept input between turns, not during active generation). Verify per
  provider — `TERMINAL_FOLLOWUP_TRACKING_PLAN.md` already documents provider
  gaps (Codex/Qwen/OpenCode have no provider-specific follow-up signal), so
  the "user-steer" pickup may be weaker on those; the send itself should
  still work since it's just a PTY write, but response-feed reconciliation
  may be incomplete on those three.

---

## Not In Scope (YAGNI)

- A session picker for workflows with multiple concurrent interactive
  sessions — always targets the rail-active session.
- Any change to queued-step execution, `WorkflowExecutor`, or the state
  machine — steering never touches the queue.
- Persisting steer messages into workflow files, run manifests, or
  `events.jsonl` as a first-class record type — reuse whatever the follow-up
  tracking plan's "user-steer" classification already captures; only add a
  dashboard-visible receipt if that data isn't already surfaced.
- Steering into a **headless** (non-interactive) execution — there is no
  PTY to write into.
- Keyboard shortcut for steer send (e.g. a `Ctrl+Shift+Enter`-style bind) —
  can be added later once the split-button UX ships and usage patterns are
  clear.

---

## Open Questions

1. Does `formatCategorizedReferences` actually degrade cleanly with agent/
   skill/context/excerpt categories all empty, or does some caller-side
   assumption (e.g. a required prompt-file category) need adjusting? Needs a
   direct test once implementation starts.
2. Should a non-controller (viewer) client be allowed to steer, given
   steering bypasses the controller/viewer keystroke gate entirely? Leaning
   yes (it's a host-side action, not a webview keystroke), but worth a
   deliberate decision rather than an accident of implementation.
3. Where exactly does "submit the turn" (Enter/newline after the write) live
   today for interactive dispatch, so it can be reused rather than
   reimplemented? Needs a read of `CliTransportCoordinator`'s interactive
   write path before implementation.
4. Should the "Send Steer Message" menu item show which harness it's
   targeting (in case the user forgot which session is rail-active)? Given
   it's gated on the rail-active session already visible on screen, probably
   unnecessary, but worth a quick UX pass.
