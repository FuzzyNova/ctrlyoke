# Permissions

A harness asks before it runs a shell command, writes a file or calls a tool. In
an unattended workflow nobody is there to answer, so ctrlyoke decides up front
what each step may do and passes that to the harness as command-line flags.

Two settings control this:

- **Tool permissions** (`toolPermissions`): which tools the harness may use
  without asking.
- **Trusted external folders** (`trustedExternalRoots`): which directories
  outside the workspace ctrlyoke may read, and which it hands to the harness.

```yaml
toolPermissions:
  mode: custom
  allowedTools:
    - write
    - shell(npm test)
    - shell(git diff:*)
  deniedTools:
    - shell(git push:*)
steps:
  - prompt: Fix the failing test in @src/api/users.test.ts.
```

## Permission modes

| Mode                  | Dashboard label              | What the harness may do                                                                                                |
| --------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `dangerouslyAllowAll` | Dangerously Allow All (yolo) | Everything, with no approvals and no deny list. Each harness's own "skip all permissions" flag.                        |
| `allowAll`            | Allow All                    | Everything except the **Denied Tools** list. This is the default.                                                      |
| `custom`              | Custom                       | The **Allowed Tools** list, minus the **Denied Tools** list. Anything else is left to the harness to ask about.        |
| `none`                | None                         | ctrlyoke passes no permission flags at all. The harness uses its own configuration, such as `~/.claude/settings.json`. |

`none` does not deny anything. It hands the decision back to the harness, so
use it when you already manage permissions in the harness itself. Setting
`toolPermissions: null` behaves the same as `mode: none`.

