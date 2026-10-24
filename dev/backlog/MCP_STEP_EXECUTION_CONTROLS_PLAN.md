# MCP Step Execution Controls Plan

**Status:** In progress (2026-10-23). Items 0–3 landed; items 4–5 are queued.

**Related:**

- `dev/implemented/MCP_PARALLEL_APPEND_PLAN.md`, Decision 2: the MCP step
  surface is deliberately narrower than an authored step. This plan widens it
  on purpose, field by field, and keeps that decision's reasoning for
  everything it leaves out.
- `dev/bugs/implemented/mcp-edit-step-additional-args-can-widen-harness-permissions.md`:
  fixed in 895645b20, the prerequisite for stage 3 adding fields to
  `append_step`.
- `dev/bugs/backlog/headless-step-ends-silently-with-pending-background-work.md`
- `dev/backlog/SCRIPT_GENERATED_STEPS_PLAN.md`: deterministic step generation
  from a script, the non-agent route to queueing work.
- `dev/implemented/SUBAGENT_OUTPUT_ATTRIBUTION_PLAN.md`: the orchestrated run
  these lessons come from.

## Why

An orchestrator agent queues steps with `append_step` and corrects them with
`edit_step`, but it can only choose a step's prompt, name, harness, model and
session. Two gaps showed up in the subagent output attribution run (codex-cli,
headless, 28 steps):

1. **No way to pick the execution mode.** A step that has to wait on a long
   command, such as a 30-minute `npm run test:harness`, is better off
   interactive. There the TUI outlives the agent's turn and wakes it when the
   job ends. In headless mode the process exits with the turn and kills the
   job. `workflow_status` now reports each step's `executionMode` (ec85ade5f),
   but nothing can change it.
2. **No way to attach a gate.** Five of the first twelve steps ended their turn
   with uncommitted work and were marked completed. The orchestrator found out
   only by diffing the tree on its next review pass. An `endCondition` such as
   "the working tree is clean", with a retry prompt, would have caught each one
   right away. A `preCondition` such as "skip if this bug's file has already
   moved to `implemented/`" would make re-queued work idempotent.

## Today's state (verified 2026-10-23)

- `append_step` takes `prompt`, `name`, `model`, `harness`, `resumeSession` and
  `sessionId` (`MCP_APPEND_STEP_INPUT_SCHEMA`, `src/utils/McpToolDefinitions.ts`).
- `edit_step` takes those plus `agent`, `enabled`, `color`, `additionalArgs` and
  `skills` (`MCP_STEP_UPDATE_SCHEMA`). Neither takes `executionMode`,
  `endCondition` or `preCondition`.
- **Appended steps already inherit the workflow-level `endCondition` and
  `preCondition`** (`executionProperties` in `schemas/workflow-schema.json`), and
  a step can opt out with `null`. A workflow author can therefore gate every
  orchestrated step today by setting a workflow-level `endCondition` and putting
  `endCondition: null` on the orchestrator step. That is all-or-nothing: the
  orchestrator can't pick a gate per step.
- ctrlyoke MCP tools are auto-approved for the agents that get them; claude-cli
  gets `--allowed-tools mcp__ctrlyoke`, for example (`ClaudeCliProvider.ts`). Workflow-file
  scripts have no separate trust gate, because the user wrote the file.
  **Anything an agent can put in a condition's `script` therefore becomes a
  shell command run without the harness's own approval prompt.** This is the
  central constraint on stage 2.

## Stage 1: `executionMode` on `append_step` and `edit_step`

Add `executionMode` (`interactive` | `headless`, from `EXECUTION_MODES`) to the
append step schema and to `MCP_STEP_UPDATE_SCHEMA`. That gives `edit_step` and
`clearProperties` the field too. It is already a valid per-step field in the
workflow schema, so this needs no schema bump and is an additive MCP change.

Details:

- **Validation:** an enum check in the MCP schema validator. Don't reject a
  combination; the run decides what it can honour.
- **Warnings:** add an optional `warnings: string[]` to the `append_step` and
  `edit_step` results. This is additive to the envelope. Warn when:
  - the step resolves to codex-cli with `interactive`, because codex can't
    wait in the background in either mode;
  - the step is `interactive` in a run started from `ctrlyoke run` without a
    terminal, if the MCP server can learn that (see the open question below).
    `workflow_status` already shows the clamped mode once the step starts.
- **Parallel groups:** interactive members need concurrent interactive sessions
  (`supportsConcurrentInteractiveSessions`, `ParallelGroupPreflight.ts`). Cover
  an appended interactive parallel member with a test, and confirm that a host
  that can't run them concurrently fails or degrades the same way an authored
  group does.
- **Docs and templates:**
  - `docs/reference/mcp-tools.md`.
  - The `workflow-orchestrator` agent's `<longRunningCommands>` section: "set
    `executionMode: interactive` (and a non-codex harness) on a step that
    must wait for a long command".
