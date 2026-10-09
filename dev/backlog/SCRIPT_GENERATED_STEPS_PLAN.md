# Script-Generated Steps Plan

**Status:** Proposed

**Related:** `COMPUTED_VARIABLES_PLAN.md` (the value-producing sibling of this
plan: a script that produces a `{{var}}` instead of steps),
`dev/rejected/TEMPLATE_SETUP_SCRIPTS.md` (create-time generation, rejected),
`CLI_DISTRIBUTION_PLAN.md` (the `bin/` launcher this plan puts on script PATH)

## The ask

Generate a workflow's steps from a script at run time. The motivating case is
a folder of bugs: ten files in `dev/bugs/backlog/` should become ten steps, each
saying "fix the bug in @dev/bugs/backlog/<file>, add tests, move it to
implemented/, commit".

Today the only way to do this is an AI step with the ctrlyoke MCP server that
calls `append_step` (`.ctrlyoke/templates/bug-drain-loop.ctrlyoke.yaml`). That
is the right tool when deciding how to group and order the work takes judgment.
It is the wrong tool when the mapping is mechanical, such as one file to one
step: it costs a model turn per pass, isn't deterministic, and can paraphrase
the step text it was asked to queue.

## What exists today

| Surface                                     | Mutates a live run?                                                                                                                                                                                                                                                       | Usable from a script step?                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| MCP `append_step`                           | Yes. It calls `validateContinuationTarget(..., "append", true)`, which allows an active target operation.                                                                                                                                                                 | No. It needs an MCP client.                                |
| `ctrlyoke step edit` / `remove` / `reorder` | Yes. `StepCommands.ts` validates as `"edit"` with `allowActiveTargetOperation = true`.                                                                                                                                                                                    | Yes, but there is no `add`.                                |
| `ctrlyoke append`                           | No. `validateCliContinuationTarget` validates as `"continue"` with `allowActiveTargetOperation = false`, so a run whose lock names it is refused. It also _executes_ the appended steps (`executeContinuationAtRun`), which is wrong for a run that already has an owner. | No.                                                        |
| Writing `workflow.ctrlyoke.json` directly   | Unsafe; see below.                                                                                                                                                                                                                                                        | Technically. Script steps receive `CTRLYOKE_WORKING_FILE`. |

The engine already supports out-of-process mutation of a live run. Every
`RunContinuationService` mutation writes the run file under `withFileLock` with
a `definitionRevision` check. The executor re-reads and merges the on-disk
definition under the same lock whenever a queue step settles
(`PromptQueue.commitStepOutcomeAndAdvance` → `mergeDiskDefinition`), and the
file watcher merges in between (`PromptFileLoader` "Scenario 2"). Steps appended
by any process before a **queue** script step exits are therefore picked up
deterministically when that step settles. A **final** step has no such merge
point; see "Final-step merge" below. The pieces still missing are a
script-callable _add_, the `ctrlyoke` launcher on the script's PATH, and that
final-step merge.

### Final-step merge (prerequisite)

The final-step loop decides whether a pass appended work by comparing
**in-memory** queue sizes: `queueSizeBefore` (`WorkflowExecutor.ts` ~745)
against `queueSizeAfter` (~793). There is no explicit re-read of the run file on
this path:

- `PromptQueue.commitStepOutcomeAndAdvance`, the locked re-read + merge, returns
  early for non-queue targets.
- After a successful final step, no runtime write happens before the check.
  `writeQueueState` merges disk steps on every non-`skipMerge` write, but
  `elapsed` is persisted only for queue targets (~2367 prompt, ~2819 script).
  The next final-step write is the `setFinalStepRuntime` at ~823, after the
  decision.
- So the only merge source is the asynchronous watcher/poller
  (`WorkflowInstance.setupPromptFileWatcher` →
  `PromptFileLoader.reloadFromWorkingFile`). For user-scoped run files outside
  the workspace, that is a 1 s `setInterval` poll (`PromptFileWatcher`).

MCP appends from AI final steps work today because of timing: the model keeps
writing its summary for seconds after its last `append_step`, so the poll
usually merges first. A script final step that calls `step add` and exits
immediately would often lose that race. The workflow would then end with the
appended steps stranded as pending steps of a completed run. This is filed as
`dev/bugs/backlog/final-step-loop-decision-misses-unmerged-external-appends.md`
and **must be fixed before Phase 1 ships**: merge the on-disk definition under
the working-file lock before reading `queueSizeAfter`, mirroring
`commitStepOutcomeAndAdvance`. `forEach` (Phase 2) should append before that
merge point, or update the in-memory queue as part of its own append. A
disk-only append would hit the same gap.

### Why not edit the working file directly

The run file is the engine's state, and the engine rewrites it constantly
(`updateWorkingFileDirect` on every progress/settle). A raw `fs.writeFile` from
a script:

- **Loses updates.** It takes no lock, so it races the engine's next full-file
  write, and either side can silently erase the other's change.
- **Skips the revision protocol.** `definitionRevision` isn't advanced, so
  dashboards and other writers can't tell the definition changed.
