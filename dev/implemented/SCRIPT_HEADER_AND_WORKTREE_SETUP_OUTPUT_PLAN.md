# Script Header Row and Worktree Setup Output

> **Status:** Complete. All five phases are implemented. Two related changes on the same pipeline:
> (1) a script execution renders its command twice, and (2) worktree setup
> produces no output at all while it runs.
>
> Builds directly on [`./SCRIPT_OUTPUT_UNIFICATION_PLAN.md`](./SCRIPT_OUTPUT_UNIFICATION_PLAN.md)
> and the setup lifecycle in [`../backlog/WORKTREE_SUPPORT_PLAN.md`](../backlog/WORKTREE_SUPPORT_PLAN.md).

---

## Part 1 — Script output renders the command twice

### Verified cause

`ScriptExecutionReporter.report` puts the same string on two different fields of
one `CliOutput`:

```ts
// src/core/orchestration/ScriptExecutionReporter.ts
const initOutput: CliOutput = {
  prompt: properties.script,      // :168
  ...
  cliCommand: properties.script,  // :174
```

`buildOutputRows` then emits one row per field, unconditionally:

| Site                 | Row                      | Renders                                          |
| -------------------- | ------------------------ | ------------------------------------------------ |
| `outputRows.ts:1892` | `rowKind: "prompt"`      | the raw script string, via `PromptReferenceText` |
| `outputRows.ts:1905` | `rowKind: "cli-command"` | `` `${workingDirectory}> ${command}` ``          |

So every script step, pre-condition, and end-condition shows its command twice —
once bare, once with a `cwd>` prefix. This applies to all four
`SCRIPT_OUTPUT_SOURCES`, not just script steps.

Two secondary problems fall out of the same shape:

- **`PromptReferenceText` is the wrong renderer for a script.** It scans the
  text for `@`-style prompt references and makes them clickable. A shell command
  is not a prompt and should not be reference-expanded on screen.
- **`ui.showCliCommand` is semantically wrong for scripts.** The setting means
  "show the harness CLI invocation" and is honored only on the prompt path
  (`WorkflowExecutor.ts:1941`, `:2293`, `:2886`, `:3106` gate `cliCommand` on
  `context.shouldShowCliCommand`). `ScriptExecutionReporter` ignores it, so
  today a script's command survives the setting by accident rather than by
  design. Nothing in the code says that is intentional, and the next person to
  "fix the inconsistency" would delete the only row that says what ran.

### Decision: give scripts their own row kind

Introduce `rowKind: "script-command"` rather than reusing either existing row.
A script's command is neither a prompt nor a harness invocation, and giving it a
distinct kind is what makes the `showCliCommand` question answerable ("that
setting is about harness commands") instead of debatable.

**Payload stays on `CliOutput.cliCommand`.** No new persisted field, and every
already-written `events.jsonl` keeps rendering. The branch happens in the row
builder, not in the transport:

```ts
// outputRows.ts, replacing the two current blocks
const scriptish = isScriptOutput(output); // source != null

if (output.prompt && !scriptish) {
  rows.push({ rowKind: "prompt", ... });
}

if (output.cliCommand) {
  rows.push({
    rowKind: scriptish ? "script-command" : "cli-command",
    ...
  });
}
```

Suppressing the prompt row **in the builder** (rather than only ceasing to write
`prompt`) is what fixes already-recorded runs. Stop setting `prompt` on the
script `CliOutput` as well, so new runs don't carry a duplicate payload — but
the builder guard is the load-bearing half.

Keep the `prompt: properties.script` field on the **attempt context** passed to
`startStreamingExecutionOutput` (`ScriptExecutionReporter.ts:191`). That is the
timeline/search identity for the attempt, not a rendered row, and history search
relies on it.

### Rendering

`script-command` reuses `formatCliCommandDisplay` (so the `cwd>` prefix and
working directory stay) but takes its own left-border token —
`output-script-border`, distinct from `output-prompt-border` (blue) and
`output-command-border` (yellow, `rgb(255, 200, 100)`). These are Tailwind theme
colors, not CSS custom properties: they are declared in
`src/ui/webview-react/tailwind.config.js:180` and consumed as
`border-l-output-command-border`. `CliTerminalFormatter` mirrors these two
colors in comments at `src/cli/CliTerminalFormatter.ts:490` and `:501`; add the
third there only if/when the CLI grows script-source awareness (it has none
today — `renderPromptHeader` is driven by `onPromptStart`, which the script path
never fires).

### Webview touchpoints

| File                                                               | Change                                                                 |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `utils/outputRows.ts`                                              | `ScriptCommandRow` type, builder branch, `estimateSize` case (`:1551`) |
| `components/output/OutputRow.tsx`                                  | new `case "script-command"`; add to `isCliGroupRow` list (`:1644`)     |
| `utils/outputFind.ts`                                              | search segment beside the `cli-command` case (`:171`)                  |
| `utils/markdownExport.ts`                                          | see below                                                              |
| `components/layout/output-section/OutputScrollSeekPlaceholder.tsx` | label                                                                  |

The `estimateSize` case is a copy of `cli-command`'s (same font, same chrome,
same `formatCliCommandDisplay` input) — extract the shared body rather than
duplicating the magic numbers.

