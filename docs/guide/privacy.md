# Privacy and telemetry

ctrlyoke runs on your machine. Your prompts, code and AI output stay between you and the harness
CLIs you choose to run; ctrlyoke doesn't send them to us. This page is the practical summary. The
[Privacy Policy](https://ctrlyoke.dev/privacy) is the authoritative text.

## What never leaves your machine

ctrlyoke doesn't send any of this to Fuzzy Nova:

- prompt text, workflow files, and AI output
- source code, file contents, file paths, and workspace or repository names
- run history, session IDs, and workflow identifiers
- secrets, which stay on your machine, in your OS credential store or your environment
- names of agents, skills, MCP servers and end-condition scripts

The harnesses are separate programs. Copilot CLI, Claude Code, Codex, OpenCode, Qwen Code and
Antigravity send your prompts and code to their own providers under your own accounts, following
their own privacy policies.

## Telemetry

Only the **VS Code extension** sends telemetry, through Microsoft's `@vscode/extension-telemetry`
library. It contains operational data: which harness and execution mode ran, counts and durations,
feature flags, outcome and error type names, and the extension, VS Code and OS versions. When
the extension hits an unexpected error, VS Code also reports its message and stack trace, with
file paths and other personal-looking values redacted. The library adds pseudonymous VS Code
machine and device IDs and a per-launch session ID. The Privacy Policy lists every category.

**To turn it off**, set VS Code's `telemetry.telemetryLevel` to `off`. ctrlyoke follows that
setting; there is no separate ctrlyoke switch.

The **headless `ctrlyoke` commands other than `ctrlyoke server`, and
`ctrlyoke-mcp`, send no telemetry and make no network requests of their own**.
`ctrlyoke server` checks the Pro license for remote access, including LAN HTTPS,
and may contact Keygen to refresh a cached online Pro license. When push
notifications are enabled, it also sends notifications to browser push
services. See [Other network requests](#other-network-requests).

## Other network requests

| When                                                     | Contacts                           | What is sent                                                        |
| -------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------- |
| You activate, refresh or deactivate a Pro license online | Keygen (license service)           | License key, a machine identifier, OS platform, and your IP address |
| You browse or search the MCP registry in the MCP manager | `registry.modelcontextprotocol.io` | Your search text                                                    |
| Push notifications are on (Pro)                          | Your browser vendor's push service | An encrypted notification for your subscribed browser or phone      |

Activating Pro offline with a signed license file sends nothing. The 14-day remote-access trial
is tracked locally and sends nothing.

## The hosted dashboard

The browser dashboard is served **from your own machine**. Its traffic never passes through
Fuzzy Nova's servers.

- By default it listens only on `localhost`.
- LAN and remote access (Pro) exposes it to other devices that can reach your machine. Anyone
  with the dashboard URL, which includes its access token, can see and control your workflows,
  including prompts and output. Treat that URL like a password, and use HTTPS for anything beyond
  a trusted network.

## Local files

ctrlyoke writes logs to `.ctrlyoke/logs/` in the workspace, and run history under
`~/.ctrlyoke` (or `.ctrlyoke/.runs/` in workspace storage mode). They contain your prompts and
output and stay local. Delete them whenever you like; `ctrlyoke history prune` removes history for
projects that no longer exist. Runs and workflows you delete from the dashboard first go to
Recently deleted (a `.trash` directory beside the run history) and are removed for good after
`storage.trashRetentionDays`; `ctrlyoke history trash empty` removes them sooner.
