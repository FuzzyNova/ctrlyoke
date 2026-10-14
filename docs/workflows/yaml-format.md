# YAML format

YAML is the most readable way to author multi-step workflows by hand.

The YAML schema flags unknown keys as editor squiggles when the Red Hat YAML
extension is version 1.20 or newer. Older versions still provide ordinary YAML
and type checking, but do not recognize the schema's unknown-key closures.

## Example

```yaml
harness: copilot-cli
model: claude-sonnet-4.6

steps:
  - name: inspect
    prompt: |
      Inspect @src/core/ and identify the biggest reliability risk.

  - name: verify-workspace
    type: script
    script: npm test
    compareSource: exitCode
    expected: 0
    onFail: stopWorkflow

  - name: implement
    resumeSession: true
    prompt: |
      Fix the issue you identified and update any directly related docs.

finalStep:
  prompt: |
    Review the completed work for obvious edge cases.
```

## Root-level fields you will use first

| Field                  | Purpose                                                               |
| ---------------------- | --------------------------------------------------------------------- |
| `harness`              | Select the harness                                                    |
| `model`                | Override the harness model                                            |
| `steps`                | Ordered list of work to run                                           |
| `finalStep`            | Prompt or script that runs after the queue                            |
| `vars`                 | Workflow-level variables for <code v-pre>{{name}}</code> substitution |
| `trustedExternalRoots` | Workflow-scoped external directory access                             |

## Workflow-scoped external roots {#workflow-scoped-external-roots}

`trustedExternalRoots` lists the folders outside the workspace this workflow
may use. Each new root needs a one-time approval on your machine before it
takes effect.

```yaml
trustedExternalRoots:
  - C:/Users/me/.codex/sessions
```

