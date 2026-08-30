# User Input Step Plan

## Problem

A user wants to insert a manual checkpoint into a workflow — e.g. after a step that
generates a diff or a design doc, pause and ask "does this look right? (yes/no)" before
continuing. If the answer is no, stop the workflow instead of burning further AI turns on
a direction the user already rejected. Today there is no supported way to do this. The
closest existing primitives are audited below, followed by a recommended design for a
first-class step type.

No existing backlog doc covers this — `dev/backlog/` was searched and nothing overlaps.
`AskUserQuestionOutput.tsx` looked like a candidate at first glance but is unrelated (see
"What `AskUserQuestion` actually is" below).

---

## What already exists today

### 1. `scriptStep` + `executionMode: interactive` already supports blocking on stdin

`ScriptStep` (schema: `scriptStep` in `schemas/workflow-schema.yaml`) has an
`executionMode` field. When resolved to `interactive` (step → workflow → global setting;
see `PropertyResolver.resolveExecutionMode`), `WorkflowExecutor.executeScriptStep`
(`src/core/WorkflowExecutor.ts:1095-1279`) does **not** run the script through
`ScriptProcessRunner`/`CliProcessManager` at all — it calls `context.spawnScriptPty(...)`
instead, which spawns the command inside a real PTY (`PtyProcessManager`) wired to an
embedded xterm terminal (`TerminalInstance.tsx`) in the dashboard. The user can type into
that terminal. This means a script step whose `script` is:

```sh
read -p "Continue? (y/n) " ans; [ "$ans" = "y" ]
```

(or the PowerShell equivalent using `Read-Host`) **already works today** — the process
blocks on `read`, the user types an answer into the embedded terminal, and the exit code
becomes the step's pass/fail via the existing `compareSource`/`returns` evaluation
(`ScriptConditionEditor`'s "Expected Return" + "Compare Source" fields, already exposed
for `scriptStep` in the dashboard). `onFail: stopWorkflow` (the scriptStep default) then
halts the workflow exactly as the user described.

So the mechanism the user speculated about — "maybe just making the script interactive
and calling the OS-variant of read" — is not a new feature. It is already wired end to
end. What's missing is polish and reach, covered next.

### 2. Why that's not sufficient as *the* answer

- **PTY works in both the VS Code webview and the hosted browser dashboard — it only
  disappears for the standalone `ctrlyoke` CLI binary.** `CtrlYokeHostedServer` (the
  browser-tab dashboard, `isStandalone` in the webview) is only ever constructed from
  `extension.ts` — it's the same VS Code extension-host process as the desktop webview,
  just relaying dashboard I/O over HTTP/WebSocket instead of postMessage. The PTY for an
  interactive script step is spawned server-side in that same extension host either way,
  which is why an interactive script step works fine from a browser tab in practice.
  `WorkflowOrchestrator.buildWorkflowInstance()` confirms this: it passes
  `hostCanProvidePty: true` unconditionally to every `WorkflowInstance` it creates
  (`WorkflowOrchestrator.ts:5502-5512`), with no `isStandalone` branch anywhere in the
  real execution path. (Note: `useCompatibilityDiagnostics.ts:233`'s
  `hostCanProvidePty: !isStandalone` is a separate, client-side-only compatibility-
  diagnostics preview computation, not wired to the real gate — it looks stale/inaccurate
  and may be worth a fix on its own, but that's outside this plan's scope.) The one place
  `hostCanProvidePty` is genuinely conditional is the standalone `ctrlyoke` CLI binary,
  which has no extension host at all — there it's only `true` when the CLI process itself
  has a real TTY on both stdin/stdout (`CliExecutionMode.ts:17-38`), and `PropertyResolver`
  clamps `interactive` down to `headless` otherwise (`ExecutionPropertyResolver.ts:292`,
  surfaced via `cli.ts`'s `warnAboutClampedInteractiveSteps`). So the PTY/`read` approach
  already covers VS Code + hosted browser; only pure headless CLI runs (no TTY — e.g. CI)
  are the actual gap, not "browser vs desktop."
- **No dedicated UX.** The user has to know the embedded-terminal escape hatch exists,
  open/focus the right terminal tab, and type a raw answer. There's no button, no
  structured yes/no affordance, nothing rendered in `OutputPane.tsx` the way the user
  described wanting.
- **Cross-platform script authoring burden.** `read` (bash) vs `Read-Host` (PowerShell)
  means every user who wants this has to hand-write and maintain a platform-specific
  script, or discover they need one at all. `CreateScriptModal` currently only
  scaffolds end-condition scripts, not this pattern.
- **No durable "awaiting input" state.** If the dashboard is closed/reloaded while a PTY
  script is blocked on `read`, there's nothing in `_runtime` describing "this step is
  paused waiting for a human," so a reload can't reliably re-show the right UI (whereas
  every other in-flight step state — `running`, retry counters, etc. — is already
  persisted per `promptRuntimeMetadata`/`runtimeMetadata` in the schema).

