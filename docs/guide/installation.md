# Installation

## Requirements

- VS Code 1.106 or later for the extension
- Node.js 22.12.0 or later on `PATH`. The extension starts its MCP server with `node`, and the
  CLI is a Node.js program
- At least one supported harness installed and authenticated

## Install the extension

Install **ctrlyoke** from the VS Code Marketplace or clone the repository and run the extension locally during development.

After install, open the panel:

```text
Command Palette → ctrlyoke: Open ctrlyoke Panel
```

The panel opens in the secondary side bar (far right) by default. If you prefer a wider, horizontal layout, drag the ctrlyoke tab down to the bottom panel.

### Getting Started walkthrough {#walkthrough}

The first time the extension starts after install, VS Code opens the **Getting Started with
ctrlyoke** walkthrough. It has six steps, each ticked off as you do it:

1. **Open the ctrlyoke panel**
2. **Install and verify a harness CLI**
3. **Create a workflow from a template**
4. **Run it and read the output**
5. **Optional: use the CLI outside VS Code**: install the `ctrlyoke` command from npm for other
   shells and CI (see [The command-line tool](#the-command-line-tool))
6. **Get help when you're stuck**

The **ctrlyoke: Show Getting Started** command reopens the walkthrough at any time.

<!-- SHOT D9 (walkthrough half): The Getting Started with ctrlyoke walkthrough page open in the editor area, landscape, at 1.5x or better. -->

## Install a harness

ctrlyoke does not bundle AI assistants. It orchestrates harnesses that you already have installed.

| Harness           | What you need                                   |
| ----------------- | ----------------------------------------------- |
| `copilot-cli`     | GitHub Copilot CLI installed and signed in      |
| `claude-cli`      | Claude Code CLI installed and signed in         |
| `codex-cli`       | Codex CLI installed and signed in               |
| `opencode-cli`    | OpenCode CLI configured with a provider         |
| `qwen-cli`        | Qwen Code CLI installed and configured          |
| `antigravity-cli` | Antigravity CLI (`agy`) installed and signed in |

Any one of them is enough to get started — use the harness you already have. See
[Harness overview](/harnesses/) for how they differ.

### When no harness is found {#missing-harness}

When the dashboard starts, it checks every supported CLI on your `PATH`. If none of them is
available, it shows **No CLI coding agent is available** just below the header, listing each harness
with the command that installs it on your operating system (PowerShell on Windows, a shell
command on macOS and Linux). A long command is cut off to fit; hover it to read it in full, or
use the copy button at the end of its row. A harness that is installed but older than the minimum
version ctrlyoke supports shows its update command instead; hover it to see the installed and
minimum versions. The panel is guidance only and doesn't block the dashboard. It disappears once
a harness is detected.

![The No CLI coding agent is available panel below the dashboard header, listing all six harnesses with their Windows install commands and a copy button on each row](/screenshots/harness-preflight-missing-660x1270.png){.panel-shot}

Install a harness, sign in with its own CLI, then let ctrlyoke check again: reload the window, or
click **Retry** next to the harness picker.

The harness picker marks each harness with a status dot:

| Dot     | Meaning                                                |
| ------- | ------------------------------------------------------ |
| Green   | Available                                              |
| Amber   | Available, but older than the recommended version      |
| Red     | Not available. The row is dimmed and can't be selected |
| Pulsing | Still checking                                         |

Hover a harness to see why it is unavailable: its install command, or the version it needs. When
the selected harness is unavailable, a **Retry** button next to the picker runs detection again.

## Initialize a workspace

ctrlyoke keeps workspace-level files such as settings, templates, scripts, prompts, attachments, and logs in a `.ctrlyoke` folder.

The first time you open the panel in a workspace that has no `.ctrlyoke/` folder, the dashboard asks **Initialize ctrlyoke here?** Click **Initialize ctrlyoke** to continue. The dashboard stays covered by this prompt until you do. The hosted browser dashboard shows the same prompt.

![The Initialize ctrlyoke here? prompt covering the dashboard, explaining the .ctrlyoke folder, with an Initialize ctrlyoke button](/screenshots/initialize-prompt-660x1270.png){.panel-shot}

Right after you initialize a workspace from this prompt, the dashboard shows **One quick tip**:
the panel lives in the secondary side bar, and you can drag its tab to the bottom panel for a
wider layout. Click **Got it** to continue.

You can also run the command directly at any time:

```text
Command Palette → ctrlyoke: Initialize Workspace
```

That creates `.ctrlyoke/` and a self-ignoring `.gitignore` inside it — nothing else, so initializing does not leave your Git worktree dirty. Subdirectories such as `prompts/`, `scripts/`, `templates/`, `agents/`, and `skills/` are created on demand the first time you add something to them.

### A window with no folder open

ctrlyoke needs a folder to work in. In a VS Code window with no folder open, the dashboard shows
**Open a folder to use ctrlyoke** with **Open Folder…** and **Open Recent…** buttons, and nothing
runs or is written until you choose one. Once a folder opens, VS Code restarts its extensions, and
the dashboard continues with the initialize prompt above if that folder has no `.ctrlyoke/` yet.
The hosted dashboard server needs a folder too, so it does not start in such a window.

## The command-line tool

The extension includes the `ctrlyoke` command-line tool. In VS Code's integrated terminals it is
already on `PATH`, so `ctrlyoke run`, `ctrlyoke validate` and the other commands work there with
no setup. Nothing is added to your system `PATH`.

To use the CLI anywhere else (another terminal, CI, a server or a container), install it from
npm:

```bash
npm install -g ctrlyoke
```

If you also use the extension, install the extension's exact version, so both copies read and
write shared state the same way:

```bash
npm install -g ctrlyoke@<extension version>
```

**ctrlyoke: Install CLI for Use Outside VS Code** opens a terminal with that command typed in for
you to review and run. For a one-off run, `npx ctrlyoke@<version> …` works without installing.

See [CLI overview](/cli/) for how the two copies coexist, and [CLI in CI](/cli/ci) for pipelines.

## Uninstall {#uninstall}

Almost everything ctrlyoke writes outside your workspaces is removed when the run that wrote it
ends. The exception is the [status line](/guide/usage-and-stats#status-line): ctrlyoke points the
global settings of Claude Code, Copilot, Qwen Code and Antigravity at scripts it keeps in
`~/.ctrlyoke/bin/`, and that stays in place between runs (see
[Files ctrlyoke writes](/harnesses/files-ctrlyoke-writes#status-line)).

Uninstalling ctrlyoke takes this back out. Each harness gets back the status line command it had
before ctrlyoke, or loses the setting if it had none, and `~/.ctrlyoke/bin/` is deleted. A status
line you changed yourself after ctrlyoke installed its own is left alone.

The VS Code extension and the npm CLI share the status line, so it is removed only when the last
ctrlyoke installation goes. If you uninstall the extension but keep the npm CLI, or the other way
round, the status line stays for the copy you kept. It is removed when that copy is uninstalled
too, whichever order you do it in.

### The VS Code extension

Uninstall ctrlyoke from the Extensions view, then restart VS Code. VS Code finishes removing an
extension the next time it starts, and that is when ctrlyoke's cleanup runs.

### The npm CLI

npm runs no cleanup when it removes a package, so run
[`ctrlyoke uninstall`](/cli/ctrlyoke#ctrlyoke-uninstall) first:

```bash
ctrlyoke uninstall
npm uninstall -g ctrlyoke
```

### What is kept

Uninstalling leaves your data, so reinstalling picks up where you left off:

- `~/.ctrlyoke/`, with your user settings, run history and trust decisions (or the folder
  `CTRLYOKE_HOME` points to)
- each workspace's `.ctrlyoke/` folder
- [managed secrets](/workflows/secrets), which live in your operating system's credential store
  (or, on a machine without one, in `secrets.json` in that same folder). Remove them with
  `ctrlyoke secret rm <NAME>` before uninstalling.

Delete those folders yourself to remove everything.
