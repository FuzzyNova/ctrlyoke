# Hooks

A hook runs a command of yours when the harness reaches a point in its turn:
a session starts, the AI is about to call a tool, the AI stops responding.
Use hooks to log what happened, notify another system, or run a check after
every turn.

```yaml
hooks:
  - event: stop
    command: node ./scripts/log-turn.js
steps:
  - name: implement
    prompt: Implement the change described in @docs/plan.md.
```

ctrlyoke doesn't run your hook itself. It writes the hook into the harness's
own hook configuration for the step, alongside the hooks ctrlyoke uses to
detect completion, and the harness runs it. Your existing hooks in the
harness's settings stay in place. Each step's hook files are removed again
afterwards; [Files ctrlyoke writes](/harnesses/files-ctrlyoke-writes) lists
them per harness.

## Events

Hooks use eight harness-neutral event names. ctrlyoke maps each one to the
harness's native event.

| Event               | Fires when                                    |
| ------------------- | --------------------------------------------- |
| `sessionStart`      | A new AI session starts.                      |
| `userPromptSubmit`  | A prompt is submitted to the AI.              |
| `preToolUse`        | The AI is about to call a tool.               |
| `postToolUse`       | A tool call has returned.                     |
| `permissionRequest` | The AI asks for permission to do something.   |
| `notification`      | The harness shows a notification to the user. |
| `stop`              | The AI finishes responding.                   |
| `error`             | The harness reports a session-level error.    |

Not every harness has every event. `preToolUse`, `postToolUse` and `stop`
work everywhere. The others don't:

| Event               | Not available on                        |
| ------------------- | --------------------------------------- |
| `sessionStart`      | Partial on OpenCode (can fire too late) |
| `userPromptSubmit`  | Antigravity                             |
| `permissionRequest` | Antigravity; partial on OpenCode        |
| `notification`      | Codex, OpenCode, Antigravity            |
| `error`             | Codex, Qwen Code, Antigravity           |

A hook for an event the step's harness doesn't support is skipped without an
error. The Hooks rows of the [compatibility matrix](/harnesses/compatibility)
have the details and the reason for each gap.

## Defining hooks

Each hook has an `event` and a `command`, plus two optional fields:

