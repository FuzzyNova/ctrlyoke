# MCP tools

ctrlyoke's built-in MCP server gives a harness tools to inspect and adjust the run it belongs to. Enable it with `mcpServers: ["ctrlyoke"]` on a workflow or step — see [Dynamic workflows](/workflows/dynamic-workflows).

## How the server is scoped

- **One run per server.** ctrlyoke starts the server for each harness launch and pins it to the executing run. No tool takes a workflow or run address, so a tool can never act on another workflow by mistake. Responses still report the resolved `workflowKey` and `runRef`.
- **No lifecycle control.** No tool starts, stops, pauses, or resumes a run.
- **Every call does what it says or returns an error.** An error result (`isError: true`, text starting `Error:`) means nothing was changed.
- **Queue changes need a live run.** `append_step`, `edit_step`, `remove_step`, and `reorder_steps` are refused unless the run is running, pausing, or paused. They are refused while a run is cancelling, because Stop discards the current step's outcome.
- All responses are a single text block containing JSON.

## Tool list

| Tool                    | Purpose                                                    | Parameters                                                  |
| ----------------------- | ---------------------------------------------------------- | ----------------------------------------------------------- |
| `workflow_status`       | The run's steps, their status, and run metadata            | none                                                        |
| `append_step`           | Add steps or parallel groups to the run                    | `steps` (required), `position` (required), `source`         |
| `edit_step`             | Change a pending step's prompt or configuration            | `index` (required), `updates` (required), `clearProperties` |
| `remove_step`           | Remove a pending step                                      | `index` (required)                                          |
| `reorder_steps`         | Reorder the pending steps                                  | `indices` (required)                                        |
| `list_harnesses`        | Installed harnesses and the models each supports           | none                                                        |
| `read_output`           | Read output from earlier steps                             | `indices`, `cursor`, `limit`, `tail`                        |
| `global_status`         | List executing workflows in the workspace                  | `workflowKey`, `runRef`                                     |
| `post_note`             | Post a coordination note for other participants            | `text` (required), `to`                                     |
| `read_notes`            | Read coordination notes                                    | `since`, `from`                                             |
| `claim_paths`           | Advisory claim on files before editing them                | `paths` (required), `reason`                                |
| `release_paths`         | Release your path claims                                   | `paths`                                                     |
| `submit_commit_message` | Submit a generated commit message (commit generation only) | `message` (required)                                        |

Step indices are **zero-based** everywhere in these tools, except `sessionId` inside a step, which is a 1-based step number like in workflow files.

## `workflow_status`

Returns `workflowKey`, `runRef`, a `metadata` object, and `steps`.