- **Tests:** `src/test/unit/McpServer.test.ts`. Cover append with a mode, edit,
  clear back to inherit, the codex warning, and a parallel member.

Open question: can the MCP server learn the host's terminal capability? The
runner knows `hostCanProvidePty`. It could export it into the MCP server's
environment, for example as `CTRLYOKE_HOST_CAN_PROVIDE_PTY`, so `append_step`
can warn before the step runs rather than after.

## Stage 2: `endCondition` and `preCondition` through named presets

**Decision: agents choose gates; authors write the scripts.** The workflow root
gets an optional `conditions` map of named condition objects. The MCP tools
accept a preset's name, never a script:

```yaml
conditions:
  committed:
    script: git status --porcelain
    compareSource: stdout
    operator: isEmpty
    maxRetries: 2
    retryPrompt: |
      You left uncommitted changes. Finish the work, run the step's gate, and
      commit your own files with a plain conventional commit message.
      $endCondition:stdout
  typecheck:
    script: npm run typecheck
    maxRetries: 2
  bugStillOpen:
    script: test -f "dev/bugs/backlog/$BUG_FILE"
    params: [BUG_FILE]
    onFail: skipPrompt
```

```jsonc
// append_step step item
{
  "prompt": "...",
  "endCondition": {
    "use": "committed",
    "retryPrompt": "...optional override...",
  },
  "preCondition": { "use": "bugStillOpen", "params": { "BUG_FILE": "x.md" } },
}
```

The rules:

- **Fixed by the preset:** `script`, `env`, `shell`, `timeoutSec`,
  `compareSource`, `operator`, `expected`, `onPass` and `onFail`.
- **Overridable by the agent:** text and limits only. That means `retryPrompt`
  and `passRetryPrompt`, and `maxRetries` capped at the preset's own value.
  These are prompt text, which an agent can already write into a step.
- **`params` are the only agent data that reaches a script.** A preset declares
  `params`, and each value is passed as an environment variable. It is never
  spliced into the script text. Validate values (non-empty, a length cap, no
  NUL) and document that preset scripts must quote them (`"$BUG_FILE"`).
- **Materialize at append time.** The MCP layer resolves the preset and writes
  a plain `endCondition`/`preCondition` object onto the step, with an
  informational `preset` name if useful. This has three benefits:
  - the executor, history, dashboard and `ctrlyoke history show` need no
    changes;
  - the working file shows exactly what ran;
  - a later edit to the preset doesn't change steps already queued.
- **Param env merge.** The materialized condition's `env` is the preset's
  `env` plus one entry per param. A param whose name collides with a key the
  preset's own `env` sets is rejected when the preset is loaded, so an agent
  value can never replace an author-set variable.
- **Replacing an inherited gate.** Attaching a preset replaces a
  workflow-level `endCondition`/`preCondition` the step would otherwise
  inherit. That is acceptable because every preset is author-written, but say
  so in the `append_step` field description and the docs.
- **Built-in preset scripts must be cross-platform.** Templates run on
  Windows too, so `git status --porcelain` is fine but `test -f` is only an
  illustration; real template presets should use `git`/`npm`/`node`
  commands or the bundled `check_condition` helpers.
- **No `null` through MCP in the first cut.** An agent shouldn't be able to
  remove a gate the author made inherited. Revisit if a real use case appears,
  such as a docs-only step under a test gate. If it is added, make it an author
  opt-in.
- **Schema:** `conditions` is a new optional root field
  (`workflowOnlyProperties`), with `params` added to the condition definitions
  where a preset is declared.
  - An older ctrlyoke can safely ignore `conditions`: it only loses the MCP
    feature, and materialized steps are ordinary conditions. Per "Changing the
    schemas" in `CONTRIBUTING.md`, that is a **no-bump** change: edit the
    schema and run `npm run schema:update`.
  - Re-check that judgement against the archive rules before landing, because
    `params` on a condition is not ignorable when it appears on an authored step.
    Keep `params` legal only inside `conditions` entries, not on steps.
- **Built-in templates:** `spec-driven-loop`, `feature-driven-loop` and
  `bug-drain-loop` declare `committed` (and `typecheck` where the stack is
  known). Update the `workflow-orchestrator` agent to attach `committed` to
  every implementation step and to name the preset in its review.

### Rejected: agent-authored condition scripts

Letting `append_step` carry a raw `script` would let any agent with the
auto-approved ctrlyoke tools run arbitrary shell commands outside its harness's
permission model, and prompt injection from repository content could steer it
there. This is the reason `MCP_PARALLEL_APPEND_PLAN.md` left conditions and
script steps out. If demand appears later, the only acceptable form is a
workflow-level opt-in, such as `mcp.allowConditionScripts: true`, that the
dashboard shows on every step it affects. Don't build that unless asked.

## Stage 3: smaller improvements

None of these is covered by a filed bug.

