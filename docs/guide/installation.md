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
available, it shows **No AI harness CLI is available** just below the header, listing each harness
with the command that installs it. A harness that is installed but older than the minimum
version ctrlyoke supports shows its update command instead; hover it to see the installed and
minimum versions. The panel is guidance only and doesn't block the dashboard. It disappears once
a harness is detected.

<!-- SHOT D6: Dashboard with the "No AI harness CLI is available" preflight panel below the header, listing all six harnesses with their install commands (one harness showing an update command if possible). -->

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

<!-- SHOT D9: The "Initialize ctrlyoke here?" overlay with its Initialize ctrlyoke button, in the VS Code side panel of a fresh workspace (npm run dev:host:start:onboarding); optionally paired with the Getting Started with ctrlyoke walkthrough page open in the editor area. -->

Right after you initialize a workspace from this prompt, the dashboard shows **One quick tip**:
the panel lives in the secondary side bar, and you can drag its tab to the bottom panel for a
wider layout. Click **Got it** to continue.

You can also run the command directly at any time:

```text
Command Palette → ctrlyoke: Initialize Workspace
```

That creates `.ctrlyoke/` and a self-ignoring `.gitignore` inside it — nothing else, so initializing does not leave your Git worktree dirty. Subdirectories such as `prompts/`, `scripts/`, `templates/`, `agents/`, and `skills/` are created on demand the first time you add something to them.

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