### Markdown export has the same bug, plus a narrower one

`markdownExport.ts:432` emits a `### Prompt` block whenever `output.prompt` is
set, then `:441` emits `### CLI Command` — the same duplication, in exported
form. Additionally `markdownExport.ts:419` now uses `isScriptOutput` instead of
the old `(output as { source?: string }).source === STEP_TYPES.SCRIPT` check, which misses
`preCondition` and `endCondition` sources entirely and re-implements a helper
that already exists.

Fix both by importing `isScriptOutput` from `outputRenderUtils` and gating the
prompt block on `!isScriptOutput(output)`. Also make the command block
unconditional for script-ish output: `includeCommand: false` must not delete the
only record of what ran.

---

## Part 2 — Worktree setup produces no output

### Verified current behavior

```ts
// src/core/orchestration/WorktreeManager.ts:2111
private async runSetup(executionRoot, setup, vars): Promise<void> {
  const runner = new ScriptProcessRunner(executionRoot);
  const result = await runner.run({
    cwd: executionRoot,
    timeout: ConfigurationUtils.getScriptTimeoutMs(),
    argv: [command],
    vars,
    viaShell: true,
    // no onOutput
  });
  if (!result.success) throw new Error(result.error || `Setup exited with code ...`);
}
```

- **Nothing streams.** `ScriptProcessRunner` already supports `onOutput`
  (`ScriptProcessRunner.ts:15`, wired to `onStdout` at `:85`). `runSetup` simply
  doesn't pass one.
- **stdout is discarded outright.** Only `result.error` (trimmed stderr) reaches
  the thrown message. On success, the entire output of `npm ci` is dropped.
- **Nothing is persisted.** No CLI entry, no `events.jsonl` line, no
  `recordScriptExecution`. Only `setupOutcome: "pending" | "running" |
"succeeded" | "failed"` lands in the working file
  (`WorktreeManager.ts:2011-2042`).

Hence a 5-minute setup is 5 minutes of blank pane. Timeout is not the issue —
`execution.scriptTimeout` defaults to 3600s (`CtrlYokeSettings.ts:358`).

### Design: setup is a fourth script source

Everything needed already exists; this is plumbing, not new machinery.

**Contracts** (`DashboardConstants.ts`):

```ts
export const SCRIPT_OUTPUT_SOURCES = {
  SCRIPT_STEP: "script",
  PRE_CONDITION: "preCondition",
  END_CONDITION: "endCondition",
  WORKTREE_SETUP: "worktreeSetup", // new
} as const;

export const EXECUTION_PHASES = {
  PROMPT: "prompt",
  PRE_CONDITION: "preCondition",
  END_CONDITION: "endCondition",
  WORKTREE_SETUP: "worktreeSetup", // new
} as const;
```

Extend `getExecutionPhaseForScriptOutputSource` (`:2050`) and add
`TIMELINE_ATTEMPT_KINDS.SETUP` (`WorkflowTimelineTypes.ts:70`). Phase keying
through `getCliEntryKey` / `getStreamingChunkKey` / `findMatchingCliEntryIndex`
already keeps a fourth phase from colliding with step 0's own CLI entry — that
is exactly the collision the phase dimension was introduced to prevent.

**Target:** queue target index `0`, `runIndex 0`, `attemptIndex 0`, phase
`worktreeSetup`. Each new Run that re-provisions increments `attemptIndex`, giving
distinct setup-attempt headers the same way end-condition retries already work.

**Driving the reporter without a condition.** `ScriptExecutionReporter` already
takes an `evaluate?` override (`:78`, consumed at `:238`), so a plain script that
has no pass/fail semantics can drive the full placeholder → chunks → final
output → verdict sequence. Setup supplies:

```ts
properties: { script: command, compareSource: COMPARE_SOURCES.EXIT_CODE }
onPass:  CONDITION_ACTIONS.CONTINUE
onFail:  CONDITION_ACTIONS.STOP_WORKFLOW
evaluate: (onOutput) => runner.run({ ..., onOutput }).then(toEvaluationResult)
```

