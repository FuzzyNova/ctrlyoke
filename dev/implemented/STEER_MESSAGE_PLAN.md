# Steer Message Plan

> **Status:** Stage 4 shipped; the steer dispatch is live. Accepted v1
> limitations are the mid-turn attribution race and the temp-file-reference
> form of the `USER_STEER` receipt for multi-line drafts. Named follow-ups are
> rendering the referenced temp file's body in the `USER_STEER` row and an MCP
> `steer_session` equivalent. Every open question this plan previously carried
> is answered below; nothing here is blocking.
>
> **Depends on:** [`RUN_DISPATCH_MENU_PLAN.md`](../implemented/RUN_DISPATCH_MENU_PLAN.md)
> (implemented) — its Stage 6 is this plan. The split-button shell, the
> disabled-vs-hidden policy, `useRunDispatchTargets`, and the
> `EXECUTE_PROMPT_ERROR` draft-restore contract all shipped with it, so this
> plan no longer owns any of them.
>
> **Also settles:** the Phase 7 spec correction in
> [`PARALLEL_MUTATION_ROLLOUT_PLAN.md`](../implemented/PARALLEL_MUTATION_ROLLOUT_PLAN.md),
> which recorded that `useRunDispatchTargets` could not compose
> `useActiveInteractiveSession` because this plan was unbuilt, and that "the
> steer plan adds its own key when it lands." This plan adds that key.

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
without adding a step to the queue. It fills in the fourth and last item of
the shipped dispatch menu.

Steering is available only when:

- the active workflow has a live interactive AI-CLI session
  (`SESSION_KINDS.AI_CLI`, `TERMINAL_SESSION_STATUS.RUNNING`), and
- the editor is in **new-prompt mode**, step type **prompt** (not script).

All prompt overrides (harness, model, agent, skills, permissions, execution
mode) are ignored for a steer send — the message goes to whatever session is
already live. Changing any of those would require tearing down and recreating
the TUI, which defeats the purpose of steering into a session that's already
running.

---

## What already shipped

The dispatch menu landed on 2026-09-14. `EditorFooter.tsx:296-360` renders a
`SplitButton` whose drop-up already contains the steer entry as a **disabled
placeholder**:

```tsx
{
  label: "Send Steer Message",
  value: "sendSteerMessage",
  onClick: () => undefined,
  disabled: true,
  title: "No live harness session for this workflow",
  icon: <Icon name="comment" />,
}
```

So the UX work in this plan is: give that item a real gate, a real tooltip, and
a real `onClick`. The label, position (first, above the divider), icon, and
disabled-with-tooltip policy are settled and must not change.

Three shipped facts shape everything below:

1. **`useRunDispatchTargets` (`hooks/useRunDispatchTargets.ts`) is the single
   place dispatch availability is decided.** It returns
   `{ parallel, newWorkflow }` today, each a
   `RunDispatchTarget { enabled, disabledReason?, title }`. `EditorFooter` is a
   presentation component and reaches into no store for gating. Steer adds a
   third key to that object; it does not get its own parallel policy path.
2. **Rejection, draft restore, and toast are already generic.**
   `WorkflowStepHandlers.handleExecutePrompt` (`src/ui/WorkflowStepHandlers.ts:38-82`)
   catches, emits `MESSAGE_TYPES.EXECUTE_PROMPT_ERROR { text }` (which
   `PromptEditor.tsx:882-895` uses to restore the cleared draft) plus a
   `USER_FEEDBACK` warning carrying the thrown message. `Run in Parallel`
   rejects by _throwing a human-readable `Error`_ from
   `WorkflowInstance.executeEphemeralParallelPrompt` (`WorkflowInstance.ts:3525+`)
   and gets its toast for free. Steer does the same.
3. **`Run in New Workflow` is the routing precedent for a non-mutating
   dispatch.** It is a plain `vscode.postMessage` (not
   `postWorkflowDefinitionMutation`), gets its own `MESSAGE_TYPES` entry next
   to `EXECUTE_PROMPT`, and its own router case at
   `WebviewMessageRouter.ts:801-822`. Steer follows it exactly.

---

## UX

The shape is settled — split button, steer first in the drop-up, shown-disabled
with a reason. What remains is the gate and the two tooltips.

### Scope and behavior