See [Trusted external folders](/workflows/permissions#trusted-external-roots).

## Prompt step fields you will use first

| Field           | Purpose                                                        |
| --------------- | -------------------------------------------------------------- |
| `name`          | Human-readable label in the dashboard                          |
| `prompt`        | Inline prompt text or a path to `.prompt.md`, `.md`, or `.txt` |
| `resumeSession` | Continue the previous compatible session                       |
| `sessionId`     | Resume a step's session (`1`), an exact ID, or `finalStep`     |
| `endCondition`  | Validate after the step completes                              |
| `preCondition`  | Gate before the step runs                                      |

A `prompt` value is read as a file path only when the whole value is a path that
starts with `./`, `../`, or an absolute path, or in a multi-root workspace a
path that starts with a workspace folder name (for example
`prompt: ./prompts/review.prompt.md`). The file is looked up next to the
workflow file first, then in the workspace root, then in `.ctrlyoke/`. Anything
else, including `prompts/review.prompt.md` without the `./`, is sent as inline
prompt text.

## How step properties inherit {#property-inheritance}

Most step fields can also be set once at the root of the workflow. These are
the [execution properties](/reference/workflow-schema#execution-properties):
`harness`, `model`, `executionMode`, `agent`, `skills`, `secrets`,
`resumeSession`, `sessionId`, `mcpServers`, `hooks`, `endCondition`,
`preCondition`, `priorContext`, `additionalArgs`, `toolPermissions` and
`errorBehavior`. A step takes each one from the first level that sets it:

1. the step itself
2. the workflow root
3. the matching `defaults.*` setting, such as
   [`defaults.executionMode`](/reference/settings#defaults-executionmode) or
   [`defaults.models`](/reference/settings#defaults-models). See
   [Settings](/guide/settings).

```yaml
harness: claude-cli
model: sonnet
executionMode: headless

steps:
  - name: plan
    model: opus
    prompt: Write a plan for the change to plan.md.
  - name: implement
    prompt: Implement plan.md.
  - name: review
    executionMode: interactive
    prompt: Walk me through the change.
```

Here `plan` runs on `opus` and the other two on `sonnet`. Only `review` opens a
terminal.

The winning value is used as a whole. Lists and objects such as `skills`,
`mcpServers` and `toolPermissions` are not merged with the levels below. The
one exception is `hooks`: a step's hooks replace the workflow's hooks only for
the events the step lists.

### Leaving a field out vs `null`

Leaving a field out means "inherit". Setting it to `null`, on a step or at the
root, means "none" and stops inheritance from the levels below:

```yaml
agent: reviewer
mcpServers: [github]

steps:
  - name: draft
    prompt: Draft the release notes.
  - name: format
    agent: null # no agent for this step
    mcpServers: null # and no MCP servers
    prompt: Reformat CHANGELOG.md.
```

`agent`, `skills`, `secrets`, `mcpServers`, `hooks`, `endCondition`,
`preCondition`, `additionalArgs` and `errorBehavior` accept `null`.
`toolPermissions: null` is the same as `mode: none`: ctrlyoke passes no
permission flags. Fields that only take a value, such as `model`,
`executionMode` and `resumeSession`, have no `null`; set the value you want
instead. In the dashboard, `null` is the **None** option in the step's
properties.

### Where settings defaults come in

When you open a workflow file, ctrlyoke makes its own working copy (your file
is not changed) and fills in the current `defaults.*` value for each root field
the file leaves out. Those values show in
[Workflow Properties](/workflows/properties-panel), and the run uses them. A
settings change therefore applies the next time you open the file. It doesn't
change a workflow that is already open, or a run you continue.

`defaults.errorBehavior` works only this way: it is copied into a new workflow,
not looked up while the run is going. See
[Error handling](/workflows/error-handling).

A root `toolPermissions` that sets only some of `mode`, `allowedTools` and
`deniedTools` gets the missing ones from `defaults.toolPermissions`. A step's
`toolPermissions` doesn't. See [Permissions](/workflows/permissions#which-level-wins).

### Steps on another harness

Model names and command-line flags differ from one harness to the next, so
`model` and `additionalArgs` at the root apply only to steps that run on the
workflow's own harness. A step on another harness that leaves them out uses
that harness's [`defaults.models`](/reference/settings#defaults-models) and
`defaults.additionalArgs` values instead:

```yaml
harness: claude-cli
model: sonnet

steps:
  - prompt: Plan the change. # sonnet
  - harness: codex-cli
    prompt: Implement the plan. # defaults.models for codex-cli
  - harness: codex-cli
    model: gpt-6-sol
    prompt: Review the change. # gpt-6-sol
```

The step's properties show which one applies. **Inherit (…)** means the step
takes the workflow's value. **Default (…)** means it takes the settings default
for its own harness. Picking a harness for a step clears the step's model and
additional arguments, so they follow the rule above until you choose new ones.

### `model: none`

`model: none` (**None** in the model picker) passes no model flag, so the
harness uses its own default model. Use it when you pass the model yourself in
`additionalArgs`, for example a custom model string your harness accepts. Each
harness page has a **Model selection** section listing where its models come
from.

### `executionMode`

`interactive` runs the step in a terminal on the **Terminal** tab;
`headless` runs it in the background. It inherits like the fields above, with
two exceptions: pre-conditions and end conditions always run headless, and
`ctrlyoke run` without a terminal runs every step headless. See
[Interactive and headless](/guide/terminal#interactive-and-headless).

### `resumeSession`

`resumeSession` defaults to `true` through
[`defaults.resumeSession`](/reference/settings#defaults-resumesession), so each
step continues the previous step's conversation on the same harness. Set
`resumeSession: false` on a step, or at the root for every step, to start fresh.
See [Session management](/workflows/session-management).

### `additionalArgs`

`additionalArgs` is a string of extra flags for the harness command, such as
`--effort high`. ctrlyoke still manages the model, permission, folder and
session flags; your flags go in before the permission flags. Set it to `null`
on a step to drop arguments inherited from the workflow or settings.

Changing `additionalArgs` from one step to the next means the harness has to
start again: the next step can't be typed into the previous step's terminal,
so it gets a new one. See
[What happens when a step ends](/guide/terminal#what-happens-when-a-step-ends).

A `defaults.additionalArgs` value in a workspace settings file needs your
approval first. See
[Workspace settings that run programs](/guide/settings#workspace-settings-that-run-programs).

### Step-only fields: `enabled` and `color`

`enabled` and `color` belong to one step and are never inherited:

- `enabled: false` keeps the step in the workflow but skips it when the
  workflow runs. Leaving it out means the step runs.
- `color` sets the step's identity colour as a hex value, such as
  `color: "#4f9dff"`. It overrides the **Harness** and
  **Unique** colour modes, and isn't shown when step colours are off. See
  [Step colours](/guide/output#step-colours).

## Script steps {#script-steps}

Set `type: script` to run a shell command or script file as a step, with no AI
involved:

```yaml
steps:
  - name: lint
    type: script
    script: npm run lint
    onFail: stopWorkflow
```

See [Script steps and condition scripts](/workflows/script-steps).

## Parallel steps {#parallel-steps}

A `parallel` queue item runs a flat group of prompt or script steps concurrently
before the next queue item starts:

```yaml
steps:
  - parallel:
      - prompt: Research the authentication flow.
      - prompt: Research the data model.
```

See [Parallel steps](/workflows/parallel-steps).