The verdict block then reads `✔ Passed · exitCode · expected 0 · actual 0 ·
continue · 4m12s` with no special-casing.

**Plumbing without a dashboard dependency in `WorktreeManager`.** The manager
must not learn about `IDashboardSink` or `OutputHistoryManager`; it is called
from discovery/recovery paths that have neither. Inject a port instead:

```ts
export interface WorktreeSetupRunner {
  run(args: {
    executionRoot: string;
    command: string;
    vars?: Record<string, string>;
    timeoutMs: number;
    attemptIndex: number;
  }): Promise<ScriptProcessResult>;
}
```

- Default implementation = today's direct `ScriptProcessRunner` call (CLI,
  tests, any headless caller).
- `WorkflowInstance` — which owns `dashboardSink`, `outputHistoryManager`, and
  `historyFilePath` — supplies a reporter-backed implementation when it calls
  `prepareExecutionWorktree` (`WorkflowInstance.ts:3617`).

Both `ensureManagedWorktree` and `resolveNamedWorktree` call it through the same
`runSetup` seam (`:2032`, `:2394`), so managed and named modes are covered once.

### The ordering problem this exposes

`executeLoadedPromptFile` currently runs:

```
1774  await this.ensureRunnerLock(workingFilePath);
1775  await this.prepareExecutionWorktree();     // ← setup runs here
1779  const integration = this.createIntegrationForMode(modeOverride);
1781  if (this.dashboardSink && totalSteps > 0) { ... updateExecutionStarted(...) }
```

Setup output published before that dispatch is not merely unattached — it is
**destroyed**. `EXECUTION_STARTED` is a destructive reset, not a notification
(`useMessageHandler.ts:906-922`):

```ts
// Fresh start
workflowStore.clearHistoryOutputs();
uiStore.clearHistoryView();
workflowStore.setPrompts(resetPrompts);
workflowStore.clearAllRuntimeState(); // ← wipes anything published before this
```

The history side is fine — `historyFilePath` is resolved earlier
(`:1649-1763`) and the run directory already exists — but the live view would be
empty, which is the exact symptom this change exists to fix.

### Decision: hoist only the fresh-start branch

The whole block cannot move. Two of its three branches pass
`integration.canReuseForInject()` as the `isInjectMode` argument, and the
integration must be constructed after the worktree remap (`:1777`). That
ordering is load-bearing, not stylistic:

```ts
// WorkflowInstance.ts:188
private canReuseExecutionIntegration(integration: HarnessIntegration): boolean {
  const identity = integration.getExecutionWorkspaceIdentity();
  return identity === undefined || identity === this.executionWorkspaceIdentity;
}
```

`this.executionWorkspaceIdentity` is assigned only by
`configureExecutionWorkspace()`, called from inside `prepareExecutionWorktree`.
"Can we reuse the previous run's live PTY?" is therefore undecidable until the
worktree resolves; hoisting the block would evaluate it against a stale identity
and silently reuse a PTY rooted in the wrong checkout.

The **fresh-start branch has no such dependency**:

```ts
this.clearOutputBuffers();
this.dashboardSink.updateExecutionStarted(
  this.id,
  fileName,
  totalSteps,
  undefined,
  undefined,
  undefined,
  executionMode
);
```

Hoist exactly that above `prepareExecutionWorktree` and leave the two
continuation branches untouched.

**⚠ Setup on continuation branches is now a normal path, not an edge case.**
An earlier draft of this plan justified the hoist by claiming `shouldRunSetup`
requires `origin === "created"`, so setup could only ever run on a fresh start.
That is no longer true — verify against the current code, which has two distinct
conditions:

| Site                                     | Condition (verified)                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| managed (`WorktreeManager.ts:2604-2606`) | `origin === "created" \|\| args.directoryRecreated`                        |
| named (`WorktreeManager.ts:2076-2078`)   | `origin === "created" \|\| namedSetupRecord?.setupOutcome !== "succeeded"` |

Commits `e5b8d79e` ("reprovision managed worktrees on append"), `53dace9f`, and
`8f927336` widened these deliberately: a managed append continuation
_recreates_ its directory and therefore _re-runs setup_. So setup routinely runs
on the append-continuation branch, where the `EXECUTION_STARTED` dispatch has not
yet fired.

The hoist is still correct and still the right scope — it fixes the fresh-start
case and must not drag the continuation branches along (see Risks). The
continuation case, however, could not be waved off as rare, so its live-render
behavior was determined rather than assumed. The relevant asymmetry:
the continuation branch of the webview handler is **not** the destructive reset.
It promotes history to live and calls `clearRuntimeStateFromStep(preserveStepCount)`
(`useMessageHandler.ts:~897`), which leaves runtime state for steps _below_
`preserveStepCount` — and setup publishes at step 0 — whereas the fresh-start
branch calls `clearAllRuntimeState()` and wipes everything.

