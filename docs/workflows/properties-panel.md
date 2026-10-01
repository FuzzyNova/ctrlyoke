# Workflow properties panel

The **Workflow Properties** panel in the ctrlyoke dashboard edits the root-level
fields of the loaded workflow without opening its file. Each tab along the bottom
of the panel covers one group of fields: **Harness**, **Context**, **Validation**,
**MCP**, **Hooks**, and **Permissions**.

Everything here is the workflow-level value. A step can still override a field
from its own properties drawer, and fields you leave unset fall back to the
matching [`defaults.*` setting](/reference/settings#defaults). See
[How values are inherited](/reference/workflow-schema#how-values-are-inherited)
for the full order.

- **Set as Default** appears next to a field when its value differs from your
  default. Click it to write the current value to the matching `defaults.*`
  setting so new workflows start with it.
- **Reset all to defaults** (the circular-arrow button in the panel header)
  sets every field back to your current defaults.

## Harness

![Harness tab with the harness picker open, listing all six harnesses](/screenshots/harness-tab-with-dropdown-400x800.png)

The Harness tab chooses what runs each prompt and where it runs:

- **Harness** and **Model** — the AI CLI and model. See
  [Harnesses](/harnesses/) for what each one supports.
- **Agent** and **Skills** — portable prompt attachments that work the same on
  every harness. See [Agents and skills](/workflows/agents-and-skills).
- **Additional Args** — extra CLI flags appended to the ones ctrlyoke manages,
  such as `--effort high`.
- **Execution Mode** — **Interactive** runs in a live terminal; **Headless** runs
  in the background with output in the dashboard.
- **Worktree** — run in your working checkout or in a Git worktree.

### Worktrees

A **Managed** worktree is a throw-away worktree and branch created for each run.
**Base** picks the Git ref it starts from, and **Setup** runs once after the
worktree is created (for example `npm ci`). **Keep directory** leaves the
worktree on disk after the run for review and undo, and **Merge** merges the
branch back into your working checkout after every run.

![Harness tab with a managed worktree, showing Base, Setup, Keep directory, and Merge](/screenshots/harness-tab-managed-worktree-400x800.png)

A **Named** worktree targets a persistent branch you own. ctrlyoke creates it if
needed but never commits, merges, or removes it, which suits workflows you keep
appending to.

![Harness tab with a named worktree on the bug-fix branch](/screenshots/harness-tab-named-worktree-400x800.png)

Field details: [`worktree`](/reference/workflow-schema#worktree).

## Context

![Context tab with Resume Session, Prior Context, and a workflow variable](/screenshots/context-tab-400x800.png)

- **Resume Session** — continue an earlier harness session instead of starting
  fresh. Leave the session field blank to auto-resume, or enter a session ID or a
  prompt number. See [Session management](/workflows/session-management).
- **Prior Context** — inject earlier step outputs into each prompt. The field
  below the selector takes specific prompt numbers, such as `1,2,4-10`.
- **Variables** — workflow-level <code v-pre>{{name}}</code> values. Use **Bulk
  edit** to paste several `name=value` lines at once.

## Validation

With nothing enabled, the Validation tab shows the **Pre-Condition** and **End
Condition** toggles, plus the workflow's **Error Behavior** and **Max Steps**.

![Validation tab with no pre-condition or end condition enabled](/screenshots/validation-tab-none-400x800.png)

Enable **End Condition** to run a script after each prompt and decide whether the
work passed. **Pass when** compares the script's exit code or output against an
expected value, and **On Pass** / **On Fail** decide what happens next.

![Validation tab with an npm test end condition that passes on exit code 0](/screenshots/validation-tab-end-condition-with-script-400x800.png)

When **On Fail** is **Retry**, the **Retry Prompt** tells the harness what went
wrong. Condition-output references such as `$endCondition:stdout` insert the
script's actual results.

![Validation tab retry settings with a retry prompt that references the end condition's output](/screenshots/validation-tab-end-condition-with-retry-400x800.png)

See [End conditions and pre-conditions](/workflows/end-conditions) for every
option.

## MCP

![MCP tab with the built-in ctrlyoke server's tools and two installed servers](/screenshots/mcp-tab-400x800.png)

The MCP tab picks which MCP servers are attached to the harness. The built-in
**ctrlyoke** server lets the AI read workflow status and extend the queue (see
[Dynamic queue](/workflows/dynamic-queue)), and each of its tools can be switched
off individually. **Installed Servers** lists the servers registered with
ctrlyoke; **Manage MCP Servers** opens the MCP manager in Settings to add, edit,
or remove them.

Tool reference: [MCP tools](/reference/mcp-tools).

## Hooks

![Hooks tab with Session Start, Stop, and Error hooks that run node scripts](/screenshots/hooks-tab-400x800.png)

Hooks run your own commands on harness events such as **Session Start**,
**Stop**, and **Error**, alongside the hooks ctrlyoke uses for completion
detection. Each hook has a command, an optional timeout, and its own environment
variables. Supported events vary by harness; unsupported events are skipped.

Field details: [`hooks`](/reference/workflow-schema#execution-properties-hooks).

## Permissions

![Permissions tab in Custom mode with allowed and denied tool lists](/screenshots/permissions-tab-400x800.png)

- **Tool Permission Mode** — how much the harness may do without asking. In
  **Custom** mode only the **Allowed Tools** list is granted, and **Denied
  Tools** always wins over it.
- **Secrets** — secret environment variables this workflow may use.
- **Trusted External Roots** — directories outside the workspace this workflow
  may use. **Inherit** keeps the roots from your settings. See
  [External file roots](/reference/settings#external-file-roots).

Not every harness enforces individual tool patterns. See
[`toolPermissions`](/reference/workflow-schema#execution-properties-toolpermissions)
and the [permission settings](/reference/settings#permissions).
