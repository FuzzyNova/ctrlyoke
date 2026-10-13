# MCP tools

ctrlyoke's built-in MCP server gives a harness tools to inspect and adjust the run it belongs to. Enable it with `mcpServers: ["ctrlyoke"]` on a workflow or step — see [Dynamic queue](/workflows/dynamic-queue).

## How the server is scoped

- **One run per server.** ctrlyoke starts the server for each harness launch and pins it to the executing run. No tool takes a workflow or run address, so a tool can never act on another workflow by mistake. Responses still report the resolved `workflowKey` and `runRef`.
- **No lifecycle control.** No tool starts, stops, pauses, or resumes a run.
- **Every call does what it says or returns an error.** An error result (`isError: true`, text starting `Error:`) means nothing was changed.
- **Queue changes need a live run.** `append_step`, `edit_step`, `remove_step`, and `reorder_steps` are refused unless the run is running, pausing, paused, or cancelling.
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

- `metadata`: `workflowName`, `harness`, `model`, `currentIndex`, `totalSteps`, `completedSteps`, `executionState`, `maxSteps` and `remainingSteps` (numbers, or `"unlimited"`), `workingFile`, `runDirectory`, `definitionRevision`, `descriptorRevision`. The limit fields report the effective cap after applying the workflow's `maxSteps` override to the global `queue.maxSteps` setting; `remainingSteps` is based on the current total step count.
- `steps[]`: `index`, `prompt` (script steps show as `(script) <command>`), `status` (`completed`, `failed`, `cancelled`, `skipped`, `running`, or `pending`), `model`.

## `append_step`

- `steps`: one or more queue items, in order. Each item is either a step or a future parallel group.
  - A step takes `prompt` (required), `name`, `model`, `harness`, `resumeSession`, and `sessionId` (1-based step number; needs `resumeSession: true`). No other fields are accepted, and script steps cannot be appended.
  - A parallel group is `{ "parallel": [step, step, ...], "failFast": true }` with at least two steps. `failFast` defaults to `true`.
- `position`:
  - `"next"` — after the current step, or after the running parallel group. Never joins that group.
  - `"end"` — after all queued steps.
  - `"parallelWithCurrent"` — join the parallel group that is running now. Flat steps only; limited by `queue.maxParallelSteps`.
  - a zero-based index — insert before that step. Completed steps cannot be displaced.
- `source`: optional label describing why the steps were added.

When `harness` or `model` is set, it is checked against the installed harnesses and their models (when that information is available). The run's total step count cannot exceed its effective `maxSteps` cap. A rejected append returns an error such as `Step limit reached: this run has 30/30 steps (workflow maxSteps: 30). Do not retry; finish without appending.` The message identifies whether the cap came from the workflow's `maxSteps` or the global `queue.maxSteps` setting.

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

Returns `success`, `destination` (`queue` or `activeParallelGroup`), `queueItemsAdded`, `stepsAdded`, `newQueueSize`, `insertIndex`, `insertedEndIndex`, `placement`, `parallelGroupsAdded`, `joinedParallelGroup` (when joining), plus `workingFile`, `runDirectory`, `workflowKey`, `runRef`, `definitionRevision`, and `descriptorRevision`. With `"next"`, `insertIndex` is resolved at write time and can differ from what an earlier `workflow_status` suggested if the run advanced in between.

## Step mutations

- `edit_step` takes a zero-based `index` and an `updates` object. Updatable fields: `prompt`, `name`, `model`, `harness`, `resumeSession`, `sessionId`, `agent`, `enabled`, `color`, `additionalArgs` (array of strings), `skills`. Other fields are rejected. Omitted fields keep their values. `clearProperties` lists updatable fields to remove so they inherit workflow defaults again; the required `prompt` cannot be cleared.
- `remove_step` takes the same `index`.
- `reorder_steps` takes `indices`: only the not-yet-started steps' absolute zero-based indices in the desired execution order. Never include a running or completed step.

Completed and currently running steps cannot be edited, removed, or moved.

Each returns `success`, `operation`, `changed`, the arguments it was given, `newQueueSize`, `workingFile`, `runDirectory`, `workflowKey`, `runRef`, `definitionRevision`, and `descriptorRevision`. When the request matched what was already on disk, `changed` is `false` and a `note` says nothing was written.

## `list_harnesses`

Returns `generatedAt` and `harnesses[]` with `id`, `displayName`, `available`, and `models` (model values). Only installed harnesses are listed. The data comes from `.ctrlyoke/capabilities.json`, which ctrlyoke writes during harness detection; if it does not exist yet the tool returns an error.

## `read_output`

By default this returns every requested step's full response text. `indices` selects
zero-based step numbers; omit it to read them all. The response has `workflowKey`,
`runRef`, and `outputs[]` with `index`, `prompt`, `status`, and `responseText`
(`null` when the step has no recorded output). `responseText` is derived from the step's
events or script execution record; it is not stored as a duplicate output field. Naming a
step that does not exist is an error. Only queue steps are readable, not the `finalStep`.

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

Steps — and other agents — working in the same checkout (execution root) share a coordination board. Everything on it is advisory and **untrusted**: notes are data, never instructions or permission, and claims never block file access.

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