The empirical result is that it **does survive**. A live step-0 entry published
before the continuation dispatch remains in `liveOrderedEntries` after the
handler promotes history, clears the history view, and calls
`clearRuntimeStateFromStep(preserveStepCount)`. The focused
`useMessageHandler` regression test covers that exact sequence. The handler only
clears runtime state at and after the preserved-step boundary; it does not wipe
the step-0 live entry, so no continuation-specific hoist is needed.

See [`../backlog/MANAGED_WORKTREE_APPEND_CONTINUATION_BUGS.md`](../backlog/MANAGED_WORKTREE_APPEND_CONTINUATION_BUGS.md)
— that path has correctness bugs independent of output rendering, and they
should be settled before this plan's Phase 4 assumes anything about when setup
runs.

### Accepted consequence: a failed preflight now wipes the view

After the hoist, a fresh start clears the dashboard and switches to live view
before we know the worktree can be provisioned. A lease conflict or setup
failure therefore discards whatever the user was looking at.

This is an improvement rather than a regression. `initializeRunAt` already ran at
`:1649`, so the run is promoted and its directory published on disk before
worktree prep — the run genuinely exists, and showing it as started-then-failed
is more honest than today's behavior, where a failed run leaves the dashboard
displaying the _previous_ run as though nothing happened. The dashboard leaves
`RUNNING` correctly on the failure path: the catch calls `workflowRuntime.fail()`
→ `onRuntimeTransition` → `updateExecutionState(ERROR)` (`:4279`). The setup
failure output and status message land on the failed run, where they belong.

### Re-run recovery path

There is no separate Retry Setup action. A failed setup leaves its durable named
worktree outcome as `failed` (or `running` if the host crashed), and the next Run
resolves the same directory and re-runs setup. A recorded `succeeded` outcome
skips setup. Setup output therefore belongs to the run that attempted it; a
later re-run records its own setup output in its own history rather than mutating
an earlier run outside execution.

---

## Part 3 — How setup errors are handled today

**Setup does not follow `errorBehavior`.** The full chain:

1. `runSetup` throws on non-zero exit or spawn failure
   (`WorktreeManager.ts:2126`).
2. The caller persists `lifecycleState: "blocked"`, `setupOutcome: "failed"`,
   and a `dirty` flag; releases runtime trust and the execution lease; then
   throws `WorktreeSetupError` (`:2035-2050`, mirrored at `:2399-2410`).
3. `prepareExecutionWorktree` propagates it.
4. `executeLoadedPromptFile`'s catch (`WorkflowInstance.ts:1900`) calls
   `finalizeFailedInFlightPrompt()` + `workflowRuntime.fail()`, settles a managed
   worktree if one was provisioned, releases the runner lock, finalizes the run as
   `EXECUTION_STATES.ERROR`, and emits **one status message**:
   `Execution failed: Worktree setup failed in <path>: <cause>`.

So: hard stop, run marked ERROR, no `onError` consultation. The recovery gesture
is pressing **Run** again; non-succeeded durable setup state makes that attempt
re-provision the worktree.

`errorBehavior` is a step-scoped property (`EXECUTION_PROPERTY_KEYS` in
`CtrlYokeTypes.ts:306`), resolved per step through the
prompt → workflow → settings chain. Setup runs before any step is in flight, so
there is no resolution context — the omission is structural, not an oversight.

### Recommendation: keep the hard block, fix the reporting

The `WORKTREE_SUPPORT_PLAN` policy still holds — `npm ci` and friends should not
be repeated after a known-good setup, and `onError: "continue"` would run the
whole workflow in a worktree that was never provisioned. Re-running only a
non-succeeded outcome preserves that boundary.

What is actually wrong is the reporting, and Part 2 fixes it: full stdout and
stderr in the output pane, streamed live, with an exit-code verdict row and a
persisted CLI entry. The one-line status message stops being the only artifact.

Two small follow-ons:

- State plainly in `schemas/workflow-schema.json` (`worktree.setup` description)
  and in the `errorBehavior` description that setup is outside the `errorBehavior`
  policy and fails to a blocked worktree; the next Run is the recovery gesture
  for non-succeeded setup.
- `WorktreeSetupError`'s message currently folds `result.error` (raw stderr) into
  its text. Once the full output is rendered above it, trim the message the way
  `summarizeStatusError` (`ScriptExecutionReporter.ts:89`) already trims condition
  summaries, rather than duplicating a stderr dump into a status row.

