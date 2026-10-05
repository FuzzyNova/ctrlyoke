# Workspace `.ctrlyoke/settings.json` can choose the executable launched as the dashboard shell and script shell

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli), code reading
- **Area:** `src/config/CtrlYokeConfigService.ts` (`WORKSPACE_FORBIDDEN_SETTING_ROOTS`), `src/core/harness/PtyProcessManager.ts` (`spawnShell`, `resolveShellInvocation`)
- **Resolution:** fixed in this commit

## Symptom

A repository can commit `.ctrlyoke/settings.json` with
`{ "terminal": { "shellExecutable": "./tools/evil.exe" } }`. Opening a shell
terminal from the dashboard then launches that binary, even if no workflow from
the repo is ever run. The same setting also picks the shell for every inline
pre-condition, end-condition, and script step. That includes steps in the
user's own templates and global workflows run in that workspace.

VS Code fixed the same issue for its own setting by making
`terminal.integrated.shell*` non-workspace-settable. ctrlyoke never had an
equivalent fix. The extension was protected only incidentally: `package.json`
declares no `capabilities.untrustedWorkspaces`, so VS Code does not activate
it in Restricted Mode. The CLI had no gate at all.

## Root Cause

`spawnShell` and `resolveShellInvocation` used
`ConfigurationUtils.getTerminalSettings().shellExecutable` from the merged
config, so the workspace value won. The same applied to other workspace
values that choose a program to run, which the original report did not list:

- `defaults.additionalArgs.<harness>`: extra harness CLI flags (for example,
  Claude's `--settings` can inject harness hooks).
- `defaults.hooks[]`: hook commands.
- `defaults.mcpServers[]`: stdio MCP server commands.
- `defaults.endCondition` / `defaults.preCondition`: scripts run on every
  step.
- Workspace MCP registry entries, which override a user entry with the same ID
  and so can swap the command behind a server the user already attaches.

## Fix

Making these settings user-only was rejected because it breaks legitimate
per-workspace use, such as per-repo shells and MCP servers. Instead, a
workspace now only _requests_ these values. Each one takes effect after the
user approves that exact value for that workspace, mirroring
`permissions.trustedExternalRoots`:

- `WorkspaceSensitiveSettings.ts` lists the gated settings, and fingerprints
  each value (array entries one by one). A changed value is a new request.
  A value identical to the user's own setting needs no approval.
- `WorkspaceSettingsTrustStore` (`~/.ctrlyoke/workspace-settings-trust.json`)
  records allow/deny decisions per workspace identity, setting path, and
  fingerprint.
- `CtrlYokeConfigService.getWorkspaceSettings()` withholds every value that
  is not allowed, so the user value or the default applies.
  `McpRegistryFileManager.readAll()` does the same for registry entries.
  Undecided values are reported so a host can ask.
- A value the user saves through ctrlyoke's own settings UI or MCP manager is
  auto-approved, but only if the file did not already request it.
- **Extension:** the dashboard shows a batch-approval prompt. Every item
  starts unchecked, and "Ask me later" records nothing. The prompt appears at
  panel-ready, on workspace-trust grant, and whenever a new value is seen.
  The `ctrlyoke: Review Workspace Settings That Run Programs` command
  re-reviews past answers.
- **CLI:** `run`/`rerun`/`append`/`continue` ask about each undecided value in
  a terminal before the workflow loads. Without a terminal they exit `2` and
  name `ctrlyoke trust-workspace-settings [--yes] [--all]`.

`server.autoStart`, `server.bindAddress`, and `server.tls.*` are deliberately
not gated. The hosted server runs only from the extension, so VS Code
workspace trust already covers it. It requires a token, and a non-loopback
bind falls back to `127.0.0.1` without a remote-access entitlement.