### 3. What `AskUserQuestion` actually is (ruled out as a base)

`AskUserQuestionOutput.tsx` / `askUserQuestionLayout.ts` / `AskUserQuestionData` in
`src/ui/webview-react/types/cliEvents.ts` render a harness-agnostic **read-only replay**
of a question the *AI itself* asked mid-turn through its own tool-call mechanism (e.g.
Claude's `AskUserQuestion` tool). The actual back-and-forth happens inside the harness's
own interactive terminal session — ctrlyoke only displays what already happened
afterward, via the CLI's log/event stream. There is no path from this component back into
workflow control (no onPass/onFail, no "stop the workflow"), and it only fires when the
AI decides to ask — not something a workflow author can force at a specific point. It's
useful prior art for the *visual layout* of a question+options block, but not a mechanism
this feature can be built on.

---

## Recommended design: a first-class `userInput` step type

Add a step type that is a peer to `prompt` and `script` — not a variant of `scriptStep`
— because its execution model is fundamentally different (no child process at all; it's
a pure pause-and-wait-for-a-webview-message operation) and because it needs to work
identically whether or not the host can provide a PTY.

### Input surface scope (v1): buttons + optional freeform only

The step asks one question and collects one answer via:

- **Options, rendered as buttons** (`options[]`) — the primary affordance, covering
  yes/no gates and small labeled-choice gates ("Approve / Request changes / Abort").
  Whether a given number of options renders as buttons vs. a dropdown is a display
  decision for the UI layer (e.g. switch to a `CustomSelect` past some option count) —
  it is not a separate schema field or step capability.
- **An optional freeform text box** (`allowFreeform`) — the escape hatch for a typed
  note/answer, mirroring `AskUserQuestion`'s custom-reply affordance.

Explicitly **out of scope for v1**: a general-purpose multi-field form (several typed
inputs — text, number, checkbox, per-question dropdowns — collected in one step, closer
to a web form than a review gate). Nothing in the codebase's existing patterns
(`AskUserQuestionOutput`, `ScriptConditionEditor`) models multiple structured fields per
prompt, and there's no evidence of demand for structured data collection as opposed to a
checkpoint/gate. Revisit only if a concrete use case surfaces that buttons + freeform
can't satisfy.

### Schema (`schemas/workflow-schema.yaml`)

```yaml
userInputStep:
  type: object
  description: >-
    A workflow step with no process/AI execution: pauses the workflow and waits for
    the user to answer a question in the dashboard before continuing.
  properties:
    type:
      type: string
      const: userInput
    name:
      type: string
      maxLength: 100
    enabled:
      type: boolean
    question:
      type: string
      description: Prompt text shown to the user. Supports {{varName}} substitution.
    options:
      type: array
      minItems: 1
      items:
        type: object
        properties:
          label:
            type: string
          description:
            type: string
        required: [label]
      description: >-
        Choices shown as buttons, e.g. [{label: "Yes"}, {label: "No"}]. Defaults to
        Yes/No when omitted.
    allowFreeform:
      type: boolean
      description: Whether to also show a text box for a custom typed reply (like AskUserQuestion's custom-reply affordance).
    timeout:
      type: number
      description: >-
        Optional wait timeout in milliseconds. Omitted = wait indefinitely (this is
        the primary use case — a human review gate). When set and exceeded, behaves
        per `onTimeout`.
    onTimeout:
      type: string
      enum: [continue, stopWorkflow]
      default: stopWorkflow
    # onPass/onFail reuse the CONDITION_ACTIONS vocabulary already used by
    # preCondition/endCondition/scriptStep, mapped from which option the user picked:
    onAnswer:
      type: object
      description: >-
        Maps an option label to an action. Unlisted options default to "continue".
      additionalProperties:
        type: string
        enum: [continue, stopWorkflow]
    _runtime:
      $ref: '#/definitions/promptRuntimeMetadata'
  required: [type, question]
  additionalProperties: false
```

`workflowStep` (`#/definitions/workflowStep`) becomes a three-way `oneOf` alongside
`promptStep`/`scriptStep`, matching the pattern already used in
`dev/backlog/WORKFLOW_STEP_PLAN.md` for its own step-type addition.

### Types (`src/types/CtrlYokeTypes.ts`)

```typescript
export interface UserInputStep {
  type: "userInput";
  name?: string;
  enabled?: boolean;
  question: string;
  options?: { label: string; description?: string }[];
  allowFreeform?: boolean;
  timeout?: number;
  onTimeout?: "continue" | "stopWorkflow";
  onAnswer?: Record<string, "continue" | "stopWorkflow">;
  _runtime?: PromptRuntimeMetadata & {
    answer?: string;
    answeredAt?: number;
  };
}
```

### Execution flow (`WorkflowExecutor.ts`)

Add `executeUserInputStep`, dispatched alongside the existing `executeScriptStep` /
prompt-step branch wherever the step-type union is switched on
(`WorkflowExecutor.ts` around the queue/finalStep dispatch — same call sites that check
`isScriptStep`/`isWorkflowStep`-style discriminants today).

1. Mark the step `RUNNING` in the dashboard as usual (`dashboardProvider.updateStepStatus`).
2. Persist `_runtime.startedAt` and a new durable marker — e.g. reuse `STEP_STATUS` with a
   value the dashboard already treats as "awaiting" (or add one; `runtimeMetadata`'s
   `executionState` enum and `promptRuntimeMetadata.terminalStatus` both have precedent
   for adding an enum member deliberately). This is what makes a reload safe: on
   `updateSessionRestored`/`updateFileSelected` the dashboard sees the persisted question
   + status and re-renders the waiting UI instead of losing it.
3. Call a new `IDashboardSink` method, e.g.
   `updateUserInputRequested(stepIndex, { question, options, allowFreeform }, workflowId)`,
   which the webview turns into a `WebviewMessageTypes` broadcast to the React store.
4. `await` a promise that resolves when the webview posts a matching response message
   (new `MESSAGE_TYPES.USER_INPUT_STEP_ANSWERED`, carrying `stepIndex`/`workflowId`/
   `answer`) — the same requestId/await-a-postMessage-response shape already used by
   `ScriptConditionEditor`'s `CREATE_END_CONDITION_SCRIPT` /
   `END_CONDITION_SCRIPT_CREATED` round trip, and by `WebviewMessageRouter` for other
   command acks.
5. If `timeout` is set, race the promise against a timer; on timeout apply `onTimeout`.
6. Resolve the action from `onAnswer[answer] ?? CONDITION_ACTIONS.CONTINUE`, persist the
   answer onto `_runtime`, mark the step `COMPLETED`, and either advance the queue or stop
   the workflow (same `stopWorkflow` plumbing `scriptStep.onFail` already uses).
7. The workflow's existing Stop button must be able to cancel a pending wait (treat it
   like cancelling any other in-flight step) — no new cancellation path needed if the
   promise is wired into the same cancellation token/AbortSignal other steps already
   observe.

