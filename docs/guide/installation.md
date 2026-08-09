# Installation

## Requirements

- VS Code 1.104 or later for the extension
- Node.js 22.17.0 or later for local development and CLI usage
- At least one supported harness installed and authenticated

## Install the extension

Install **ctrlyoke** from the VS Code Marketplace or clone the repository and run the extension locally during development.

After install, open the panel:

```text
Command Palette → ctrlyoke: Open ctrlyoke Panel
```

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

ctrlyoke expects a workspace-level `.ctrlyoke` folder for drafts, templates, scripts, runtime files, and logs.

```text
Command Palette → ctrlyoke: Initialize Workspace
```

That creates `.ctrlyoke/` and a self-ignoring `.gitignore` inside it — nothing else, so initializing does not leave your Git worktree dirty. Subdirectories such as `prompts/`, `scripts/`, `templates/`, `agents/`, and `skills/` are created on demand the first time you add something to them.

## Optional: install the standalone CLI

The repository also builds a standalone `ctrlyoke` binary entry point. Once installed, it can execute the same workflow files outside VS Code.

See [CLI overview](/cli/) for usage.
