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

Dashboard work is stored under `.ctrlyoke/.runs/` and is machine-local by default. The generated
`.ctrlyoke/.gitignore` also ignores `attachments/`, `prompts/`, logs, temporary files, and other
runtime data. Use **Save As** when a workflow is worth keeping: it writes the workflow plus its
dependencies, copying inline attachments into a sibling `<workflow>.assets/` directory and
inlining lone prompt-file bodies. The workflow file and its sibling assets directory can be moved
or copied together to another directory or repository and still resolve. This carries generated
dependencies only; references such as `@src/foo.ts`, committed prompt files, and
`.ctrlyoke/scripts/**` still require the repository they operate on.

The `.ctrlyoke/.gitignore` is editable. Delete its self-ignore line at the bottom before removing
other entries, or the edit remains local. `settings.json` is tracked by default; the
`server.certPath` and `server.keyPath` settings are machine-local paths.

## Step

A workflow `steps` array can contain two kinds of step:

| Type        | Purpose                                         |
| ----------- | ----------------------------------------------- |
| Prompt step | Sends a prompt to a harness                     |
| Script step | Runs a shell command without any AI interaction |

Prompt steps default to type `prompt`, so the `type` field is optional unless you want to be explicit.

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
| `@./path/to/file.ts`, `@../path/to/file.ts`    | Attach a file relative to the workflow file                                                                        |
| `#selection:path/to/file.ts:10-25`             | Attach a line range                                                                                                 |
| `#selection:./path/to/file.ts:10-25`            | Attach a line range relative to the workflow file                                                                   |
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