1. **Align `append_step` with `edit_step` for `agent` and `skills`.** Today an
   orchestrator appends a step and then edits it to attach a skill. Add both to
   the append item. The `additionalArgs` bug is fixed and its audit confirmed
   these two fields cannot widen tool permissions (see item 0 below). Never
   add `additionalArgs` to `append_step`.
2. **Echo the effective settings in the append result.** For each added step,
   return the resolved `harness`, `model`, `executionMode`, `resumeSession` and
   (after stage 2) the materialized condition names. The orchestrator then sees
   what it queued without a second `workflow_status` call, and inheritance
   surprises surface immediately.
3. **Show per-step git outcome in `workflow_status`.** For a finished step, add
   the commits made during it (`HEAD` at start and end) and whether the tree
   was dirty when it ended. This is the cheapest way for a reviewer to spot a
   step that stopped short.
   - Investigate first: ctrlyoke may already record `HEAD` per step for
     workspace snapshots and undo. Reuse that, don't add a new git call per
     step.
   - Report it as data only. It must not fail a step; stage 2's `committed`
     preset is the enforcement.
4. **Workflow-orchestrator template guidance.** Add the planning lessons the
   template doesn't already have:
   - Never write "stop if an earlier item is unticked" guards into queued
     prompts. In the attribution run, one guard turned a single partial step
     into three idle ones. Have each step verify the code it builds on instead.
   - Verify a suspected bug with a failing test before fixing it in review. A
     review "fix" built on a wrong reading of the code broke working behaviour
     and was caught only because its test failed.
   - Gate sizing (narrow gates in steps, the full suite in review) and
     background waits were added on 2026-10-23; don't duplicate them.

## Implementation order

Each item is one session; tick it when it lands.

- [x] 0. Fix `mcp-edit-step-additional-args-can-widen-harness-permissions`
      (fixed in 895645b20; bug doc is in `dev/bugs/implemented/`). Its audit
      confirmed `agent` and `skills` cannot widen tool permissions: agent
      frontmatter `tools` is discarded by `AgentExpander.stripFrontmatter`,
      and agent/skill content is injected as prompt text only. Stage 3 item 1
      is unblocked.
- [x] 1. Stage 1: `executionMode` on `append_step`/`edit_step`, result
      `warnings`, docs, orchestrator template, tests.
      PTY capability remains an open question: the runner computes it in
      `resolveCliExecutionMode`, but does not export it to the MCP child.
      `ParallelGroupPreflight` applies the same interactive multiplex check to
      queued groups regardless of whether members were authored or appended.
- [x] 2a. Stage 2 schema: the `conditions` root field and `params` (legal only
      inside `conditions` entries), `schema:update`, the TypeScript types,
      parser validation, and the serializer/schema round-trip suites. No MCP
      behavior yet. No schema bump: `conditions` is optional and older hosts
      can ignore it as described by CONTRIBUTING.md. Preset names use
      `^[A-Za-z][A-Za-z0-9_-]*$`; `params` uses environment-variable names
      (`^[A-Za-z_][A-Za-z0-9_]*$`) and is legal only on a preset.
- [x] 2b. Stage 2 resolution: preset resolution and materialization in the MCP
      layer (`append_step` and `edit_step`), the override and parameter rules,
      `McpServer.test.ts` coverage, and the executor-level `committed` retry
      test. A `maxRetries` override above a finite preset limit is rejected
      with an error (presets with no limit allow only 0; `-1` remains unlimited).
      `clearProperties` cannot clear condition gates; attaching a preset
      replaces a workflow-level inherited gate, as described on the fields.
      User docs, templates, and CHANGELOG adoption are deferred to item 3.
- [x] 3. Stage 2 adoption plus stage 3 item 4: presets in the loop templates,
      orchestrator agent guidance (presets and the stage 3 item 4 lessons, which
      edit the same template), `docs/reference/mcp-tools.md` and a guide section
      on presets, and a CHANGELOG entry under **Added**.
- [x] 4. Stage 3 items 1–2 (append parity, effective-settings echo).
- [ ] 5. Stage 3 item 3 (per-step git outcome), after the investigation it
      names.

## Tests

- `src/test/unit/McpServer.test.ts`:
  - mode on append, edit and clear;
  - the codex warning;
  - an interactive parallel member;
  - preset resolution, with an unknown preset rejected;
  - `script`, `env` and `shell` overrides rejected at schema validation;
  - `maxRetries` capped;
  - `params` passed as environment and never spliced into the script;
  - an undeclared param rejected;
  - the materialized condition matches the preset at append time and doesn't
    follow later preset edits.
- `src/test/suite/**` schema and `WorkflowSerializer` round-trip suites: the
  new root field survives save, and the schema/UI property round-trip suite
  covers it (no opt-out entries, per `test.instructions.md`).
- An executor-level test that a materialized `committed` gate retries a step
  that left a dirty tree.