---

## Phasing

**Phase 1 — script-command row.** ✅ Complete. Row kind, builder branch,
renderer, border token, `estimateSize`, find segments, markdown export, and
regression coverage landed without Part 2.

**Phase 2 — setup contracts.** ✅ Complete. Added
`SCRIPT_OUTPUT_SOURCES.WORKTREE_SETUP`, `EXECUTION_PHASES.WORKTREE_SETUP`,
`TIMELINE_ATTEMPT_KINDS.SETUP`, and explicit source-to-phase mapping. The
consumer sweep found the exhaustive `HistoryCandidateExtractor` source map;
setup output is classified under the existing script history kind. No other
exhaustive consumers required changes. `getCliEntryKey`,
`getStreamingChunkKey`, and `findMatchingCliEntryIndex` retain the phase
dimension, so setup and prompt entries at `(step 0, run 0, attempt 0)` do not
collide. The timeline-adapter regression covers this, and `npm run typecheck`
passes.

**Phase 3 — execution-started ordering.** ✅ Complete. Hoisted the fresh-start
`updateExecutionStarted` dispatch ahead of `prepareExecutionWorktree`, leaving
the continuation branches in place. Regression tests cover both orderings and
the continuation handler's step-0 output preservation. This lands before Phase
4 so the live pane is populated for setup output.

**Phase 4 — setup through the reporter.** ✅ Complete. Added the
`WorktreeSetupRunner` port and default headless implementation, supplied a
reporter-backed runner from `WorkflowInstance` with live/history output and
exit-code verdicts, and added the setup header label/icon in `OutputRow.tsx`.

**Phase 5 — Re-run setup output.** ✅ Complete. Attempt-indexed setup entries stay
attached to the run that performs each attempt; no separate dashboard action is
required. Durable `failed`/`running` setup outcomes re-run on the next Run,
while `succeeded` skips setup. Regression coverage proves that two successive
runs write independent setup entries and that the earlier run's history is not
mutated.

---

## Testing

Webview (`src/ui/webview-react/test/**`):

- `outputRows.test.ts` — a script-ish `CliOutput` carrying both `prompt` and
  `cliCommand` produces exactly one command row and no prompt row; a harness
  output carrying both still produces two.
- Regression on a **recorded** output (prompt field populated, as pre-fix runs
  are) to prove the builder guard fixes history, not just new runs.
- `OutputRow` render test for `script-command`, including the `cwd>` prefix.
- `markdownExport` — no `### Prompt` block for any of the four script sources;
  the command block survives `includeCommand: false` for scripts.

Extension host (`src/test/**`):

- `scriptExecutionReporter.test.ts` — a `worktreeSetup` source emits
  placeholder → chunks → final output with an exit-code verdict, and records a
  `worktreeSetup`-phased CLI entry via `recordScriptExecution`
  (`ScriptExecutionReporter.ts:277`) keyed so it does not collide with step 0's
  prompt entry. A two-run regression verifies that each run gets its own
  attempt-indexed setup entry and that writing the second run leaves the first
  run's `events.jsonl` unchanged.
- `WorktreeManager` — `runSetup` delegates to the injected `WorktreeSetupRunner`;
  the default implementation preserves today's throw-on-failure contract; a
  failed setup still persists `blocked` / `failed` and releases the lease; the
  `WorktreeSetupError` summary is sanitized and capped without duplicating raw
  stderr.
- Timeline adapter — a `worktreeSetup` entry and a `prompt` entry at
  `(step 0, run 0, attempt 0)` both survive `getCliEntryKey` dedupe.

---

## Risks

- **Ordering regression.** The hoist must move the fresh-start branch only. If
  the continuation/append branches at `WorkflowInstance.ts:1781-1850` are dragged
  along, `canReuseForInject()` is evaluated against a stale execution-workspace
  identity and a PTY rooted in the wrong checkout can be reused. Cover this with
  a test that a continuation into a worktree run still dispatches _after_
  `prepareExecutionWorktree`.
- **Estimate drift.** `script-command` must not diverge from `cli-command`'s
  height estimate; share the body.
- **Setup volume.** A verbose `npm ci` persists its full stdout per attempt into
  `events.jsonl`. No cap is needed in this closure: setup output is the primary
  diagnostic artifact for a blocked worktree, and truncating it would need a
  broader retention/display policy than this reporting fix. `StreamingHistoryBuffer`
  still batches writes, while the existing unbounded history setting preserves
  the complete attempt. Revisit this as a separate history-volume policy if
  real-world setup logs make disk growth material.