In the dashboard, set the mode on the **Permissions** tab of the
[workflow properties panel](/workflows/properties-panel#permissions), or from the
Permissions quick picker in the prompt editor's footer.

![Permissions tab in Custom mode with allowed and denied tool lists](/screenshots/permissions-tab-800x1600.png){.panel-shot}

### Headless runs

A [headless](/reference/settings#defaults-executionmode) step has no terminal, so an approval
prompt can never be answered. With `custom` mode, a tool that is not on the
allow list is refused and the step may not make progress. ctrlyoke warns once
when a headless step starts with a mode other than `allowAll` or
`dangerouslyAllowAll` (on Antigravity, other than `dangerouslyAllowAll`). Turn the warning off with
[`ui.showHeadlessPermissionWarning`](/reference/settings#ui-showheadlesspermissionwarning).

For CI, see [Tool permissions on CI](/cli/ci#tool-permissions).

## Tool patterns

**Allowed Tools** and **Denied Tools** are lists of patterns. A pattern is a
tool name, optionally followed by arguments in parentheses:

| Pattern                     | Matches                                                 |
| --------------------------- | ------------------------------------------------------- |
| `write`                     | Creating and writing files                              |
| `shell(npm test)`           | Exactly the shell command `npm test`                    |
| `shell(git add:*)`          | Any shell command that starts with `git add`            |
| `shell`                     | Every shell command                                     |
| `mcp__github__create_issue` | One tool from an MCP server: `mcp__<server-id>__<tool>` |

- `shell` and `bash` are the same tool. Other common names are `write`,
  `edit`, `read`, `glob`, `grep` and `webfetch`.
- `:*` at the end of the arguments matches anything after that prefix. A `*`
  must be inside the parentheses: write `shell(*)`, not `shell*`.
- **Denied Tools always wins.** A command that matches both lists is denied.
- ctrlyoke translates each pattern into the harness's own syntax. For example,
  Claude Code receives `shell(git add:*)` as `Bash(git add:*)`.
- Copilot CLI always allows read-only tools (`read`, `grep` and similar), so
  they are dropped from Copilot's lists.

The list editor in the dashboard suggests tool names as you type and marks a
pattern it can't parse: an unclosed parenthesis or invalid syntax is an error,
and a wildcard outside parentheses is a warning.

### The default lists

The [`defaults.toolPermissions`](/reference/settings#defaults-toolpermissions)
setting starts in `allowAll` mode with a deny list of destructive commands
(`rm`, `del`, `Remove-Item`, `sudo`, `chmod`, `git push`, `git reset`,
`git checkout`, `git clean`, `docker rm`, `kubectl delete` and a few more) and
an allow list of common development commands (`write`, `git status`,
`git diff`, `git add`, `git commit`, `git log`, `npm`, `yarn`, `pnpm`, `node`,
`npx`). The allow list only matters once you switch to `custom` mode.

Edit the defaults in **Settings → Workflow Defaults → Permissions**.

## Which level wins

`toolPermissions` can be set in three places. The first one that is set wins:

1. the step's own `toolPermissions`
2. the workflow's `toolPermissions`
3. the `defaults.toolPermissions` setting

The winning object is used **as a whole**; its fields are not merged with the
levels below. A step that sets only `mode: custom` gets empty allow and deny
lists, not the workflow's lists. A `toolPermissions` object without a `mode` is
treated as `allowAll`.

```yaml
toolPermissions:
  mode: allowAll
  deniedTools: [shell(git push:*)]
steps:
  - name: plan
    prompt: Read the codebase and write a plan to plan.md.
    toolPermissions:
      mode: custom
      allowedTools: [write]
      deniedTools: [shell]
  - name: implement
    prompt: Implement the plan in plan.md.
```

The `ctrlyoke` CLI can override the workflow level for one run with
`--permission-mode`, `--allow-tool` and `--deny-tool`. See
[Tool permissions](/cli/ctrlyoke#tool-permissions).

## How each harness applies them

Each mode reads only some of the lists, whatever harness runs the step:

| Mode                  | Allowed Tools | Denied Tools |
| --------------------- | ------------- | ------------ |
| `dangerouslyAllowAll` | ignored       | ignored      |
| `allowAll`            | ignored       | applied      |
| `custom`              | applied       | applied      |
| `none`                | ignored       | ignored      |

A list the mode ignores is not passed to the harness and never produces a
compatibility warning. Not every harness can enforce individual tool patterns
either: Codex and Antigravity only have coarse modes, so they ignore both lists
in every mode.

| Harness                                   | `dangerouslyAllowAll`                         | `allowAll`                                                                     | `custom`                                                                                                            |
| ----------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| [Copilot CLI](/harnesses/copilot-cli)     | `--yolo`                                      | `--allow-all-tools` plus `--deny-tool`                                         | `--allow-tool` plus `--deny-tool`                                                                                   |
| [Claude Code](/harnesses/claude-cli)      | `--dangerously-skip-permissions`              | `--permission-mode bypassPermissions --tools default` plus `--disallowedTools` | Headless: `--permission-mode dontAsk`; interactive: default mode; both use `--allowedTools` and `--disallowedTools` |
| [Codex](/harnesses/codex-cli)             | `--dangerously-bypass-approvals-and-sandbox`  | `--sandbox workspace-write --ask-for-approval on-request`                      | `-s` and `-a` from the `permissions.codex*` settings; lists ignored                                                 |
| [OpenCode](/harnesses/opencode-cli)       | no permission block (OpenCode's own defaults) | allow everything, plus the deny list                                           | ask for everything, allow the allow list, deny the deny list                                                        |
| [Qwen Code](/harnesses/qwen-cli)          | `-y`                                          | `--approval-mode auto-edit` plus `--exclude-tools`                             | `--approval-mode default` with `--allowed-tools` and `--exclude-tools`                                              |
| [Antigravity](/harnesses/antigravity-cli) | `--dangerously-skip-permissions`              | no flag (agy's own approvals); lists ignored                                   | `--sandbox`; lists ignored                                                                                          |

For example, `allowAll` with [the default lists](#the-default-lists) starts
Claude Code with:

```text
--permission-mode bypassPermissions --tools default
--disallowedTools "Bash(rm:*)" "Bash(del:*)" "Bash(Remove-Item:*)" "Bash(rd:*)" ...
```

The deny list is translated to Claude's syntax and the allow list is left out.

OpenCode receives its permissions through `OPENCODE_CONFIG_CONTENT` rather than
flags; see [Files ctrlyoke writes](/harnesses/files-ctrlyoke-writes#opencode-cli).
Codex's sandbox and approval policy for `custom` mode come from the
`permissions.codexSandboxMode` and `permissions.codexApprovalPolicy` settings, in
**Settings → Advanced Permissions**.

Claude Code's `custom` mode uses `dontAsk` in headless runs, which denies tools
that are not pre-approved, and uses its default prompting mode in interactive
runs. Claude's own settings allow rules also count as pre-approved in headless
mode, so an allow rule configured there can expand the effective allow list.

The [compatibility matrix](/harnesses/compatibility) records which harness
enforces each list.

### Workflows that mix harnesses

When a workflow's steps run on different harnesses, the Permissions tab shows a
note under each list naming the harnesses that won't enforce it. A step that
runs on such a harness also records a compatibility warning when it starts. A
list the mode ignores never warns: `dangerouslyAllowAll` skips both lists, and
`allowAll` skips the allow list.

## Trusted external folders {#trusted-external-roots}

ctrlyoke only reads files inside the workspace. A
[context reference](/workflows/context-files) such as `@C:/shared/specs/api.md`,
or a file link in the output, that points outside the workspace is blocked
unless its folder is a **trusted external root**.

This check follows symbolic links and Windows junctions before deciding where a
reference points. So `@link/file.md`, `@link/`, `#selection` and `#sym` are
blocked when `link` resolves outside the workspace, unless the resolved target
is under an approved trusted external root. Links that resolve back inside the
workspace continue to work. To allow a deliberate link to another folder, add
its target folder to `permissions.trustedExternalRoots`.

An approved root also reaches the harness. Copilot CLI, Claude Code, Codex and
Antigravity each receive it as `--add-dir`, so the agent can read and edit
files there. OpenCode and Qwen Code have no such option and don't receive it.

Roots come from three places:

| Where                                                            | Who approves it                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| `permissions.trustedExternalRoots` in your **user** settings     | Nobody. You wrote it on your own machine, so it is trusted at once. |
| `permissions.trustedExternalRoots` in the **workspace** settings | You, once per workspace on each machine.                            |
| `trustedExternalRoots` in a **workflow** file                    | You, once per workflow file on each machine.                        |

User and workspace roots are combined, unlike other list settings, which
replace each other (see [Settings](/guide/settings)).

### Approving a workspace's or workflow's roots

A workspace or workflow file can be shared or committed, so a root it lists is
only a **request**. Before it takes effect, ctrlyoke shows a single list of
every new folder: **This workspace requests N external file root(s)** or
**This workflow requests N external file root(s)**. Each folder is ticked;
untick one to keep it blocked, then click **Confirm**. **Ask me later**, or
closing the prompt, records nothing and asks again next time.

![The approval prompt titled "This workflow requests 2 external file root(s)", listing C:/dev/shared-specs ticked and C:/dev/design-assets unticked, with Ask me later and Confirm buttons](/screenshots/external-roots-approval-560x370.png)

VS Code asks about a workspace's roots only after you have trusted the
workspace in VS Code itself. A workflow's roots are asked about when the
workflow loads.

Your decisions are stored on your machine only, in
`~/.ctrlyoke/external-roots-trust.json`, and never in the workspace or workflow
file. A run whose workflow or workspace still has an undecided root does not
start. From a terminal, review them with:

```bash
ctrlyoke trust-external-roots                                   # the workspace's roots
ctrlyoke trust-workflow-external-roots my-workflow.ctrlyoke.yaml # one workflow's roots
```

Add `--yes` to approve every pending root without prompting, for example on a
CI runner. See [`ctrlyoke trust-external-roots`](/cli/ctrlyoke#ctrlyoke-trust-external-roots).

### Per-workflow roots

```yaml
trustedExternalRoots:
  - C:/Users/me/.codex/sessions
```

The workflow field has three states:

- **Omit it** to use the approved user and workspace roots. In the dashboard
  this is **Inherit**.
- **Set a list** to use exactly those roots for this workflow. The list
  **replaces** the user and workspace roots rather than adding to them. Use it
  to give one workflow a folder no other workflow needs, or to narrow a risky
  workflow to fewer folders than usual. A root already approved at user or
  workspace scope needs no new approval.
- **Set it to `null`** to block every external folder for this workflow, even
  ones trusted in your settings.

### Trust Parent Folder

When a file link in the output points outside every trusted root, opening it
offers **Trust Parent Folder** instead of opening the file. It trusts the
link's folder at the scope you pick:

- **Trust for me (all workspaces)** adds it to your user settings.
- **Trust for this workspace** adds it to the workspace settings and approves
  it.
- **Trust for this workflow** adds it to the workflow file's
  `trustedExternalRoots` and approves it. If the workflow inherited its roots,
  the current inherited roots are written into the file too, so the workflow
  keeps access to them.

Turn the offer off with
[`ui.offerTrustForUntrustedFileLinks`](/reference/settings#ui-offertrustforuntrustedfilelinks);
untrusted links are then simply blocked.

## Related

- [Secrets](/workflows/secrets): credentials a step may receive.
- [MCP servers](/workflows/mcp-servers): deny individual MCP tools with a
  server's `deniedTools`.
- [Settings reference: permissions](/reference/settings#permissions)
- [`toolPermissions` schema](/reference/workflow-schema#execution-properties-toolpermissions)