- **Skips validation and normalization.** That includes schema validation, the
  `maxSteps` budget, parallel-group topology normalization, `stepId`
  assignment, and the secret-grant approval check `ctrlyoke append` performs.

`ctrlyoke step add` is the supported version of "just edit the working file":
the same file write, done through the transaction that already guards every
other writer.

## Recommendation

### Phase 1: `ctrlyoke step add` (the primitive)

Add a fourth subcommand to the existing non-executing `step` group
(`src/cli/StepCommandDefinitions.ts`, described there as commands that "mutate a
named run's pending steps"):

```text
ctrlyoke step add [file] [--prompt <text>] [--position next|end|<index>]
                  [--workflow <key> --run <ref>] [--json]
```

- **Input.** Same as `step edit` and `append`: a file of one or more steps
  (YAML/JSON, parsed and validated against `workflowStep` by the existing step-file
  parser), or `--prompt` for a single prompt step. Add `-` for stdin so a script
  can pipe generated YAML without a temp file.
- **Implementation.** `RunContinuationService.appendStepsToRun` after
  `validateContinuationTarget(..., "append", true)`, exactly what MCP
  `append_step` does. Do not fork the path. Factor out whatever MCP does
  beyond that call (harness/model capability validation, position parsing,
  parallel-item flattening) so both callers share it.
- **Default target is the calling run.** `--workflow`/`--run` become optional
  when `CTRLYOKE_WORKING_FILE` is set. The run is resolved from that path the
  same way the MCP server's `resolveRun` does. With neither flag nor env, error
  out as `step edit` does today.
- **Settled runs.** Allowed, as with `step edit`: the steps wait for a later
  `ctrlyoke continue` / dashboard Run. The CLI caller can start the run
  afterwards, which is exactly why `assertRunAcceptsMutation` exempts it.
- **One call is one transaction.** A script should collect its steps and call
  `step add` once. A script that adds, then fails, leaves its steps queued;
  document that rather than inventing rollback.

Plumbing:

- **Put the launcher on script PATH.** `ScriptProcessRunner` builds its own
  `cleanEnv` and does not call `withCtrlyokeBinOnPath`; only harness spawns
  (`CliProviderUtils`, `PtyProcessManager`) do. Apply it to script steps,
  conditions and hooks too, so `ctrlyoke step add` inside a script reaches the
  same ctrlyoke version that is running the workflow.
- **Attribute the steps to the step that added them.** Script steps should
  receive `CTRLYOKE_PROMPT_INDEX` (and the final-step equivalent) as harness
  steps do, so `step add` can record which step queued them, matching how
  `append_step` results render on the timeline.

### Phase 2: `forEach` on script steps (the mechanical case, no YAML)

Most generators are "one step per line of output". Writing a script that emits
step YAML and pipes it to `step add` is boilerplate for that case. Add an
optional step template to script steps:

```yaml
- type: script
  name: queue-bugs
  script: node .ctrlyoke/scripts/list-backlog.mjs # one path per line
  forEach:
    name: "fix {{item}}"
    prompt: |
      Fix the bug in @{{item}}. Add or update tests and pass `npm test`.
      git mv it to dev/bugs/implemented/, replace its Severity line with
      "Resolution: fixed in this commit", and commit.
```

- **Semantics.** On success (the existing pass/fail evaluation), each trimmed,
  non-empty stdout line becomes one step from the template. The steps are
  appended through the same shared append path as Phase 1, in one transaction,
  after the step settles. On failure nothing is appended. That gives `forEach`
  the all-or-nothing guarantee a hand-written script only gets by calling
  `step add` once.
- **Substitute at generation time.** `{{item}}` and `{{itemIndex}}` are filled
  in when the steps are created, so the queued steps show concrete paths in the
  dashboard and run history. Other `{{vars}}` stay as placeholders and resolve
  at execution time as usual. Reject a workflow whose `vars` defines `item` or
  `itemIndex`.
- **The template is a `workflowStep`.** It can be a prompt or a script step
  with full execution properties (`harness`, `model`, `skills`,
  `endCondition`, ...), and it inherits workflow defaults like any appended step.
- **Not inside a parallel group.** Reject `forEach` on a group member at
  validation time, for the same reason `COMPUTED_VARIABLES_PLAN.md` rejects
  `setVar` there.

### The bug-drain loop, rebuilt

`finalStep` can already be a script step (`finalStep` is a `workflowStep`), so
the drain loop becomes deterministic. The loop already ends on the first pass
that appends nothing; a generator that prints zero lines appends nothing.

```yaml
steps: []
finalStep:
  type: script
  name: queue-backlog
  script: node .ctrlyoke/scripts/list-backlog.mjs
  forEach:
    name: "fix {{item}}"
    prompt: |
      Fix the bug in @{{item}} ...
```

The AI review pass the current template does in section 1 can be kept as a
step the generator itself queues. A script calling `step add` can add the fix
steps and then one review prompt step at the end. Keep the AI orchestrator for
backlogs where grouping and ordering need judgment. The two approaches
complement each other.

**Runaway loops.** If a fix step finishes without moving its bug doc, the next
pass emits the same line again, forever. `maxSteps` is the backstop and
already counts every appended step. The generator should also skip work this
run already attempted: it can read `CTRLYOKE_WORKING_FILE` (reading is safe)
or `ctrlyoke history steps`. Whether `forEach` should offer a built-in
`skipExisting` (match on the generated `name`) is an open question below.

## Rejected alternatives

- **A `CTRLYOKE_STEPS_OUT` file the engine reads when the script exits.**
  Proposed in the brainstorm that led to this plan. It solves no security
  problem: script steps already run with full workspace access and already
  receive `CTRLYOKE_WORKING_FILE`, and MCP "attestation" is an accuracy signal,
  not a boundary (`ATTESTATION_NOTICE` in `mcp-server.ts`). What it would have
  bought, and where that comes from instead:
  - All-or-nothing on script failure → one `step add` call, or `forEach`.
  - No dependency on a `ctrlyoke` binary → launcher on script PATH.
  - Engine-side attribution → `CTRLYOKE_PROMPT_INDEX` in script env.

  The CLI also helps humans, external tools and long-running scripts that want
  to queue work mid-run. A file read at exit cannot do that.

- **Making `ctrlyoke append` accept a live run.** `append` means "add and
  execute"; it binds an executor. Letting it silently skip execution for a run
  that already has an owner overloads one command with two contracts. Keep
  `append` as "continue a settled run with more steps" and `step add` as the
  non-executing queue edit.
- **Requiring scripts to use MCP `append_step`.** It needs an MCP client in
  every script language, for the same transaction the CLI already exposes.
- **Template setup scripts** (`dev/rejected/TEMPLATE_SETUP_SCRIPTS.md`). They
  generate at workflow creation, which freezes a list a drain loop needs to
  re-read every pass. The trust objection that got them rejected doesn't apply
  here: a generator is a script step authored in the workflow, so it carries the
  same trust as any script step, condition or hook.

## Open questions

- `forEach.skipExisting`: dedupe on the generated step `name` against steps
  already in this run, or leave dedup to the script?
- `forEach.parallel: true`: append the generated steps as one parallel group?
  `appendStepsToRun` already accepts a `ParallelGroupTopology`.
- Should `forEach` accept JSON lines (one object per line, fields exposed as
  `{{item.field}}`)? The `^\w+$` var-name rule excludes dots, so this needs
  its own token syntax; deferred unless the one-string-per-line form proves too
  thin.
- ~~Does the final-step path merge the on-disk definition under lock before
  deciding whether the pass appended anything?~~ **Answered: no.** It relies on
  the asynchronous watcher/poller. See "Final-step merge (prerequisite)" above
  and `dev/bugs/backlog/final-step-loop-decision-misses-unmerged-external-appends.md`.

## Affected areas (sketch)

| Area                                                           | Change                                                                       |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/core/WorkflowExecutor.ts`, `src/core/PromptQueue.ts`      | Prerequisite: locked disk merge before the final-step `queueSizeAfter` check |
| `src/cli/StepCommandDefinitions.ts`, `src/cli/StepCommands.ts` | `step add`; optional `--workflow`/`--run` via `CTRLYOKE_WORKING_FILE`; stdin |
| `src/mcp-server.ts` (`append_step` handler)                    | Extract shared validation/flattening so CLI and MCP share one path           |
| `src/core/orchestration/ScriptProcessRunner.ts`                | `withCtrlyokeBinOnPath`; step-index env for attribution                      |
| `schemas/workflow-schema.json`                                 | `scriptStep.forEach` (Phase 2); `npm run schema:update`                      |
| `src/types/CtrlYokeTypes.ts`                                   | `ScriptStep.forEach`                                                         |
| `src/core/WorkflowExecutor.ts`                                 | Expand `forEach` and append on script-step success                           |
| `src/core/ParallelGroupPreflight.ts`                           | Reject `forEach` on group members                                            |
| `ScriptConditionEditor.tsx` (scriptStep variant)               | "For each output line" template editor                                       |
| `src/templates/workflows/`                                     | A deterministic bug-drain template alongside the AI one                      |
| Docs                                                           | `step add` CLI reference; generator-step guide; the runaway-loop note        |

## Tests

- A final step that appends through `RunContinuationService.appendStepsToRun`
  and returns immediately, with no file watcher: the loop runs the appended step
  and then runs the final step again (covers the prerequisite bug fix).
- `step add` against a live run: steps appear in the executor's queue at the
  next settle, `definitionRevision` advances, `maxSteps` is enforced.
- `step add` with no flags inside a script step resolves the calling run; with
  neither flags nor env it errors.
- `step add` from a script step finds the launcher on PATH.
- `forEach`: zero lines appends nothing and ends a final-step loop; a failing
  script appends nothing; `{{item}}` is substituted at generation and other
  vars are not; `vars.item` is rejected; a group member with `forEach` is
  rejected.