### UI (`OutputPane.tsx` / new `UserInputOutput.tsx`)

Add a new row type to `OutputRenderRow`/`outputRows.ts`, rendered via a new
`UserInputOutput` component (visually similar to `AskUserQuestionOutput` — question text,
option list — but interactive: real `ActionButton`s that post
`MESSAGE_TYPES.USER_INPUT_STEP_ANSWERED` on click, plus an optional freeform `input` when
`allowFreeform` is set). Once answered, re-render in the same read-only style
`AskUserQuestionOutput` already uses (selected option checked, greyed-out buttons) so
history scrollback shows what was picked — this component can likely share layout/styling
helpers with `AskUserQuestionOutput` even though the data source is unrelated.

Also surface the pending question outside the scrollback — e.g. a banner similar to
`RunSummaryBanner`/`WorkspaceWorktreeOwnershipBanner` already rendered at the top of
`OutputPane`, or a status-bar affordance — so a user who has scrolled away still notices a
workflow is paused waiting on them.

### Where this still simplifies things, now that the PTY premise above is corrected

Both approaches actually reach the VS Code webview and the hosted browser dashboard
equally (see §2) — so avoiding `hostCanProvidePty` branching isn't the distinguishing
argument for a dedicated step type. The real wins are the ones already listed in §2: a
proper button UI instead of an embedded terminal, no per-user bash/PowerShell script
authoring, and durable "awaiting input" `_runtime` state that survives a reload. The
postMessage-based design happens to make the mechanism simpler to reason about (no PTY
process/terminal session lifecycle to manage for something that's just a yes/no gate),
but "works in the browser" is not a differentiator — the PTY approach already does too.

**`ctrlyoke` CLI-only execution** (headless automation, no dashboard attached) is the one
surface with no UI to post the question to. Options: (a) fall back to reading real stdin
directly when the CLI has a real TTY (simpler than PTY relay since the CLI process's own
stdin *is* the terminal — no relay needed), or (b) treat a `userInput` step as
unsupported/auto-`stopWorkflow` in pure headless CLI runs with a clear diagnostic,
mirroring how `warnAboutClampedInteractiveSteps` already warns about clamped interactive
scriptStep. Needs a decision before implementation; leaning (a) since it's low effort and
keeps CLI runs from silently behaving differently than the dashboard.

---

## Open questions

1. **Step-type naming**: `userInput` vs `confirm` vs `approval`. `userInput` reads best if
   `allowFreeform` becomes a real, commonly-used escape hatch beyond yes/no; `approval`
   undersells that. Leaning `userInput`.
2. **Does this belong in `finalStep`/loop position too**, or only in `steps`? A review gate
   makes sense mid-queue; less obviously useful as a `finalStep` occupant. Default to
   allowing it anywhere `workflowStep` is valid, same as `scriptStep`.
3. **Retry integration**: should a "No" answer be able to trigger a retry of the
   *previous* prompt step (like `endCondition.onFail: retry`) rather than only
   `stopWorkflow`/`continue`? That would need a `retryPrompt`-style template and access to
   the prior step's output, which starts to duplicate `endCondition` machinery. Recommend
   shipping v1 with just `continue`/`stopWorkflow` and revisiting if users ask for retry.
4. **MCP dynamic-queue interaction**: if an MCP-appended prompt runs after a pending
   `userInput` step, does the queue correctly stay blocked? Should fall out naturally from
   treating the wait as a normal in-flight step, but needs a test.
5. **Notification hook parity**: should a pending `userInput` step fire a `notification`
   hook / OS notification (the workflow is stuck waiting on a human who may not be looking
   at the dashboard)? Likely yes — reuse the existing notification pipeline
   (`CtrlYokeNotificationEvent` via `notifyNotificationEvent`).
