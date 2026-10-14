# Workflow files

ctrlyoke supports three file formats:

| Format   | Extension                         | Best use                             |
| -------- | --------------------------------- | ------------------------------------ |
| YAML     | `.ctrlyoke.yaml`, `.ctrlyoke.yml` | Multi-step workflows written by hand |
| JSON     | `.ctrlyoke.json`                  | Generated workflows and automation   |
| Markdown | `.prompt.md`                      | Single prompt files                  |

## Current schema shape

The current multi-step schema uses `steps`, not `prompts`.

```yaml
harness: copilot-cli
steps:
  - prompt: Review @src/
finalStep:
  prompt: Summarize the result and any follow-up work.
```

## Main workflow building blocks

- root-level execution defaults such as `harness`, `model`, and `toolPermissions`
- a `steps` array containing prompt steps, script steps, and `parallel` groups
- an optional `finalStep`
- runtime metadata added automatically during execution

A one-step workflow can also skip `steps` and put a single prompt step (or a
`type: script` step) directly at the root:

```yaml
harness: claude-cli
prompt: Review @src/ and list the riskiest modules.
```

Read the format-specific pages next:

- [YAML format](/workflows/yaml-format)
- [JSON format](/workflows/json-format)
- [Prompt Markdown format](/workflows/prompt-md-format)
- [Script steps](/workflows/script-steps)
- [Parallel steps](/workflows/parallel-steps)
- [Context references](/workflows/context-files)
- [Agents and skills](/workflows/agents-and-skills)
- [Templates](/workflows/templates)

## Sharing a workflow {#sharing}

A workflow file is an ordinary file in your repository. Commit it, or copy it
to another machine or repository, and it runs there too, as long as the files
it refers to come along. A workflow you saved from the dashboard may also have
a sibling `<workflow>.assets/` folder holding its pasted images and other
attachments. Keep the two together. See
[Durable workflows and generated files](/guide/concepts#durable-workflows-and-generated-files).

### Paths relative to the workflow file {#workflow-relative-paths}

How a path in a workflow resolves depends on where it appears:

| Path                                                      | Resolves from                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `@`, `#selection:` or `#sym:` path starting `./` or `../` | The workflow file's folder                                                      |
| Any other relative `@`, `#selection:` or `#sym:` path     | The workspace root                                                              |
| A step `prompt` that is a file path (`./…` or `../…`)     | The workflow file's folder, then the workspace root, then `.ctrlyoke/`          |
| A `script`, end condition or pre-condition script         | The run's folder, the workspace root, `.ctrlyoke/`, then `~/.ctrlyoke/scripts/` |

So to keep a workflow and the files it attaches together, put the files next
to the workflow and refer to them with `./`:

```yaml
steps:
  - prompt: Implement the screen in @./mockups/login.png following @./spec.md.
```

A `./` reference needs a workflow file to resolve against. In a workflow
you've built in the dashboard and not saved yet, it fails with "This reference
is relative to the workflow file, which has no known location." In a
[worktree](/workflows/worktrees) run, it resolves from the same folder inside
the worktree.

Scripts are looked up from the workspace, not the workflow file. Keep shared
scripts in `.ctrlyoke/scripts/` and commit them; a script in your own
`~/.ctrlyoke/scripts/` stays on your machine. An absolute path only works on
machines with the same folders. See
[How scripts run](/workflows/script-steps#how-scripts-run) and
[Where paths resolve](/workflows/context-files#where-paths-resolve).

### What travels with the repository {#what-travels}

Under `.ctrlyoke/`, the files you write are meant to be committed:
`templates/`, `scripts/`, `agents/`, `skills/`, `mcp/servers.json` and
`settings.json`. What ctrlyoke generates for itself is ignored by the
generated `.ctrlyoke/.gitignore` and stays on your machine, including
pasted attachments and saved prompts.

These never travel with a workflow, so each person sets them up on their own
machine:

- the harness CLIs, and signing in to them
- user settings in `~/.ctrlyoke/settings.json`, and agents, skills and MCP
  servers saved in your home folder
- secret values
- run history and favorites
- your approvals, below

### Approvals stay on each machine {#approvals}

A shared file can only request access. Each person approves it once on their
own machine, and the answer is stored in their home folder, never in the
workflow or the workspace:

- **A workflow's `trustedExternalRoots`** are approved per folder, for that
  workflow file in that workspace. Moving or renaming the file, or the
  workspace folder, asks again. See
  [Trusted external folders](/workflows/permissions#trusted-external-roots).
- **Secret grants** are approved per name for the workspace, so another
  workflow in the same workspace can use an approved name without asking. See
  [Approving grants](/workflows/secrets#approving-grants).
- **Workspace settings that run a program**, such as a hook or an MCP server
  in the workspace's `.ctrlyoke/settings.json`, are approved per exact value.
  A changed value asks again. See
  [Settings that run programs](/reference/settings#settings-that-run-programs).

On a CI runner, approve them up front with the `trust-*` commands and `--yes`
(see [Running in CI](/cli/ci)).

Apart from secret grants and external folders, what the workflow file itself
contains needs no approval. Running a workflow runs its steps, scripts, end
conditions, hooks and MCP servers. Read a
workflow you got from someone else before you run it.
