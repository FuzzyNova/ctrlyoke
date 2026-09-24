ctrlyoke reads its settings from two `settings.json` files. Both use the
same shape:

- **User scope:** `~/.ctrlyoke/settings.json`. Applies to every workspace.
- **Workspace scope:** `.ctrlyoke/settings.json` in the workspace. Applies
  only to that workspace and overrides user values.

Objects merge key by key across the two files. An array or a single value in
the workspace file replaces the user value entirely.

Some settings are machine-specific and are read only from user scope:
`worktrees`, `storage`, `permissions.statusLineTracking`, and
`usageTracking.enabled`. ctrlyoke ignores these settings in a workspace file.

The dashboard's Settings page edits these files for you. To edit a file by
hand, point your editor at `schemas/settings-schema.json` to get completion and
validation. Every key is optional, and a key you leave out keeps the default
shown below.

```json
{
  "defaults": {
    "harness": "claude-cli",
    "models": { "claude-cli": "sonnet" },
    "executionMode": "headless"
  },
  "execution": { "scriptTimeout": 120 },
  "queue": { "maxParallelSteps": 4 }
}
```

Settings under [`defaults`](#defaults) set the starting values for workflow
fields. A workflow or step that sets the same field overrides them. See the
[workflow schema reference](/reference/workflow-schema) for the workflow
fields.