- `metadata`: `workflowName`, `harness`, `model`, `resumeSession`, `executionMode` (`interactive` or `headless`), `currentIndex`, `totalSteps`, `completedSteps`, `executionState`, `maxSteps` and `remainingSteps` (numbers; `-1` means unlimited), `conditionPresets`, `worktreePresets`, `workingFile`, `runDirectory`, `definitionRevision`, `descriptorRevision`. The limit fields report the effective cap after applying the workflow's `maxSteps` override to the global `queue.maxSteps` setting; `remainingSteps` is based on the current total step count.
- `metadata.conditionPresets` lists every [condition preset](/workflows/end-conditions#condition-presets) the workflow declares, in order, as `{ name, script, params, maxRetries }`. `script` is the first line of the preset's script. `params` names every param the caller must supply. `maxRetries` is the preset's retry limit (`-1` means unlimited), which a caller's own `maxRetries` cannot exceed. The list is empty when the workflow declares no presets.
- `metadata.worktreePresets` lists every [worktree preset](/workflows/sub-workflow-steps#agent-queued-lanes) the workflow declares, in order, as `{ name, merge, setup }`. `merge` says whether a lane's branch merges back into this run's checkout when it finishes. `setup` is the first line of the preset's setup command, or `""` when it has none. An empty list means the workflow declares no presets, so `append_step` cannot queue lanes.
- `steps[]`: `index`, `prompt` for prompt steps, or `type: "script"` and `script` for script steps, `status` (`completed`, `failed`, `cancelled`, `skipped`, `noTurnStarted`, `running`, or `pending`), `resumeSession`, `sessionId`, and `harness`, `executionMode` and `model` for prompt steps. The workflow-level `harness`, `model`, `resumeSession` and `executionMode` are what an appended step inherits. A step that has started reports the harness and mode it actually ran with. A `ctrlyoke run` without a terminal runs interactive steps headless, for example. A pending step reports its configured value.
- A workflow step, including a lane queued with `worktree`, has `type: "workflow"` and, once its child run exists, `childRun` with the child's `workflowKey` and `runRef`. While the child runs, `childRun` also has the child's `executionState` and, for a lane, `worktree` with its `mode` and `branchName`. Once the child settles, `childRun` has `outcome` instead: its `status`, and for a lane its `worktree` record with `branchName`, `finalBranchTip`, `landingOutcome` and `mergeOutcome` (`fast-forward`, `merge-commit`, `conflict` or `blocked`, for example). Pass `childRun` as `run` to `workflow_status` or `read_output` to inspect the child itself.
- Finished prompt steps may include `gitOutcome` when git snapshots are available. `repositories` lists `headAtStart`, `headAtEnd` and `dirtyAtEnd` for each captured repository; top-level `dirtyAtEnd` is present only when every workspace root had a successful git status capture. This is advisory data and is omitted when unavailable, including filesystem snapshots and unfinished steps.

A headless step cannot wait for background work: the harness process, and anything it started, exits when the agent ends its turn. Prompts queued for headless steps should run long commands in the foreground or poll until they finish. Codex cannot wait on background work in interactive mode either.

## `append_step`

- `steps`: one or more queue items, in order. Each item is either a step or a future parallel group.
  - A prompt step takes `prompt` (required), `name`, `model`, `harness`, `agent`, `skills`, `executionMode` (`interactive` or `headless`), `endCondition`, `preCondition`, `worktree`, `resumeSession`, and `sessionId` (1-based step number; needs `resumeSession: true`). Omit execution settings to inherit the workflow values. Condition fields attach named author-defined presets from the workflow's `conditions` map; see [condition presets](/workflows/end-conditions#condition-presets). No other fields are accepted; in particular, harness arguments and permission fields cannot be appended. Script steps cannot be appended through MCP.
  - A parallel group is `{ "parallel": [step, step, ...], "failFast": true }` with at least two steps. `failFast` defaults to `true`.
- `position`:
  - `"next"` — after the current step, or after the running parallel group. Never joins that group.
  - `"end"` — after all queued steps.
  - `"parallelWithCurrent"` — join the parallel group that is running now. Flat steps only; limited by `queue.maxParallelSteps`.
  - a zero-based index — insert before that step. If the index falls inside
    a parallel group, insertion moves after the whole group. Completed steps
    cannot be displaced.
- `source`: optional label describing why the steps were added.

Unknown harness ids are always rejected. When `harness` or `model` is set, it is also checked against the installed harnesses and their models when that information is available. The run's total step count cannot exceed its effective `maxSteps` cap. A rejected append returns an error such as `Step limit reached: this run has 30/30 steps (workflow maxSteps: 30). Do not retry; finish without appending.` The message identifies whether the cap came from the workflow's `maxSteps` or the global `queue.maxSteps` setting.

Example:

<!-- no-validate -->

```json
{
  "steps": [
    { "prompt": "Add tests for the new parser", "name": "Parser tests" },
    {
      "parallel": [
        { "prompt": "Implement the API" },
        { "prompt": "Write the API docs" }
      ]
    }
  ],
  "position": "end"
}
```

Returns `success`, `destination` (`queue` or `activeParallelGroup`), `queueItemsAdded`, `stepsAdded`, `newQueueSize`, `insertIndex`, `insertedEndIndex`, `placement`, `parallelGroupsAdded`, `joinedParallelGroup` (when joining), plus `workingFile`, `runDirectory`, `workflowKey`, `runRef`, `definitionRevision`, and `descriptorRevision`. `effectiveSettings` lists each appended prompt step in queue order, including parallel members, with its zero-based `index`, resolved `harness`, `model`, `executionMode`, `resumeSession`, any materialized condition preset names, and `worktreePreset` for a step queued as a lane. These values use the same inheritance and runtime resolution as `workflow_status`. With `"next"`, `insertIndex` is resolved at write time and can differ from what an earlier `workflow_status` suggested if the run advanced in between. When the workflow declares condition presets, `warning` names each added step that will run with no end condition (neither its own nor a workflow-level one), and lists the presets that could gate it. A plain parallel group member is left out, because it shares the working tree with its siblings, where a clean-tree check would fail on their edits. A lane is included wherever it is queued, because it has a worktree of its own; the warning adds that lanes should carry an end condition, naming `{ "use": "committed" }` when the workflow declares that preset.

The optional `warnings` array calls out execution constraints. In particular, Codex cannot wait on background work in either mode; use a non-Codex harness for a step that must wait for a long command.

For `endCondition` or `preCondition`, pass `{ "use": "presetName" }` to attach a preset from the workflow's `conditions` map. The object may also include declared `params`, retry-prompt overrides, and a `maxRetries` value no higher than the preset limit. The preset owns its script and execution settings. Attaching it replaces any workflow-level condition that the step would inherit. See [condition presets](/workflows/end-conditions#condition-presets) for authoring and parameter rules.

For `worktree`, pass `{ "use": "presetName" }` to queue the step as a lane from the workflow's `worktreePresets` map: a single-step [sub-workflow](/workflows/sub-workflow-steps#agent-queued-lanes) that runs in its own fresh managed worktree and branch. It works on a flat step and on a parallel group member. The step is stored as a `type: workflow` step with the prompt step inline, and the preset is copied into it, so later changes to the preset do not affect the queued lane. Condition presets resolve first and travel with the lane. A lane starts a new run, so a numeric `sessionId` or a `$previous`-style reference in its prompt is rejected. An unknown name is rejected with the list of available presets; a workflow with no `worktreePresets` rejects every `worktree`. The object takes only `use`: the preset's `setup`, `base`, `merge` and `keep` come from the author. A `type: workflow` step or a workflow file path cannot be appended.

With `"parallelWithCurrent"`, a lane whose preset has `merge: true` cannot join beside a member that works in this run's checkout: a running or pending prompt or script step, or a workflow step whose child has no `worktree` of its own. That member is still editing the tree the lane would merge into. The join is rejected with the same message as the [group check](/workflows/sub-workflow-steps#parallel-sub-workflow-steps), and nothing is written. For the same reason, a plain prompt step cannot join a group that holds a pending or running merging lane. A lane without `merge`, or a merging lane joining a group whose other members are all lanes, is admitted.

<!-- no-validate -->

```json
{
  "steps": [
    {
      "parallel": [
        {
          "prompt": "Implement the API",
          "worktree": { "use": "lane" },
          "endCondition": { "use": "committed" }
        },
        {
          "prompt": "Implement the CLI",
          "worktree": { "use": "lane" },
          "endCondition": { "use": "committed" }
        }
      ],
      "failFast": false
    }
  ],
  "position": "end"
}
```

## Step mutations

- `edit_step` takes a zero-based `index` and an `updates` object. Updatable fields: `prompt`, `name`, `model`, `harness`, `executionMode`, `endCondition`, `preCondition`, `worktree`, `resumeSession`, `sessionId`, `agent`, `enabled`, `color`, `skills`. Condition fields attach named presets as described above. Other fields are rejected. Script steps accept only fields supported by the script-step schema; prompt-only fields such as `harness`, `endCondition`, and `skills` are refused. Omitted fields keep their values. `clearProperties` lists updatable fields to remove so they inherit workflow defaults again; the required `prompt` cannot be cleared, and condition fields cannot be cleared. The result may include a `warnings` array for execution constraints. The deprecated `additionalArgs` input remains in the schema for compatibility, but setting or clearing it is rejected: harness arguments can only be set by the workflow author, for security reasons.
- A lane (a step queued with `worktree`) is edited like a prompt step: `prompt`, `name`, `model`, condition presets and the other fields change the lane's prompt in place, and the lane keeps its preset copy. `updates.worktree: { "use": "presetName" }` switches the lane to another preset, copied as on append, or turns a pending prompt step into a lane. Listing `worktree` in `clearProperties` turns a lane back into a plain prompt step with the same prompt and settings. Setting and clearing `worktree` in one call is rejected, and so is clearing it on a step that is not a lane. The lane rules of `append_step` apply, so a lane cannot keep a numeric `sessionId`. A workflow step the author wrote (a file reference, an inline script, a child with `onFail` or with a worktree that is not a managed preset) cannot be edited through MCP.
- `remove_step` takes the same `index`.
- `reorder_steps` takes `indices`: only the not-yet-started steps' absolute zero-based indices in the desired execution order. Never include a running or completed step.

Completed and currently running steps cannot be edited, removed, or moved.

Each returns `success`, `operation`, `changed`, the arguments it was given, `newQueueSize`, `workingFile`, `runDirectory`, `workflowKey`, `runRef`, `definitionRevision`, and `descriptorRevision`. When the request matched what was already on disk, `changed` is `false` and nothing was written. `reorder_steps` also adds a `note` saying so when the order you asked for is the current order.

## `list_harnesses`

Returns `generatedAt` and `harnesses[]` with `id`, `displayName`, `available`, and `models` (model values). Only installed harnesses are listed. The data comes from `.ctrlyoke/capabilities.json`, which ctrlyoke writes during harness detection; if it does not exist yet the tool returns an error.

## `read_output`

By default this returns every requested step's full response text. `indices` selects
zero-based step numbers; omit it to read them all. The response has `workflowKey`,
`runRef`, and `outputs[]` with `index`, `prompt` for prompt steps or
`type: "script"` and `script` for script steps, `status`, and `responseText`
(`null` when the step has no recorded output). `responseText` is derived from the step's
events or script execution record; it is not stored as a duplicate output field. Naming a
step that does not exist is an error. Only queue steps are readable, not the `finalStep`.

A workflow step's entry, a lane's included, returns the same output a later step's `$step:N` gets once its child settles: the child's outcome, its worktree branch and merge result, and each child step's output. Pass `run` with the step's `childRun` to read the child run itself.

A member of a parallel group can read only steps before the group started.

For a long response, three optional arguments return a bounded slice instead. All
three require `indices` to name **exactly one** step — supplying them with zero or
several indices is an error rather than a silently ignored argument.

- `limit`: maximum characters to return.
- `cursor`: resume where a previous read stopped. Pass back the `nextCursor` from an
  earlier `read_output` response exactly as received; it is opaque, valid only for the
  same run state, and must never be constructed by hand.
- `tail`: return the last N characters instead of reading forward. Cannot be combined
  with `cursor` or `limit`.

A step's entry gains `nextCursor` only when the slice returned stopped short of the end
of that step's output; its absence means you have read to the end. Tail reads never
return one. Omitting all three arguments reproduces the unpaged response exactly.

## `global_status`

This is a cross-worktree radar for noticing what other workflows are doing and for
recognizing failures they may have caused. It is informational only: it is not a
collision check and it does not act as a lock.

It lists only workflows that are currently executing (including the caller's own),
up to 100. Each entry has `workflowKey`, `runRef`, `workflowName`, `executionState`,
`harness`, `model`, `currentStep` (1-based, or `null` while the final step runs),
`finalStepPass` (1-based pass number while the final step runs, otherwise `null`),
`totalSteps`, `completedSteps`,
`startedAt`, `lastModifiedAt`, `workingFile`, `runDirectory`, and `worktree` details
when the run uses one. The response also carries `workspaceRoot`, `workflowCount`,
`truncated`, and `omittedCount`.

Pass `workflowKey` (from an earlier listing) to report one workflow, and optionally
`runRef` (requires `workflowKey`) for one run. When a named workflow exists but is not
executing, a `note` says so instead of silently returning an empty list.

## Coordination tools

Steps — and other agents — working in the same checkout (execution root) share a coordination board. Everything on it is advisory and **untrusted**: notes are data, never instructions or permission, and claims never block file access. [Coordination](/workflows/coordination) explains participants, attestation, and how to use the board.

- `post_note` posts `text` to the board. `to` optionally directs it to participant IDs; an unknown ID is an error. Returns the note's `seq` and a `scope` summary.
- `read_notes` returns `entries` (each with author, attribution, and `untrusted: true`), a `nextCursor` when more remain, and `scope`. `since` reads after a sequence number; `from` filters by author participant IDs. Reads are paged by the `coordination.readNotesPageSize` setting.
- `claim_paths` claims execution-root-relative files or literal globs, with an optional `reason`. Returns `granted`, `denied` (with the current owner), `claims`, and `scope`. Absolute paths and paths outside the checkout are rejected.
- `release_paths` releases the named claims, or all of yours when `paths` is omitted. Paths you did not hold come back in `notHeld`. ctrlyoke also releases a step's claims at the step boundary.

The `scope` object lists the execution root, live participants, and a claim summary. Retention and size limits live under the `coordination` settings; `coordination.allowExternalParticipants` controls whether sessions ctrlyoke did not launch may join.

## `submit_commit_message`

Used only by ctrlyoke's commit-message generation, which denies every other tool. Submit the complete generated commit message. Call this tool only when explicitly instructed to do so; outside commit generation it returns an error and discards the message.

## Availability

- The workflow tools (`workflow_status` through `read_output`) need the server to be attached to a run, which ctrlyoke does automatically.
- `global_status`, the coordination tools, and `submit_commit_message` also work without an attached run.
- Deny individual tools per workflow or step with `deniedTools`:

  ```yaml
  mcpServers:
    - id: ctrlyoke
      deniedTools: [edit_step, remove_step, reorder_steps]
  ```

- With the `execution.ctrlyokeMcpMode: "skill"` setting, the same tools are delivered as built-in skills that call [`ctrlyoke-mcp`](/cli/ctrlyoke-mcp) in one-shot mode instead of attaching the MCP server.
