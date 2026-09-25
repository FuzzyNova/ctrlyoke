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

The panel opens in the secondary side bar (far right) by default. If you prefer a wider, horizontal layout, drag the ctrlyoke tab down to the bottom panel. The **ctrlyoke: Show Getting Started** command reopens the built-in walkthrough at any time.

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

Start with `copilot-cli` or `claude-cli` unless you already know you need another harness.

## Initialize a workspace

ctrlyoke keeps workspace-level files such as settings, templates, scripts, prompts, attachments, and logs in a `.ctrlyoke` folder.

The first time you open the panel in a workspace that has no `.ctrlyoke/` folder, the dashboard asks **Initialize ctrlyoke here?** Click **Initialize ctrlyoke** to continue. You can also run the command directly at any time:

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
