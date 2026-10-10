ctrlyoke reads its settings from two `settings.json` files. Both use the
same shape:

- **User scope:** `~/.ctrlyoke/settings.json`. Applies to every workspace.
- **Workspace scope:** `.ctrlyoke/settings.json` in the workspace. Applies
  only to that workspace and overrides user values.

Objects merge key by key across the two files. An array or a single value in
the workspace file replaces the user value entirely. The one exception is
[`permissions.trustedExternalRoots`](#external-file-roots): ctrlyoke
combines the roots from both files. When you run the `ctrlyoke` CLI, the
flags you pass override both files for that run.

Some settings are machine-specific and are read only from user scope:
`worktrees`, `storage`, `statusLine`, `usageTracking.enabled`,
`languageServers.idleShutdownMinutes`, `languageServers.maxRunning`, and
`languageServers.startOnLaunch`. ctrlyoke ignores these settings in a workspace file.

### Settings that run programs

Some settings choose a program for ctrlyoke to run:

- `terminal.shellExecutable`
- `defaults.additionalArgs`
- `defaults.hooks`
- the entries in `defaults.mcpServers` that launch a command
- `defaults.endCondition` and `defaults.preCondition`
- servers in the workspace MCP registry that launch a command

A repository can commit any of these in its `.ctrlyoke/settings.json`. So a
workspace value takes effect only after you approve that exact value on your
machine. Until then, ctrlyoke uses your user value, or the default.

- **In VS Code**, the dashboard asks when it opens. Check only the values you
  trust. **Ask me later** decides nothing.
- **In the CLI**, `ctrlyoke run` asks in a terminal before it loads the
  workflow. Without a terminal, it exits with code `2`. Review the values
  with `ctrlyoke trust-workspace-settings`, or approve them all with `--yes`.

You don't need to approve a value you saved through the dashboard's Settings
page, or one that matches your user value. If the value in the file changes,
ctrlyoke asks again. To change an earlier answer, run **ctrlyoke: Review
Workspace Settings That Run Programs** from the Command Palette, or
`ctrlyoke trust-workspace-settings --all`. ctrlyoke stores your answers on the
local machine and never writes them into the workspace.

The dashboard's Settings page edits these files for you. If you edit a file by
hand in VS Code, ctrlyoke checks every `.ctrlyoke/settings.json` against its
settings schema, so completion and error checking work as you type. Don't
add a `$schema` key in VS Code: a `$schema` URL replaces the extension's
bundled schema, so VS Code downloads the published copy instead, which fails
offline and needs `ctrlyoke.dev` in `json.schemaDownload.trustedDomains`. In
other editors, set `$schema` to
`https://ctrlyoke.dev/schema/v1/settings.json`. Every key is optional, and a
key you leave out keeps the default shown below.

```json
{
  "defaults": {
    "harness": "claude-cli",
    "models": { "claude-cli": "sonnet" },
    "executionMode": "headless"
  },
  "execution": { "scriptTimeoutSec": 120 },
  "queue": { "maxParallelSteps": 4 }
}
```

Settings under [`defaults`](#defaults) set the starting values for workflow
fields. A workflow or step that sets the same field overrides them. See the
[workflow schema reference](/reference/workflow-schema) for the workflow
fields.
