# Core concepts

## Harness

A **harness** is the execution strategy ctrlyoke uses to talk to an AI assistant CLI.

ctrlyoke currently supports:

- `copilot-cli`
- `claude-cli`
- `codex-cli`
- `opencode-cli`
- `qwen-cli`
- `antigravity-cli`

## Workflow

A workflow is a `.ctrlyoke.yaml`, `.ctrlyoke.json`, or `.prompt.md` file that describes work to run. YAML and JSON support multi-step automation. Markdown prompt files are the simplest one-step format.

### Durable workflows and generated files

Dashboard work is ephemeral. By default, run history is user-scoped at
`<ctrlyokeStateHome>/projects/<slug>-<hash12>/.runs/`, keyed from the resolved
`ExecutionWorkspace.stateRoot`; it is outside the workspace and harness sandbox because only
ctrlyoke reads it. `storage.runHistoryLocation: "workspace"` keeps it beside the repo at
`<stateRoot>/.ctrlyoke/.runs/` for locality or durability, but workspace mode still ignores
`.runs/` and neither mode makes runs shareable. User-level, project-keyed session history is also
the familiar pattern used by Claude and Codex.

`attachments/` and `prompts/` stay ephemeral and workspace-scoped under `.ctrlyoke/`. Harnesses
read those files through `@` references, so they must remain inside the workspace sandbox.

Use **Save As** when a workflow is worth keeping: it writes the workflow plus its dependencies,
copying inline attachments into a sibling `<workflow>.assets/` directory and inlining lone
prompt-file bodies. A workflow you hand-author anywhere in the repo or promote to a template is
also durable; templates are the reusable form of a workflow you run often, while Save As produces
a copy. The workflow file and its sibling assets directory can be moved or copied together to
another directory or repository and still resolve. This carries generated dependencies only;
references such as `@src/foo.ts`, committed prompt files, and `.ctrlyoke/scripts/**` still require
the repository they operate on.

The generated `.ctrlyoke/.gitignore` continues to ignore workspace runtime entries. It is
append-only, so deleting an entry is restored on the next activation; use the explicit run export
described in `dev/backlog/RUN_EXPORT_PLAN.md` to share a run. Managed-worktree landing permits
runtime files you deliberately track, including prompts and attachments, but blocks non-ignored
untracked runtime output. It always blocks `certs/`, `notifications/`, `temp/`, and `logs/`, even
if tracked, because those directories can contain secrets or ephemeral transport data.
`settings.json` is tracked by default; the `server.certPath` and `server.keyPath` settings are
machine-local paths.

Managed worktree runs retain the initiating checkout's `stateRoot` and therefore its history.
Opening a worktree directory directly as its own VS Code workspace gives that directory its own
history. Home directories under OneDrive or Dropbox sync user-scoped history, but simultaneous
runs of the same project on two synced machines are unsupported because PIDs and file locks are
machine-local.

## Step

A workflow `steps` array can contain two kinds of step:

| Type        | Purpose                                         |
| ----------- | ----------------------------------------------- |
| Prompt step | Sends a prompt to a harness                     |
| Script step | Runs a shell command without any AI interaction |

Prompt steps default to type `prompt`, so the `type` field is optional unless you want to be explicit.

**Hiding steps in the Output pane.** Use the Output pane's minimap eye controls or a step context menu to hide output from individual steps while keeping their status and progress visible. The header shows how many steps are hidden; use the pill's show-all action, the step controls, or the context menu to restore output. Copy All follows the filter, while Markdown export starts with the visible steps selected and lets you widen the range before exporting.

### Parallel groups

A `parallel` queue item forks a flat group of prompt or script steps and joins
before the next queue item. The group width is bounded by
`queue.maxParallelSteps`; setting it to `1` keeps the same workflow sequential.
Members are for independent work and share one workspace, one run timeline,
and one managed or named worktree per run. There is no per-member isolation or
automatic merge in v1. Terminal controller arbitration is per workflow, not
per session. Use the following step after the join to synthesize the members'
settled output.

## Final step

`finalStep` runs after the queue completes. It is useful for review passes, post-processing, or dynamic queue extension loops.

If the final step has `mcpServers: ["ctrlyoke"]` and appends more prompts, ctrlyoke runs the new queue items and then executes the final step again.

## Session

A session is the underlying conversation or thread maintained by a harness. ctrlyoke can:

- start a new session
- resume the immediately previous session with `resumeSession: true`
- resume a specific earlier step with `sessionId: 1`
- resume an exact harness session ID string

Session reuse is provider-aware. ctrlyoke does not try to resume a Claude session in Copilot or the other way around.

## Context references

Prompts can include structured references that the prompt editor understands:

| Syntax                                         | Purpose                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `@path/to/file.ts`                             | Attach a full file                                                                                                  |
| `@path/to/dir/`                                | Attach a directory tree                                                                                             |
| `@./path/to/file.ts`, `@../path/to/file.ts`    | Attach a file relative to the workflow file                                                                         |
| `#selection:path/to/file.ts:10-25`             | Attach a line range                                                                                                 |
| `#selection:./path/to/file.ts:10-25`           | Attach a line range relative to the workflow file                                                                   |
| `#sym.<kind>:path/to/file.ts:SymbolName:42-60` | Attach a symbol definition; ctrlyoke inserts the kind, while `#sym:path:SymbolName:42-60` remains valid and generic |
| `~diff`, `~staged`, `~stash:0`, `~<commit>`    | Attach git change context                                                                                           |
| `$previous`, `$all`, `$step:1`                 | Inject prior ctrlyoke output                                                                                        |

For `@`, `#selection:`, and `#sym:` references, a leading `./` or `../` resolves from the
workflow file's directory. A lone `prompt:` value uses `./` differently: the leading prefix is
mandatory path syntax, and its existing source-directory-then-workspace probing behavior is
unchanged. The two forms are intentionally separate because lone prompt paths are inlined by Save
As, while inline context references may be copied into the sibling assets directory.

## End conditions and pre-conditions

These are script-based gates:

- **Pre-condition** runs before a prompt and can continue, skip, or stop
- **End condition** runs after a prompt and can continue, retry, or stop

Use them when a workflow should react to actual project state instead of trusting the model's self-report.