- **New-prompt mode only** (`selectionTarget.kind === EDITOR_TARGET_KINDS.NEW_PROMPT`).
  Steering is out-of-band and unrelated to the queue; mixing it with
  Update/Delete semantics on an existing step is confusing. `Run in Parallel`
  already draws this line the same way.
- **Prompt step type only** (`stepType === STEP_TYPES.PROMPT`). Scripts don't
  talk to a harness session. This is the one place steer is _stricter_ than the
  other two menu items, both of which accept script drafts.
- **Clears the draft on send**, like every other dispatch, with the
  `EXECUTE_PROMPT_ERROR` restore covering rejection.
- **Overrides stay visible and usable.** The quick pickers and properties
  drawer still apply to a subsequent Run/Queue of the same draft. They simply
  have no effect on a steer send; the menu item's tooltip is the only place
  this is stated.
- **No confirmation modal.** Steering should feel as immediate as typing into
  the TUI.
- **No second receipt event.** See "The receipt is already built" below — this
  reverses the earlier proposal to proactively echo the sent text into the
  response feed.

### Tooltips

Follow the shipped convention, where the enabled tooltip states what the action
binds to (`Run in Parallel`'s is `Runs beside step N; prior context resolves
from before step N`). Steer's names the session it targets, which also answers
the old "should the menu item show which harness?" question without widening
the label:

| State    | Tooltip                                                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enabled  | `Sends to the live <harness label> session (step N). Prompt overrides are ignored.`                                                                                                   |
| Disabled | `No live harness session for this workflow` / `Only available for a new prompt` / `Steering is only available for prompt steps` / `Enter a prompt first` / `Read-only — external run` |

The harness label comes from the rail-active `TerminalSession.harnessId`, which
the store already carries (`terminalStore.ts:23`).

---

## Availability gate

Add `useActiveInteractiveSession(workflowId)` in
`src/ui/webview-react/hooks/`, mirroring `useActiveWorkflowExternalOwner.ts`:

```ts
terminalStore.activeSessionIds[workflowId] → sessionId
terminalStore.sessions[workflowId].find(s => s.id === sessionId)
  → s.kind === SESSION_KINDS.AI_CLI && s.status === TERMINAL_SESSION_STATUS.RUNNING
```

It returns the live `TerminalSession | undefined`. Then add a `steer` key to
`RunDispatchTargets` (`useRunDispatchTargets.ts:29`) composed from it plus the
existing `contentReason` / new-prompt checks, and the new prompt-step-type
check. `EditorFooter` gets one more `RunDispatchTarget` prop and stops passing
the hard-coded placeholder.

This targets **the session the user is already looking at** in the terminal
rail, not an independent picker. With several concurrent AI-CLI sessions (a
parallel group), switching rail tabs before sending changes the target; there
is no cross-session picker in this plan.

**`status === RUNNING` deliberately covers two situations**, and both are
wanted:

- **Mid-run** — a queue step is executing in that PTY right now.
- **Between runs** — the workflow finished but the PTY is still alive because
  inject mode retained it (`WorkflowInstance.liveInjectIntegrations`,
  `WorkflowInstance.ts:439`). `terminalStore` only leaves `RUNNING` on
  `TERMINAL_ENDED` (PTY exit) or `clearAiCliSessions` (next run start), so an
  idle-but-alive TUI still reads as `RUNNING`.

The second case is the safer and arguably primary one; see "Mid-turn steering
races the queue" under Edge Cases for why.

---

## Dispatch path (extension host)

### Reuse the whole prompt pipeline, in inject mode

**Decision (answers old Open Question 1):** do not hand-assemble a call to
`formatCategorizedReferences`. Call the live integration's existing
`CliPromptPreparer.preparePrompt` (`src/core/harness/shared/CliPromptPreparer.ts:433`)
with a synthetic one-off `PromptStep` built from the draft, and
**`injectMode = true`**:

```ts
preparePrompt(
  { prompt: draftText, /* no name, no overrides */ },
  workflowContext,      // the live run's context — workspace roots, condition results
  reducedResolvedProperties,
  resolvedSessionId,
  /* injectMode */ true
) => { promptWithInstruction, tempFilePaths, diagnostics, imageFileRefs }
```

`promptWithInstruction` is the finished categorized text. The old question
("does `formatCategorizedReferences` degrade cleanly with agent/skill/context
/excerpt categories empty?") dissolves: `planPrompt` already walks that exact
path on every inject-mode prompt that has no agent and no skills, and the
formatter's documented "absent categories omitted" contract is exercised in
production today. No new branching, and no new seam.

`reducedResolvedProperties` keeps the **live session's** `harness` and `model`
(the preparer reads `harness` for diagnostics and the integration's own
`formatDirectFileRef`/`formatTempFileRef` must match the harness that will read
the text) and neutralizes the rest: `agent: undefined`, `skills: []`,
`priorContext: PRIOR_CONTEXT_KEYWORDS.NONE`.

**`injectMode = true` is not optional, and this is the sharpest edge in the
plan.** It switches the inline-vs-temp-file check from `isSimplePrompt` to
`isInjectablePrompt` (`CliPromptPreparer.ts:467-471`), and
`HarnessIntegration.isInjectablePrompt` (`src/core/HarnessIntegration.ts:837`)
rejects any text containing `\x00-\x1f` or `\x7f`. A multi-line steer draft
contains `\n`, so it _must_ go out as a temp-file reference — a raw `\n` in a
PTY write is a newline inside the TUI's input box and a raw `\r` submits the
turn early, mid-message. Preparing with `isSimplePrompt` would let multi-line
text through inline and corrupt the send.

### Writing the turn into the PTY

**Decision (answers old Open Question 3):** the turn-submit sequence lives in
`CliExecutionRunner.executeInteractiveInject`
(`src/core/harness/shared/CliExecutionRunner.ts:193-275`), and it is more than
"write text, then Enter":

1. `INJECT_FOCUS_PULSE_COUNT` (2) writes of focus-in `\x1b[I`, each followed by
   `INJECT_FOCUS_SETTLE_DELAY_MS` — some TUIs (Copilot CLI confirmed) ignore
   input until they believe they have focus;
2. the prompt streamed in `INJECT_PROMPT_CHUNK_SIZE` (256) chunks via
   `chunkInjectPrompt` (`:914`), with an inter-chunk delay;
3. `INJECT_PRE_SUBMIT_DELAY_MS`;
4. `INJECT_SUBMIT_PULSE_COUNT` (2) writes of `\r` — `\r` is the submit key,
   `\n` is not; duplicate submits are benign, a dropped one is not;
5. an event-loop yield, then a `failureTracker.getPtyTermination()` check,
   because `writeToCurrentPtySession` can return `true` for a process whose
   `onExit` has not fired yet.

Every write goes through `CliTransportCoordinator.writeToCurrentPtySession`
(`src/core/harness/shared/CliTransportCoordinator.ts:516`), which returns
`false` once the PTY is gone.

**Extract steps 1–5 into a reusable async writer** — `writeTurnToLivePty(text):
Promise<boolean>` on `CliExecutionRunner`, or a small `PtyTurnWriter` in
`src/core/harness/shared/` if the constants want their own home. Both
`executeInteractiveInject` and the steer path call it; the pulse counts and
delays must not be duplicated. `executeInteractiveInject` keeps everything
after the write (session-id persistence, log monitoring, inject-context
bookkeeping) — steer needs none of it.

**Serialize writes per session.** A steer is a single atomic, fully-formed turn
rather than a keystroke, so two concurrent writers (two steers, or a steer and
an inject-mode dispatch) would interleave 256-byte chunks into one input box
and produce garbage. Guard the writer with an `AsyncMutex`
(`src/core/harness/shared/AsyncMutex.ts`) held by the owning integration for
the duration of the pulse sequence. This is also what makes viewer steering
safe — see the decision below.

### Resolving `sessionId` → the owning integration

`WorkflowInstance` holds several integration registries and the handler must
search all of them, because which one holds the owner depends on whether a run
is in flight: `activeTargetResources` and the target/harness-keyed execution
caches mid-run, `liveInjectIntegrations` between runs.

**Match on `integration.getActivitySessionId()` in every case**
(`CliIntegration.ts`, which returns `transportCoordinator.getLastPtySessionId()`).
_Correction to this plan's original text, which shipped as a bug:_ it specified
matching mid-run on `ActiveTargetResources.ptySessionId`. That field is written
only by `registerTargetPtySession`, which the executor calls exclusively for
interactive **script** PTYs — an AI-CLI TUI never populates it. So every mid-run
steer failed with `No live harness session for this workflow.` until the lookup
was rewritten to match on the activity session id alone.

Add one private `findIntegrationForPtySession(sessionId)` covering all the
registries, and a public `WorkflowInstance.sendSteerMessage(sessionId, text)`.

**Re-check liveness host-side; never trust the webview's gate.** Before
preparing anything, assert
`getPtyProcessManager()?.getSession(sessionId)` exists, that its `workflowId`
is this instance's, and that its kind is `SESSION_KINDS.AI_CLI`. If any check
fails, or `findIntegrationForPtySession` returns nothing, or the writer returns
`false`, **throw a human-readable `Error`** — the shipped handler contract turns
that into a restored draft plus a toast. Suggested messages: `"That harness
session has ended. The steer message was not sent."` and `"No live harness
session for this workflow."`

### Temp files outlive the send — do not clean up in a `finally`

Every existing `preparePrompt` caller deletes its `tempFilePaths` in a
`finally` once the _monitored_ turn resolves (`CliExecutionRunner.ts:325`,
`:686`; `shared/CliTransportCoordinator.ts:206`, `:507`). A steer has no monitored
turn, and the harness may not dequeue the steered turn for minutes if it is
mid-generation — so deleting after the write would hand the TUI a path that
404s by the time it reads it. This is the producing-side view of the "Temp
prompt files" warning in `.github/copilot-instructions.md`.

**Decision:** hand the steer's `tempFilePaths` to the owning integration to
delete when that PTY session ends, alongside its existing artifact cleanup,
with `TempFileManager.cleanupOrphanedFiles()`'s 24-hour activation sweep
(`src/utils/TempFileManager.ts:499`) as the backstop. Never delete immediately
after the write.

### `canReuseForInject` is unrelated

`HarnessIntegration.canReuseForInject()` / `CliIntegration.canReuseForInject()`
governs whether an integration is kept alive **across separate workflow runs**
so the _next_ run can resume the same PTY. Steering targets a session that is
already alive — it does not go through `canReuseForInject`,
`WorkflowInstance.executeLoadedPromptFile`, or the queue/execution state
machine at all. Stated explicitly so nobody routes steer dispatch through the
inject-mode continuation path by analogy; the two mechanisms share only the
word "inject" and, now, the extracted PTY writer.

---

## The receipt is already built

**Decision (reverses the earlier "proactively add the sent text to the feed"
proposal):** emit nothing extra. The user-steer machinery shipped with
`TERMINAL_FOLLOWUP_TRACKING_PLAN.md` already produces exactly one receipt, in
both enabled states, on all six harnesses.

`CliLogEventPump.buildUserSteerEvent` (`src/core/harness/shared/CliLogEventPump.ts:96-124`)
asks the parser's `classifyUserEvent` whether a `user`-role log entry is the
prompt ctrlyoke dispatched or a genuine human follow-up, using
`dispatchedPromptText` as the discriminator, and synthesizes a
`CLI_EVENT_TYPES.USER_STEER` event for the latter. A steer message is never the
in-flight step's `dispatchedPromptText`, so it classifies as `human-steer` in
whichever reader owns the log at the time:

- **Mid-run** — `CliLogMonitor` owns it (`CliLogMonitor.ts:164-183`), with
  `dispatchedPromptText` set to the running step's prompt. The USER_STEER event
  and the harness's answer stream into that step's events.
- **Between runs** — `SessionActivityWatcher` owns it, with
  `dispatchedPromptText: undefined` (`SessionActivityWatcher.ts:51`). Events
  reach `WorkflowInstance.handleSessionActivityResumed`
  (`WorkflowInstance.ts:3778`), which forwards to the dashboard _and_ persists
  through `outputHistoryManager.recordFollowUpResponse`.

So the persistent, non-ephemeral record the original plan wanted already
exists, and adding a dispatch-side event would double it.

**Correction to this plan's earlier claim about provider coverage.** The old
text said Codex/Qwen/OpenCode "have no provider-specific follow-up signal," so
steer pickup would be weaker there. That conflates two different things.
`classifyUserEvent` and `extractUserSteerText` are implemented in **all six**
parsers (`claude/`, `copilot/`, `codex/`, `qwen/`, `opencode/`,
`antigravity/`), so the steer receipt and the response are captured everywhere.
What is Claude/Copilot/Antigravity-only is _background-work completion holding_
(`BackgroundFollowUpState`) — the ability to delay a step's completion while a
resumed turn is still running. On the other three, a steered turn that starts
after the step's own completion fires is more likely to be attributed to the
follow-up channel than to the step's own output. Both are persisted; only the
attribution boundary moves.

**One caveat worth stating in the implementation.** Because a multi-line draft
is sent as a temp-file reference, what surfaces in the USER_STEER row is the
expanded sentence the harness actually saw (`…follow the instructions in
@…prompt.md`), not the raw draft. That is an honest record of what was sent —
and identical to what a user would see had they typed the same reference — but
it is not readable as a message. If that proves annoying in practice, the fix
is to render the referenced temp file's body in the USER_STEER row, not to emit
a second event from the dispatch side.

---

## Type / message changes

- `src/types/DashboardConstants.ts` — add next to `RUN_IN_NEW_WORKFLOW`
  (`:502`), **not** in the Terminal I/O block: a steer is an editor dispatch
  whose failure contract is the editor's, and it never touches raw keystroke
  routing.

  ```ts
  // Steer messages — webview → extension: inject a categorized prompt directly
  // into an already-running interactive PTY session. Never queued; ignores all
  // prompt overrides (harness/model/agent/skills/permissions).
  SEND_STEER_MESSAGE: "sendSteerMessage", // { workflowId, sessionId, text }
  ```

  `text` is the raw prompt-editor draft; expansion happens on the extension
  host, same as `EXECUTE_PROMPT`.

  **Not an `ACTION_TYPES` value.** `RUN_PARALLEL` is an action because it is a
  queue mutation delivered through the revision-guarded `EXECUTE_PROMPT`.
  Steering mutates no definition, so it must not be wrapped in
  `postWorkflowDefinitionMutation` — it is a plain `vscode.postMessage`, like
  `RUN_IN_NEW_WORKFLOW`.

- `src/ui/WebviewMessageRouter.ts` — one case beside `RUN_IN_NEW_WORKFLOW`
  (`:801`), delegating to `WorkflowStepHandlers`.
- `src/ui/WorkflowStepHandlers.ts` — `handleSendSteerMessage(ctx, message)`,
  with the same `try/catch` shape as `handleExecutePrompt` (`:38-82`): on
  rejection emit `EXECUTE_PROMPT_ERROR { text }` **and** a `USER_FEEDBACK`
  warning carrying `getErrorMessage(error)`. No `publishViewIdentity` call —
  nothing was mutated, so there is no revision to hand back.
  _(Aligned fix worth taking while here: `RUN_IN_NEW_WORKFLOW`'s catch at
  `WebviewMessageRouter.ts:812-821` emits only `EXECUTE_PROMPT_ERROR`, so its
  failures restore the draft silently with no toast. Give it the
  `USER_FEEDBACK` emit too.)_
- `src/core/WorkflowOrchestrator.ts` — resolve the instance for `workflowId`
  and delegate.
- `src/core/WorkflowInstance.ts` — `sendSteerMessage(sessionId, text)` plus the
  private `findIntegrationForPtySession`.
- `src/core/harness/CliIntegration.ts` — a `sendSteerMessage(text)` entry point
  performing the reduced preparation, the mutex-guarded write, and the deferred
  temp-file registration.
- `src/core/harness/shared/CliExecutionRunner.ts` — extract the PTY turn writer.
- `src/ui/webview-react/hooks/useActiveInteractiveSession.ts` — new.
- `src/ui/webview-react/hooks/useRunDispatchTargets.ts` — add the `steer` key.
- `src/ui/webview-react/components/editor/EditorFooter.tsx` — one new
  `RunDispatchTarget` prop and `onSendSteerMessage`; replace the placeholder
  option's hard-coded `disabled`/`title`/`onClick`.
- `src/ui/webview-react/components/editor/PromptEditor.tsx` — a
  `sendSteerMessage` callback beside `runInParallel` (`:1060`) and
  `runInNewWorkflow` (`:1065`), setting `lastSubmittedTextRef` before clearing
  so the restore path works.

No changes to `schemas/workflow-schema.json` or `CtrlYokeTypes.ts` — steer
messages are never persisted into a workflow file.

---

## Decisions on the remaining open questions

**A viewer may steer; there is no `isController` check.** The
controller/viewer gate in `TerminalMessageHandlers.isController`
(`src/ui/TerminalMessageHandlers.ts:246-255`) exists so two clients' _raw
keystrokes_ cannot interleave into one TUI input buffer — an echo and
rendering concern, not an authority one. A steer is a single atomic,
fully-formed turn, already serialized by the per-session mutex, so it cannot
interleave the way keystrokes can. It is also semantically a sibling of Run,
Run in Parallel, and Run in New Workflow, none of which consult
`controllerClientId`: any client that can post `EXECUTE_PROMPT` for this
workflow can already make the harness do anything. Withholding steer from a
viewer would protect nothing while making the same button behave differently on
two screens looking at the same run.

**The menu item does not name the harness in its label; the tooltip does.**
See the tooltip table above. The label stays `Send Steer Message`, matching the
shipped placeholder and the other three items' verb-first naming.

---

## Edge cases

- **Session ends between the button enabling and the click landing.** Handled
  by the host-side liveness re-check and the writer's `false` return; surfaces
  as a restored draft plus a toast.
- **Mid-turn steering races the queue advancing.** This is the sharpest
  behavioral edge and it is documented, not gated. A steer written while the
  TUI is generating is queued by the harness and processed as a _subsequent_
  turn. If the step's completion detection fires on the first turn, the
  workflow advances while the steered turn is still generating — and because
  `CliIntegration` pauses `SessionActivityWatcher` before dispatching the next
  prompt, the steered answer can be read by the _next_ step's `CliLogMonitor`
  and attributed there. Nothing is lost, but attribution can land one step
  late. The three harnesses with `BackgroundFollowUpState` narrow this window;
  the other three do not. Accept it for v1 — the between-runs case (idle PTY,
  no queue to advance) has none of this, and mid-run steering is still strictly
  better than the status quo of typing into xterm, which has the identical
  race with no record at all.
- **Multi-line drafts.** Handled by `injectMode = true` → temp-file reference.
  A draft that is a single line of plain text with no control characters goes
  inline, which is the nicest case and also the only one whose USER_STEER
  receipt reads as prose.
- **Multiple concurrent PTYs for one workflow** (a parallel group). Steer
  always targets `activeSessionIds[workflowId]`, the rail-active one. Switching
  rail tabs before sending changes the target; no picker.
- **Draft contains unresolved or invalid `@` / `#` references.** Same path as
  normal submission — `createContextReferenceLintExtension` in the editor, and
  `preparePrompt`'s `skippedReferences` → `UNRESOLVED_REFERENCE` diagnostics on
  the host. Do not special-case steer to skip either.
- **Shell (non-AI-CLI) rail session is active.** Gate returns not-enabled;
  `session.kind` must be `AI_CLI`.
- **Script draft.** Menu item disabled with `Steering is only available for
prompt steps`. Unlike Run in Parallel and Run in New Workflow, which accept
  script drafts.
- **External run (CLI watch mode).** Disabled wholesale with the footer, same
  as every other dispatch.

---

## Implementation stages

**Stage 1 status — landed:** `CliExecutionRunner.writeTurnToLivePty(text)` in
`src/core/harness/shared/CliExecutionRunner.ts` now owns the single-sourced
focus/chunk/submit sequence and post-write PTY termination check. Its
runner-owned `AsyncMutex` (`turnWriteMutex`) serializes the complete sequence;
the runner is created once by each `CliIntegration`, so
`executeInteractiveInject` and the future steer caller share the same lock.
No steer surface was added in this stage.

**Stage 2 status — landed:** the extension-host dispatch surface is now
`WorkflowInstance.sendSteerMessage(sessionId: string, text: string): Promise<void>`.
It resolves the owning integration through the private
`findIntegrationForPtySession(sessionId: string)` across both active-target and
retained-inject registries, re-checks the live AI-CLI PTY session, and delegates
to `CliIntegration.sendSteerMessage(text: string): Promise<boolean>`. The latter
uses the live workflow context and reduced properties to call
`CliPromptPreparer.preparePrompt(..., injectMode = true)` before invoking
`CliExecutionRunner.writeTurnToLivePty(text: string): Promise<boolean>`.

Steer-created temp prompt files are registered by
`CliIntegration.registerDeferredSteerTempFiles(tempFilePaths: string[]): void`
and held in
`deferredSteerTempFilePaths`; `handlePtyExit` drains that list through the
existing `CliIntegration.cleanupTempFiles(...)` path. They are never deleted
after the steer write.

**Stage 1 — PTY turn writer.** Extract the focus/chunk/submit/verify sequence
out of `executeInteractiveInject` into a reusable writer, add the per-session
`AsyncMutex`, and prove `executeInteractiveInject` is behavior-preserving.
Pure refactor; no steer surface yet.

**Stage 2 — host-side steer (landed).** `CliIntegration.sendSteerMessage`
(reduced `preparePrompt` in inject mode, mutex-guarded write, deferred temp-file
registration) and `WorkflowInstance.sendSteerMessage` plus
`findIntegrationForPtySession`, with host-side liveness re-checks and
human-readable rejection errors. Testable with no UI.

**Stage 3 status — landed:** `MESSAGE_TYPES.SEND_STEER_MESSAGE` carries the
`{ workflowId, sessionId, text }` payload from the webview to the extension.
The router delegates it to `WorkflowStepHandlers`, which calls the host-side
dispatch and restores the raw `text` through `EXECUTE_PROMPT_ERROR` plus a
warning toast on rejection. `RUN_IN_NEW_WORKFLOW` now emits the same warning
toast on failure. Stage 4 must post exactly:
`{ type: MESSAGE_TYPES.SEND_STEER_MESSAGE, workflowId, sessionId, text }`.

**Stage 3 — message and route.** `MESSAGE_TYPES.SEND_STEER_MESSAGE`, the router
case, `WorkflowStepHandlers.handleSendSteerMessage` with the
`EXECUTE_PROMPT_ERROR` + `USER_FEEDBACK` contract, and the aligned
`RUN_IN_NEW_WORKFLOW` toast fix.

**Stage 4 — editor.** `useActiveInteractiveSession`, the `steer` key on
`useRunDispatchTargets`, the `EditorFooter` prop, and `PromptEditor`'s
`sendSteerMessage` callback. The placeholder becomes live in this stage and
not before.

---

## Test strategy

- `src/ui/webview-react/test/hooks/useRunDispatchTargets.test.ts` (exists):
  each steer disabled reason, and enabled only with a live `AI_CLI` +
  `RUNNING` rail session in new-prompt prompt-step mode.
- `src/ui/webview-react/test/components/editor/EditorFooter.test.tsx` (exists):
  the steer item is enabled/disabled with the right tooltip and fires
  `onSendSteerMessage`.
- `src/ui/webview-react/test/components/editor/PromptEditor.test.tsx` (exists):
  the callback posts `SEND_STEER_MESSAGE` with `{ workflowId, sessionId, text }`,
  is **not** wrapped in `postWorkflowDefinitionMutation`, clears the draft, and
  restores it on `EXECUTE_PROMPT_ERROR`.
- `src/test/unit/CliExecutionRunner.test.ts` (exists): the extracted writer
  emits the same focus/chunk/submit byte sequence `executeInteractiveInject`
  emitted before the refactor, returns `false` on a dead PTY, and serializes two
  concurrent callers without interleaving chunks.
- `src/test/unit/WorkflowInstance.test.ts` (exists): session→integration
  resolution from both `activeTargetResources` and `liveInjectIntegrations`; a
  `sessionId` belonging to another workflow, a shell session, or a dead PTY each
  throws rather than writing; temp files are **not** deleted immediately after
  the write.
- A preparer test proving a multi-line steer draft is prepared as a temp-file
  reference (i.e. `injectMode = true` is actually in force) and that a
  single-line plain draft goes inline.

---

## Not in scope (YAGNI)

- A session picker for workflows with multiple concurrent interactive sessions
  — always the rail-active session.
- Any change to queued-step execution, `WorkflowExecutor`, or the state machine
  — steering never touches the queue.
- A new persisted record type in run manifests or `events.jsonl` — the
  USER_STEER classification already covers it.
- Rendering the referenced temp prompt file's body in the USER_STEER row — the
  named follow-up if the reference form proves unreadable.
- Steering into a **headless** (non-interactive) execution — there is no PTY.
- Steering into a script step's PTY.
- A keyboard shortcut for steer send. `Run in Parallel` and `Run in New
Workflow` both shipped without one; add all three together later if usage
  patterns call for it.
- An MCP equivalent (`steer_session`). Worth considering once the UI ships and
  the mid-turn attribution edge is understood in practice.
