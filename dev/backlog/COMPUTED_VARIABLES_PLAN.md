# Computed Variables Plan

**Status:** Proposed — **low priority.** Two existing mechanisms
(`$step:N`/`$previous` for script-step output, `$preCondition:stdout` for a
single per-step value) already cover most of the motivating cases with no code
changes; see the audit below before scheduling this. What remains uncovered is
narrow but real: inline substitution, composability into other syntax, and
names that survive step reordering.

**Related:** `dev/implemented/KEY_VALUE_ROW_EDITOR_PLAN.md` (the authoring
surface this lands in, now built), `USER_INPUT_STEP_PLAN.md` (the same "script produces a value the workflow
consumes" shape, for a human instead of a script),
`SCRIPT_GENERATED_STEPS_PLAN.md` (the same shape where the script produces
steps instead of a value)

## The ask

Reference a value in a prompt that a script computes at execution time:

```text
Analyze the newest log in {{latest_log}} and tell me what stalled.
Coverage is currently {{test_coverage_percent}}. Get it above 80%.
```

Today `vars` are static: authored in the workflow file or supplied by
`--var key=value` on the CLI. There is no way for a script to produce one.

> **Naming note, since it bites immediately.** The original phrasing of this
> ask used `{{latest-log}}`. That can never work: `VarSubstitutor`'s
> `PLACEHOLDER_RE` is `/\{\{(\w+)\}\}/g`, so a hyphen ends the match and the
> token stays literal in the dispatched prompt with only an after-the-fact
> advisory. Variable names must be `^\w+$` — `latest_log`, not `latest-log`.
> Catching that at authoring time is `KEY_VALUE_ROW_EDITOR_PLAN.md`'s job.

## What already works today (and where it runs out)

Before adding anything, three existing mechanisms were audited against the ask.

### 1. `$preCondition:stdout` — already does this, for one value on one step

This is the closest existing primitive and it is genuinely usable **today, with
no new code**:

```yaml
- prompt: Analyze the newest log at $preCondition:stdout
  preCondition:
    script: node scripts/latest-log.mjs
```

`CliPromptPreparer.planPrompt` (`src/core/harness/shared/CliPromptPreparer.ts:135`)
calls `substituteConditionOutputRefs` against
`workflowContext.preConditionResult` before the prompt is assembled, so the
step's own pre-condition stdout is substituted into the prompt text that gets
dispatched. A pre-condition with no `returns` passes on exit code 0
(`EndConditionEvaluator.ts:188`, `:951`), so a script that just prints a value
and exits cleanly always passes the gate. Available fields are
`RETRY_PROMPT_PLACEHOLDERS`: `stdout`, `stderr`, `expected`, `actual`,
`exitCode`, `compareSource`.

Where it runs out — all four of these are the actual gap, not style
complaints:

- **One value per step, per phase.** There is exactly one `preCondition` and
  one `endCondition`. `{{latest_log}}` _and_ `{{test_coverage_percent}}` in the
  same prompt is not expressible.
- **Not named.** `$preCondition:stdout` says where the value came from, not
  what it is. A prompt reading `Analyze $preCondition:stdout` is materially
  worse to author and to review than `Analyze {{latest_log}}`.
- **Not reusable across steps.** Ten steps referencing the same value need ten
  pre-conditions running the same script ten times — and possibly getting ten
  different answers if the underlying fact moves (a log rolls over, coverage
  changes) when the author expected one stable value for the run.
- **Coupled to gating.** A pre-condition is a gate: it defaults to
  `onFail: skipPrompt` and renders as a validation phase on the timeline.
  Using it purely as a value channel means authoring a script that must never
  fail and reading a timeline that describes it as validation.

**Recommendation: keep it, document it, don't extend it.** For a single value
on a single step it is the right answer and needs nothing. Do not grow it into
a general value channel (e.g. by adding more `preCondition` slots) — that would
be reinventing named variables inside a gate.

### 2. `$previous` / `$step:N` — script output **is** included; works today for the common case

Prior context is not AI-responses-only. `RunOutputResolver.resolvePriorContextItems`
has an explicit `isScriptStep(step)` branch (`:850-865`) that builds the item's
text from the script's `stdout`/`stderr`/`exitCode`, and
`buildPriorContextXmlFromItems` (`src/core/HarnessIntegration.ts:127-139`)
emits a dedicated block for it:

```xml
<priorContext>
  <step index="1" type="script" name="Measure coverage">
    <command>node scripts/coverage-pct.mjs</command>
    <stdout>78.4</stdout>
    <exitCode>0</exitCode>
  </step>
</priorContext>
```

`$previous` has no type filter either — it takes the last resolved queue item
among the candidates (`:874-879`), so when the previous step is a script step,
`$previous` resolves to that script's output.

**So this pattern works today, with no code changes:** put a script step at
index 1 that prints the value, then reference `$step:1` from every later
prompt. For a prompt like "coverage is currently X, get it above 80%", that is
a complete solution and nothing in this plan is needed.

Where it still falls short of the ask — these are differences in kind, not
polish:

- **It is context injection, not substitution.** The `$step:1` token is not
  replaced by the value; the token stays in the prompt text and the XML block
  is attached alongside it. So you cannot compose the value into other syntax:
  `@$step:1` does not become an `@path` reference to the path the script
  printed, and a computed value cannot flow into `model`, `additionalArgs`, a
  hook command, or a condition script the way `{{name}}` does.
- **The payload is a block, not a value.** stdout _plus_ stderr _plus_ exit
  code _plus_ the command text. A script that logs anything to stderr puts that
  noise in every prompt that references it.
- **References are positional.** `$step:1` breaks the moment a step is inserted
  above it — across every prompt that used it. A name does not.

**Recommendation: document this as the no-code answer and keep it.** It covers
more of the ask than first assessed, which is a genuine argument for
de-prioritizing this whole plan — but not for closing it, because the three
limitations above are exactly what named variables exist to fix.

### 3. `CTRLYOKE_VAR_*` — one-directional

`ScriptProcessRunner.ts:79-81` exports every var into every script/condition
process as `CTRLYOKE_VAR_<KEY>`. Scripts can **read** variables; nothing writes
back. That asymmetry is the whole feature request.

---

## Recommendation

**First: do nothing, and document the two mechanisms above.** A script step
plus `$step:N` covers "let the model see a computed value" completely, and
`$preCondition:stdout` covers a single inline value on a single step. Neither
is discoverable today — that is a docs gap, not an engine gap, and it is the
highest-value thing on this page.

If the remaining limitations are actually felt — inline substitution,
composability into `@path`/`model`/hook commands, and stable names — ship the
two phases below, cheapest and most explicit first. **Phase 1 alone closes the
naming and reuse gap; Phase 2 is only for the no-queue-step case.**

### Phase 1 — `scriptStep.setVar` (recommended first)

Add one optional field to the existing script step:

```yaml
- type: script
  name: Measure coverage
  script: node scripts/coverage-pct.mjs
  setVar: test_coverage_percent
```

The step's trimmed stdout is stored in the run's variable map under that name;
every later step substitutes `{{test_coverage_percent}}` through the existing
`VarSubstitutor` path — meaning it works in prompt text, `model`,
`additionalArgs`, hook command/env, pre-/end-condition `script`/`env`, retry
prompts, and worktree setup, with zero new substitution code.

Why this first:

- **No new execution point.** The script already runs, at a known place in the
  queue, with the timeout/shell/env/secrets/`executionMode` controls
  `scriptStep` already has (`schemas/workflow-schema.json` → `scriptStep`). The
  only new behavior is "keep the stdout under a name".
- **No new failure policy.** A capture script that fails is a script step that
  failed, handled by the existing `returns`/`compareSource`/`onFail`/
  `errorBehavior` machinery. Nothing new to design.
- **Visible.** It is a real timeline entry with real output, not an invisible
  side effect of prompt rendering. When the value is wrong, there is somewhere
  to look.
- **Small.** Schema field, a mutable run-scoped var map, one write at step
  completion, and the `vars` read sites already listed below.

Cost: it needs a queue step, so it cannot serve a one-off single-step prompt,
and it cannot be referenced by a step _before_ it.

### Phase 2 — computed `vars` entries (only if Phase 1's gap is felt)

Widen `varsConfig` values from `string` to `string | { script: ... }`:

```yaml
vars:
  branch: main # literal — unchanged
  latest_log:
    script: node scripts/latest-log.mjs
    scope: step # step (default) | run
    timeout: 5000
    onError: literal # literal (default) | empty | fail
```

- **Lazy, and only when referenced.** A computed var whose name never appears
  in a step's substitutable fields must not spawn anything. Otherwise every
  workflow pays for every declared var on every step.
- **`scope: step` default, `scope: run` opt-in.** Both the motivating examples
  (newest log, current coverage) want freshness, so per-step is the right
  default; `run` caches the first evaluation for facts that must not move
  mid-run (a ticket id, a timestamp).
- **`onError: literal` default.** Matches the existing contract for
  unresolved placeholders — `VarSubstitutor` leaves them literal and the
  execution layer reports an advisory — and matches
  `PROMPT_DIAGNOSTIC_CODES.CONDITION_OUTPUT_UNAVAILABLE`'s
  warning-not-failure precedent for `$preCondition:*`. `fail` is available for
  authors who would rather stop than dispatch a prompt with a hole in it.

Phase 2 is strictly more machinery than Phase 1 for strictly less visibility,
which is why it is second and conditional.

---

## Constraints found while scoping (read before implementing either phase)

**Parallel groups freeze variables at preflight.**
`ParallelGroupPreflight.ts:136` does `Object.freeze({ ...(workflow.vars ?? {}) })`
once per group and hands each member that frozen snapshot;
`WorkflowExecutor.ts:1350-1352` then deliberately skips the ordinary
`VarSubstitutor.applyToResolvedProperties` call for preflight members because
substitution already happened against that snapshot. So:

- A **Phase 2** var cannot be evaluated lazily per member — that would produce
  a different value inside a group than the frozen plan promised, and the
  preview (`ExecutionPreviewService`) would disagree with the run. Computed
  vars referenced by any group member must be resolved **once, before
  preflight**, and folded into the snapshot. Document that group members share
  one evaluation regardless of `scope`.
- A **Phase 1** `setVar` written by a step _inside_ a parallel group is worse:
  members run concurrently and the group's snapshot is already frozen, so the
  write would be invisible to peers and racy. Recommend rejecting `setVar` on a
  step inside a parallel group at parse/validation time rather than defining a
  race.

**The var map is currently read-only and read from the prompt file.** Every
read site takes `workflowFile.vars` directly (`WorkflowExecutor.ts:1350`,
`:1602`, `:3876`; `WorktreeManager.ts:2597`; `cli.ts:681`). Phase 1 needs one
run-scoped mutable overlay layered over it, resolved in the same precedence
order the docs already state (CLI `--var` > file `vars`), with captured values
slotting between them: **CLI `--var` > captured/computed > file `vars`** so an
explicit `--var` still wins, which is what "override" means today.

**Persistence.** A captured value belongs in the run's `_runtime` state, not
written back into the workflow definition — the definition is the authored
input and must stay reproducible. Run history should record what each computed
var resolved to, or debugging "why did the model get that path" is impossible.

**Security posture.** Neither phase introduces a new capability class: scripts
already run from workflows via script steps, conditions, hooks, and worktree
setup, and both phases reuse `ScriptProcessRunner` (VS Code env scrubbing,
timeout, shell resolution, secret redaction). Phase 2 does introduce a new
_trigger_ — a script running as a side effect of a prompt referencing a name —
which is worth an explicit note in docs and worth checking against
`EXECUTION_GUARDRAILS_PLAN.md`'s `execution.scriptTimeout` budget before
implementing.

## Affected areas (sketch, Phase 1)

| Area                                             | Change                                                        |
| ------------------------------------------------ | ------------------------------------------------------------- |
| `schemas/workflow-schema.json`                   | `scriptStep.setVar` (string, `^\w+$`)                         |
| `src/types/CtrlYokeTypes.ts`                     | `ScriptStep.setVar`                                           |
| `src/core/WorkflowExecutor.ts`                   | Run-scoped captured-var overlay; write on script-step success |
| `src/core/orchestration/ScriptProcessRunner.ts`  | Nothing — stdout is already captured                          |
| `src/core/ParallelGroupPreflight.ts`             | Reject `setVar` inside a parallel group                       |
| `ScriptConditionEditor.tsx` (scriptStep variant) | "Set variable" field                                          |
| Run history / `_runtime`                         | Record the captured value                                     |

## Non-goals

- Structured extraction from stdout (JSON path selection, regex capture). The
  script can print exactly the value it wants; adding a selector language here
  buys little and has to be designed, documented, and validated.
- Letting an **AI step** set a variable from its response. That is a much
  larger trust question (a model choosing a value that then flows into a
  script's `env` or a shell command) and should not ride along with this.
- Extending `$preCondition:*` into a general value channel — see the audit
  above.
- Any change to the `{{name}}` syntax itself, or to the `^\w+$` name rule.