| Field        | Meaning                                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event`      | One of the eight events above.                                                                                                                     |
| `command`    | The command to run. Use a path relative to the workspace root, as in the examples.                                                                 |
| `env`        | Environment variables for the hook. Values may use `{{var}}` [variables](/workflows/variables) and `${secret:NAME}` [secrets](/workflows/secrets). |
| `timeoutSec` | Maximum hook runtime in seconds. Copilot, Claude Code, Codex, Qwen Code, Antigravity, and OpenCode honor it when set; other harnesses use their own timeout. |

`{{var}}` placeholders work in `command` too.

In the dashboard, the **Hooks** tab of the
[properties panel](/workflows/properties-panel#hooks) edits the same list for
the workflow or the selected step.

### Where hooks come from

Hooks can be set at three levels:

1. **Step** `hooks`. For each event a step lists, its hooks replace the
   workflow's hooks for that event. Events the step doesn't list still use the
   workflow's hooks.
2. **Workflow** `hooks`. A workflow list replaces
   [`defaults.hooks`](/reference/settings#defaults-hooks) entirely.
3. **`defaults.hooks`** in `.ctrlyoke/settings.json`, used when the workflow
   has no `hooks`.

`hooks: null` turns off every inherited hook, at the step or the workflow.
An empty list (`hooks: []`) on a step is treated as not set, so the step still
inherits.

A `defaults.hooks` value in a workspace's `.ctrlyoke/settings.json` runs a
command on your machine, so it only takes effect after you approve it, through
the VS Code prompt or `ctrlyoke trust-workspace-settings`. Until then the user
value applies.

## What a hook receives

**Input.** Most harnesses pipe their own JSON description of the event to the
hook on stdin: the session ID, the tool name and arguments, and so on. The
shape is the harness's, not ctrlyoke's, so read the harness's hooks
documentation for the fields. OpenCode sends a stable JSON object with
`hook_event_name` and `session_id`; tool hooks also include `tool_name`,
`tool_input`, and, after execution, `tool_output`. Other native event fields
are included when available.

**Environment.** The hook inherits the harness environment and ctrlyoke's
workflow variables below. Its own `env` values are merged over that environment
for this hook only; each hook receives only its own configured `env` values.
Those values are not added to the harness process environment. ctrlyoke writes
them to a per-step temp file readable by the local user, so a model with shell
access can read them. Secret values therefore are not hidden from the model.
Two hooks may use the same key with different values.

**Shell and timeout.** When `env` requires the launcher, Copilot hooks keep the
shell selected by their `powershell` or `bash` field, and Claude uses Git Bash
on Windows. Other harnesses use their default shell. OpenCode runs hooks from
its plugin using the system default shell. When a timeout ends a launched hook,
ctrlyoke terminates its child process tree as well.

| Variable                     | Value                                                    |
| ---------------------------- | -------------------------------------------------------- |
| `CTRLYOKE_WORKFLOW_NAME`     | The workflow's name.                                     |
| `CTRLYOKE_PROMPT_NAME`       | The step's `name`, when it has one.                      |
| `CTRLYOKE_PROMPT_INDEX`      | The step's position, counting from 0.                    |
| `CTRLYOKE_PARALLEL_GROUP_ID` | The parallel group's ID, for a step in a parallel group. |
| `CTRLYOKE_HARNESS_ID`        | The harness, for example `claude-cli`.                   |
| `CTRLYOKE_WORKSPACE_ROOT`    | The workspace root.                                      |
| `CTRLYOKE_WORKING_FILE`      | The run's working copy of the workflow.                  |

**Output.** What a hook's exit code or output does is up to the harness. Some
harnesses let a `preToolUse` hook block the tool call, for example. ctrlyoke
doesn't read the result, with one exception.

### `permissionRequest` hooks decide

A `permissionRequest` hook answers the harness's permission prompt. ctrlyoke
pipes the harness's request to your command on stdin and passes your
command's stdout back to the harness as the decision, in the harness's own
response format. Define one `permissionRequest` hook per step; when ctrlyoke
is also watching the event for a [notification](#hooks-and-notifications), it
only runs the first. OpenCode's handling of the decision is unverified, so a
returned decision there may be ignored.

## Example: log every turn

This workflow appends a line to a log file each time the AI finishes a turn,
and runs a lint check after every edit on the `implement` step only.

```yaml
vars:
  logFile: .ctrlyoke/turns.log
hooks:
  - event: stop
    command: node ./scripts/log-turn.js
    env:
      TURN_LOG: "{{logFile}}"
steps:
  - name: implement
    prompt: Refactor @src/billing/ to use the new pricing module.
    hooks:
      - event: postToolUse
        command: npm run lint --silent
  - name: review
    prompt: Review the refactor in ~diff and list any risks.
```

`scripts/log-turn.js`:

```js
const fs = require("node:fs");

const line = [
  new Date().toISOString(),
  process.env.CTRLYOKE_WORKFLOW_NAME,
  process.env.CTRLYOKE_PROMPT_NAME ??
    `step ${process.env.CTRLYOKE_PROMPT_INDEX}`,
  process.env.CTRLYOKE_HARNESS_ID,
].join("\t");

fs.appendFileSync(process.env.TURN_LOG, line + "\n");
```

Both steps inherit the workflow's `stop` hook. The `implement` step adds a
`postToolUse` hook; because the step lists no `stop` hook, it keeps the
workflow's.

## Hooks and notifications

ctrlyoke can show a notification for the same eight events, without any hook
of yours: turn them on under **Hook events** in
[Settings → Notifications](/guide/notifications#hook-events). Use a
notification to find out that something happened, and a hook to run a command
when it does. The two work side by side.

## When hooks don't run

- **Script steps** don't start a harness, so no hooks run for them.
- **Commit message generation** runs with hooks turned off.
- A hook for an event the harness doesn't support is skipped.

## See also

- [Compatibility matrix](/harnesses/compatibility)
- [Properties panel: Hooks](/workflows/properties-panel#hooks)
- [Files ctrlyoke writes](/harnesses/files-ctrlyoke-writes)
- [Workflow schema: `hooks`](/reference/workflow-schema#execution-properties-hooks)
