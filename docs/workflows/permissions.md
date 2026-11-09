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
setting starts in `allowAll` mode with a short deny list, plus a starter allow
list for when you switch to `custom` mode. `allowAll` ignores the allow list.

The starter allow list covers everyday development commands: `write`,
`git status`, `git diff`, `git show`, `git log`, `git add`, `git commit`,
`git mv`, `git rm`, `npm`, `yarn`, `pnpm`, `node` and `npx`. It's meant to get
an unattended `custom` run working, not to lock it down. `node`, `npx` and
package-manager scripts can run any code, so with this list `custom` is close
to `allowAll`. To restrict a workflow, replace the list with only the commands
it needs, such as `shell(npm test)` instead of `shell(npm:*)`.

The deny list covers commands that git can't undo or that reach beyond your
machine: `sudo`, `git push`, `git reset --hard`, `git checkout`,
`git restore`, `git clean`, `npm publish`, `yarn publish`, `pnpm publish` and
`kubectl delete`. It doesn't deny deleting files. Agents delete and rename
files as a normal part of development, and a denied `rm` only sends them to an
equivalent `node` or `python` command.

A deny list catches an agent's usual command. It is not a security boundary,
because an agent can reach the same result another way. If you need a hard
boundary, run the harness in a container or sandbox. Inside one,
`dangerouslyAllowAll` is a reasonable choice. Copilot CLI, Claude Code,
OpenCode, Qwen Code and Antigravity enforce supported deny entries. Codex
enforces only its MCP tool entries (see
[How each harness applies them](#how-each-harness-applies-them)). Because
nobody chose the default list, a harness that can't enforce it shows an
information note rather than a compatibility warning. Once you change the list,
it warns.

Edit the defaults in **Settings → Workflow Defaults → Permissions**.

## Sandboxing {#sandboxing}

Tool permissions control **approval**: which actions can run without asking.
Sandboxing controls **containment**: where terminal commands can write. They
are separate controls, and `sandbox` takes one of three values:

| Value   | Shown as | What ctrlyoke passes the harness                                                     |
| ------- | -------- | ------------------------------------------------------------------------------------ |
| `true`  | On       | Its sandbox flags, set by `sandboxMode`. Fails on a harness that can't sandbox       |
| `false` | Off      | Its off switch, which also turns off a sandbox enabled in the harness's own settings |
| `null`  | None     | No sandbox flags at all, so the harness's own settings and `config.toml` decide      |

When a step leaves `sandbox` out, it inherits the workflow's value, then the
`defaults.sandbox` setting. The shipped default is `false` (Off).

`sandboxMode` sets how strict On is:

- `workspace-write` (the default) lets terminal commands write the workspace,
  approved external roots, temp directories and the harness's own caches.
- `read-only` lets them write none of the workspace. Codex runs
  `-s read-only`, which covers its file edits too. Claude Code denies Bash
  writes to the workspace; its built-in Write and Edit tools still follow
  tool permissions.

`sandboxMode` inherits like `sandbox` (step, workflow, `defaults.sandboxMode`)
and has no effect unless `sandbox` resolves to `true`; diagnostics note a
`sandboxMode` set where that isn't the case.

Containment covers where terminal commands can write. **ctrlyoke does not
control network access**: it is set by each harness's own sandbox settings, as
the table shows. Harness file tools and MCP servers may have different
boundaries.

Codex declares exact support for this terminal-containment contract. Claude is
partial: its Bash commands are contained, but its built-in Write and Edit tools
can still change outside files when tool permissions allow them (verified on
macOS with Claude Code 2.1.317). Network policy is separate from these ratings.

On Windows, Claude Code has no Bash sandbox, so it is treated like a harness
that can't sandbox: a `true` written in the workflow or a step fails before
launch, and one inherited from `defaults.sandbox` only warns. Codex's Windows
sandbox contains writes but does not block network access.

| Harness                                   | On (`true`)                                                                                       | Off (`false`)                              | Network when On                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| [Codex](/harnesses/codex-cli)             | `-s workspace-write` or `-s read-only`, with the workspace's Git directories as writable roots    | `-s danger-full-access`                    | Off unless `sandbox_workspace_write` in `config.toml` enables it; always on under Windows |
| [Claude Code](/harnesses/claude-cli)      | `--settings` turns on the Bash sandbox, requires it to be available and limits where it can write | `--settings` with `sandbox.enabled: false` | Set by `sandbox.network` in Claude's settings files                                       |
| [Copilot CLI](/harnesses/copilot-cli)     | Not supported: its sandbox also blocks ctrlyoke's MCP server and hooks                            | `--no-sandbox`                             | —                                                                                         |
| [Qwen Code](/harnesses/qwen-cli)          | Not supported: its sandbox wraps the whole CLI and its helpers                                    | `--sandbox=false` and `QWEN_SANDBOX=false` | —                                                                                         |
| [Antigravity](/harnesses/antigravity-cli) | Not supported: its sandbox makes the workspace read-only                                          | Nothing to turn off                        | —                                                                                         |
| [OpenCode](/harnesses/opencode-cli)       | Not supported: no per-run terminal sandbox is available                                           | Nothing to turn off                        | —                                                                                         |

A `true` written in the workflow or a step fails the step before launch
whenever ctrlyoke can't honor it, on an unsupported harness or when the
sandbox is otherwise unavailable. A `true` inherited from `defaults.sandbox`
only warns on those harnesses and passes nothing, so you can turn the sandbox
on everywhere and still run steps on harnesses that can't sandbox.

Off and None can't override a policy your administrator manages: a managed
Claude Code settings file, a Copilot organization policy, or Qwen's
`tools.executionSandbox` setting still apply.

For example, turn containment on for every step and keep one read-only:

```yaml
sandbox: true
steps:
  - name: review
    prompt: Review the code and report problems without changing anything.
    sandboxMode: read-only
  - name: install
    prompt: Install the project dependencies.
```

### External roots and the sandbox {#external-roots-and-the-sandbox}

Approved [external roots](/reference/settings#external-file-roots) are handed
to the harness as extra directories, and to its sandbox as extra writable
places. A root never overrides the sandbox, and the sandbox never blocks an
approved root, except in read-only mode:

| Sandbox               | Codex                                                      | Claude Code                                                                       |
| --------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| On, `workspace-write` | Terminal commands can write each root (`--add-dir`)        | Bash can write each root (`sandbox.filesystem.allowWrite`)                        |
| On, `read-only`       | Roots are not passed; terminal commands can write nothing  | Bash writes to each root are denied; Write and Edit still follow tool permissions |
| Off                   | Roots are passed, but terminal commands can write anywhere | Roots widen the file tools' reach; Bash can write anywhere                        |
| None                  | Roots are passed and `config.toml` decides the mode        | Claude's own settings decide                                                      |

So a workflow's `trustedExternalRoots` limits where **terminal commands** can
write only while `sandbox` resolves to On. With the sandbox Off or None, the
list still limits which outside directories ctrlyoke and the harness's file
tools are given, but a shell command can write anywhere your account can.

Under None, interactive Codex refuses to start when your `config.toml` sets
`sandbox_mode = "read-only"` and the workflow has any approved external root
(`codex exec` ignores the roots instead). Use `sandbox: true` with
`sandboxMode: read-only` for that combination.

A workspace `defaults.sandbox` that is less contained than your own value
(`false` or `null` while yours is `true`, or `false` while yours is `null`)
waits for your approval before it applies. So does a workspace
`defaults.sandboxMode: workspace-write` while yours is `read-only`. A more
contained workspace value applies without asking.

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
compatibility warning. Not every harness can enforce every individual pattern.
Antigravity translates supported patterns for `custom` and `allowAll`; in
`allowAll`, it auto-approves tools while enforcing the deny list. Its web-search
deny cannot be enforced because agy's `search_web` tool is ungated. It has no
separate list/search tools, so denies for `glob`, `grep`, `ls`, `list`,
`list_directory` and `lsp` cannot be enforced either. An allowed `write` also
allows reads because agy's `write_file` permission implies `read_file`. No mode
adds agy's `--sandbox`. A workflow `additionalArgs` value that
contains `--settings` takes precedence over ctrlyoke's settings and disables
the permission translation. Codex ignores the allow list. From the deny list
it enforces only `mcp__<server>__<tool>` entries for MCP servers the workflow
attaches, which it receives as that server's `disabled_tools`. It can't enforce
an entry for a server configured only in Codex's own `config.toml`, a wildcard
tool name, or a shell pattern.

| Harness                                   | `dangerouslyAllowAll`                            | `allowAll`                                                                     | `custom`                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| [Copilot CLI](/harnesses/copilot-cli)     | `--yolo`                                         | `--allow-all-tools` plus `--deny-tool`                                         | `--allow-tool` plus `--deny-tool`                                                                                                  |
| [Claude Code](/harnesses/claude-cli)      | `--dangerously-skip-permissions`                 | `--permission-mode bypassPermissions --tools default` plus `--disallowedTools` | Headless: `--permission-mode dontAsk`; interactive: `--permission-mode default`; both use `--allowedTools` and `--disallowedTools` |
| [Codex](/harnesses/codex-cli)             | `-a never`                                       | `-a on-request` plus MCP `disabled_tools`                                      | `-a on-request` plus MCP `disabled_tools`; allow list ignored                                                                      |
| [OpenCode](/harnesses/opencode-cli)       | no permission block (OpenCode's own defaults)    | allow everything, plus the deny list                                           | ask for everything, allow the allow list, deny the deny list                                                                       |
| [Qwen Code](/harnesses/qwen-cli)          | `-y`                                             | `--approval-mode auto-edit` plus `--exclude-tools`                             | `--approval-mode default` with `--allowed-tools` and `--exclude-tools`                                                             |
| [Antigravity](/harnesses/antigravity-cli) | `--dangerously-skip-permissions` (lists ignored) | `--settings` with `always-proceed` and the deny list                           | `--settings` with allow and deny lists; allowed command rules match the whole command line                                         |

Antigravity command allow rules match the entire raw command line. A command
chain containing an allowed command plus anything else is not allowed piecemeal.
In `custom`, an unlisted command is left for agy to review, so headless runs
soft-deny it. Its `--settings` file also includes the user's global allow/deny
rules; project and shared rules remain in force. See
[Antigravity CLI permissions](/harnesses/antigravity-cli#permissions).

For example, `allowAll` with [the default lists](#the-default-lists) starts
Claude Code with:

```text
--permission-mode bypassPermissions --tools default
--disallowedTools "Bash(sudo:*)" "Bash(git push:*)" "Bash(git reset --hard:*)" ...
```

The deny list is translated to Claude's syntax and the allow list is left out.

OpenCode receives its permissions through `OPENCODE_CONFIG_CONTENT` rather than
flags; see [Files ctrlyoke writes](/harnesses/files-ctrlyoke-writes#opencode-cli).
In `none` and `dangerouslyAllowAll`, OpenCode's own setting decides whether it
may use folders outside the workspace: OpenCode 1 asks and OpenCode 2 allows.
See [Folders outside the workspace](/harnesses/opencode-cli#outside-the-workspace).
Codex's `-a` approval flag is passed only in interactive runs; `codex exec`
never asks. Its `-s` sandbox flag comes from [`sandbox`](#sandboxing) alone, in
every permission mode, so a denied `write` or `shell` is reported as not
enforced rather than turning the sandbox read-only. Use `sandboxMode: read-only`
for that.

Claude Code's `custom` mode uses `dontAsk` in headless runs, which denies tools
that are not pre-approved, and the `default` mode in interactive runs, which
asks before using them. ctrlyoke passes that mode explicitly, so a
`permissions.defaultMode` such as `bypassPermissions` in your Claude settings
does not turn off the prompts. Claude's own settings allow rules still count as
pre-approved, so an allow rule configured there can expand the effective allow
list.

The [compatibility matrix](/harnesses/compatibility) records which harness
enforces each list.

### Workflows that mix harnesses

When a workflow's steps run on different harnesses, the Permissions tab shows a
note under each list naming the harnesses that won't enforce it. The Sandbox row
shows an error when the selected harness can't sandbox. A `sandbox: true`
written in the workflow or step is an error on an unsupported harness in
compatibility diagnostics and Dry Run, and launch fails closed; one inherited
from `defaults.sandbox` is a warning. A step with a permission mismatch records a
compatibility warning when it starts. A
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

An approved root also reaches the harness, so the agent can read and edit
files there. Copilot CLI, Claude Code, Codex and Antigravity each receive it as
`--add-dir`, and OpenCode as an `external_directory` allow rule. Qwen Code has
no such option and doesn't receive it.

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
