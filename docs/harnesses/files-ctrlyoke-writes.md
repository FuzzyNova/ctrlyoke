# Files ctrlyoke writes

To detect when a step finishes, attach MCP servers, apply tool permissions and report usage,
ctrlyoke has to configure each harness CLI. Where a CLI accepts configuration on the command line
or through environment variables, ctrlyoke passes it that way and writes nothing. Where a CLI
only reads configuration from disk, ctrlyoke writes the smallest file it can, tracks exactly what
it added, and removes it again.

This page lists every file, per harness, so that nothing in `git status` or your home folder comes
as a surprise.

## Moved harness folders {#moved-harness-folders}

The paths on this page and elsewhere in these docs are the defaults. Several harnesses let you move
their global folder with an environment variable, and ctrlyoke reads and writes the moved folder
instead, so it finds the same transcripts, settings, MCP servers, agents and skills the harness
does:

| Harness     | Variable            | Replaces                                                |
| ----------- | ------------------- | ------------------------------------------------------- |
| Claude Code | `CLAUDE_CONFIG_DIR` | `~/.claude`, and `~/.claude.json` moves into the folder |
| Codex       | `CODEX_HOME`        | `~/.codex`                                              |
| Copilot     | `COPILOT_HOME`      | `~/.copilot`                                            |
| OpenCode    | `XDG_CONFIG_HOME`   | `~/.config` (OpenCode's global config)                  |
| Qwen Code   | `QWEN_HOME`         | `~/.qwen`                                               |
| Qwen Code   | `QWEN_RUNTIME_DIR`  | The Qwen folder that holds session transcripts          |

Set the variable in the environment you start VS Code or the `ctrlyoke` CLI from. The harness
inherits it from ctrlyoke, so both use the same folder. ctrlyoke doesn't read Qwen's
`advanced.runtimeOutputDir` setting; use `QWEN_RUNTIME_DIR` to move Qwen's transcripts.

## Every harness: `.ctrlyoke/temp/` {#ctrlyoke-temp}

Each run writes working files into the workspace's `.ctrlyoke/temp/` folder: prompt files,
generated MCP configuration, per-prompt hook settings, the signal files hook scripts write when a
step ends (`<cli>-notifications/`), and status line snapshots. The generated
`.ctrlyoke/.gitignore` ignores `temp/`, so none of it shows in `git status`.

Files are deleted when the prompt or run that used them finishes. When VS Code starts, ctrlyoke
also deletes anything left in `.ctrlyoke/temp/` that is more than 24 hours old, which covers runs
that were killed before they could clean up.

## Every harness with a status line: global settings {#status-line}

Claude Code, Copilot, Qwen Code and Antigravity can show a status line in their own terminal UI,
and Claude Code and Antigravity report their quota only through it. To read it, ctrlyoke points
that harness's global status line setting at a small script it keeps in `~/.ctrlyoke/bin/`:

| Harness     | File                                      | Key             |
| ----------- | ----------------------------------------- | --------------- |
| Claude Code | `~/.claude/settings.json`                 | `statusLine`    |
| Copilot     | `~/.copilot/settings.json`                | `statusLine`    |
| Qwen Code   | `~/.qwen/settings.json`                   | `ui.statusLine` |
| Antigravity | `~/.gemini/antigravity-cli/settings.json` | `statusLine`    |

Unlike everything else on this page, this is a lasting change, not a per-run one:

- It is installed the first time ctrlyoke runs that harness, and it stays in place between runs.
- If you already had a status line command, ctrlyoke saves it in its own settings
  (`statusLine.byHarness.<harness>.customCommand`) and runs it underneath, so your status line
  keeps working. The last non-empty output is cached per harness in
  `~/.ctrlyoke/cache/statusline-forwarded/<harness>.txt` and is shown if a later invocation times
  out.
- If your existing status line is not a command, ctrlyoke leaves it alone and turns its own off
  for that harness.
- To undo it, turn the harness off in **Settings → Status Line** (or set
  [`statusLine.byHarness.<harness>.enabled`](/reference/settings#statusline) to `false`). ctrlyoke
  then puts your original command back, or removes the key if there was none. `~/.ctrlyoke/bin/`
  is removed once no harness and no other ctrlyoke installation uses it.
- Uninstalling ctrlyoke does the same for every harness once the last ctrlyoke installation is
  gone. See [Uninstall](/guide/installation#uninstall).

## Per harness

### Copilot CLI

| What            | Where                                                    | Removed                                     |
| --------------- | -------------------------------------------------------- | ------------------------------------------- |
| Hooks           | `.github/hooks/ctrlyoke-<workflow>-p<step>.json`         | before the next step, and when the run ends |
| Git ignore file | `.github/hooks/.gitignore`                               | once no ctrlyoke hook files remain          |
| MCP servers     | `.ctrlyoke/temp/`, passed with `--additional-mcp-config` | when the run ends                           |
| Context window  | `.ctrlyoke/temp/ctrlyoke-otel-<workflow>-p<step>.jsonl`  | when the run ends                           |

Copilot has no command-line option for hooks; it loads every JSON file in the repository's
`.github/hooks/` folder, so ctrlyoke writes one hook file per step there. That folder is always at
the repository root, even when your workspace is a subfolder of the repository, because Copilot
does not read a subfolder's `.github/hooks/`; your own workflow hooks still run in the workspace
folder. To keep those files out of `git status`, it also writes a
`.gitignore` in that folder that ignores `ctrlyoke-*.json` and itself, but only if the folder has
no `.gitignore` of its own. Your own `.gitignore` is never edited.

The OpenTelemetry file is how ctrlyoke reads Copilot's live context-window size. ctrlyoke sets
`COPILOT_OTEL_FILE_EXPORTER_PATH` for each Copilot process it starts, which also overrides any
value you have set globally.

### Claude Code

| What        | Where                                                                                   | Removed           |
| ----------- | --------------------------------------------------------------------------------------- | ----------------- |
| Hooks       | `.ctrlyoke/temp/claude-hook-settings-<workflow>-p<step>.json`, passed with `--settings` | when the run ends |
| MCP servers | `.ctrlyoke/temp/mcp-config-claude-<workflow>.json`, passed with `--mcp-config`          | when the run ends |

Claude Code layers a `--settings` file over your own settings for that process only, so ctrlyoke
writes nothing outside `.ctrlyoke/` in the workspace. When a later step is typed into the same
running Claude session (terminal reuse), the hook file is kept until that terminal closes, because
Claude rereads it during the session.

### Codex CLI

Codex writes nothing to disk. Hooks, the trust entries for those hooks, MCP servers and approval
settings are all passed as `-c key=value` overrides on the command line. ctrlyoke never edits
`~/.codex/config.toml` or a project `.codex/` folder.

### OpenCode CLI

Permissions, MCP servers and ctrlyoke's completion plugin are passed to each OpenCode process in
the `OPENCODE_CONFIG_CONTENT` environment variable, and your hooks in another environment
variable. To avoid permission-key collisions, ctrlyoke reads OpenCode's global config files,
`OPENCODE_CONFIG`, project `opencode.json`/`opencode.jsonc` files from the worktree root through
the workspace, their `.opencode/` counterparts, and `OPENCODE_CONFIG_DIR`. It never writes these
files or a workspace `opencode.json`. The plugin is loaded straight from ctrlyoke's install folder.

One fallback writes files: if OpenCode 1 cannot load the plugin from the install folder, ctrlyoke
copies it to `.opencode/plugin/ctrlyoke-completion-hook.ts` (with your hooks in
`.opencode/plugin/ctrlyoke-hooks.json`) and deletes both when the run ends. OpenCode 2 has no such
fallback and never gets workspace files.

### Qwen Code

| What  | Where                                           | Removed           |
| ----- | ----------------------------------------------- | ----------------- |
| Hooks | `.ctrlyoke/temp/qwen-system-settings-<id>.json` | when the run ends |

Qwen reads hooks only from settings files, and since Qwen 0.26.9 it holds hooks in the workspace
`.qwen/settings.json` back until you approve them in its terminal UI, which a ctrlyoke step can't
do. So each Qwen launch gets its own copy of Qwen's system settings file (`C:\ProgramData\qwen-code\settings.json`,
`/Library/Application Support/QwenCode/settings.json` or `/etc/qwen-code/settings.json`, or the
file `QWEN_CODE_SYSTEM_SETTINGS_PATH` names) with ctrlyoke's hooks and the workflow's `hooks`
appended, and ctrlyoke points Qwen at it with `QWEN_CODE_SYSTEM_SETTINGS_PATH`. Everything else in
the system file is kept, and your own `.qwen/settings.json` is not changed. If the system file
exists but can't be read, the step fails rather than run without the settings it holds.

ctrlyoke 0.4 and earlier added hooks to `.qwen/settings.json` instead. A launch removes any of
those that an interrupted run left behind (only groups whose ctrlyoke process has exited), and
deletes the file and its `.qwen/.gitignore` if ctrlyoke had created them.

MCP servers are passed as inline JSON with `--mcp-config` and are not written anywhere.

### Antigravity CLI

| What        | Where                         | Removed                                                         |
| ----------- | ----------------------------- | --------------------------------------------------------------- |
| MCP servers | `.agents/mcp_config.json`     | when the last ctrlyoke run in the workspace that uses them ends |
| Hooks       | `~/.gemini/config/hooks.json` | when the run ends                                               |

`agy` has no command-line option for MCP servers; it discovers them from the workspace
`.agents/mcp_config.json`. ctrlyoke adds its servers to that file, keeps any servers that were
already there, and removes its own when no running workflow needs them. If ctrlyoke created the
file, it deletes it, together with a temporary `.agents/.gitignore`. On macOS and Linux the file is
written readable only by you when a server's `env` or `headers` contain a secret. There is no
per-prompt server scoping, so workflows running in parallel in one workspace see each other's
servers.

`agy` only reads hooks from the global `~/.gemini/config/hooks.json`. ctrlyoke adds one named group
per workflow, `ctrlyoke-<id>`, and removes that group when the run ends. When a later step is
typed into the same running `agy` session (terminal reuse), the group is kept until that terminal
closes, because `agy` rereads the file whenever a hook fires.

## Parallel runs

Several workflows can run at once in one workspace, so cleanup never resets a whole file:

- Per-step files are named after the workflow file and the step, so parallel workflows never write
  the same file.
- For shared files (`.agents/mcp_config.json`, `~/.gemini/config/hooks.json`), ctrlyoke records which entries
  belong to which running workflow. A finishing run removes only its own entries. The file's
  original content comes back only when the last ctrlyoke run using it ends.
- The `.github/hooks/.gitignore` for Copilot stays while any workflow still has a hook file in that
  folder.

## Why a file can show up in `git status`

ctrlyoke hides the files it creates, but some changes can still show while a run is active:

- **A tracked file was edited.** If you commit `.qwen/settings.json` or `.agents/mcp_config.json`,
  it shows as modified during the run and goes back to its committed content afterwards.
- **The folder already has your own `.gitignore`.** ctrlyoke doesn't edit a `.gitignore` it didn't
  write, so a new file such as `.github/hooks/ctrlyoke-*.json` shows as untracked until the run
  ends. Add `ctrlyoke-*.json` to that `.gitignore` if this bothers you.
- **A run was killed.** If VS Code or the CLI is killed mid-run, cleanup can't run. Leftovers are
  easy to spot by name: delete `ctrlyoke-*.json` from `.github/hooks/`, delete `ctrlyoke-…` groups
  from `~/.gemini/config/hooks.json`, and remove ctrlyoke's hooks from `.qwen/settings.json` or
  ctrlyoke's servers from `.agents/mcp_config.json`. Never commit these files with ctrlyoke's
  entries in them; they contain absolute paths to this machine.
