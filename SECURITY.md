# Security Policy

## Supported Versions

ctrlyoke ships as a single, continuously-updated VS Code Marketplace listing — clients auto-update to the latest release, so only the **most recently published version** is supported. There are no maintained long-term-support branches.

## Reporting a Vulnerability

**Please do not open a public GitHub Issue for security vulnerabilities.**

Instead, email **security@ctrlyoke.dev** with:

- A description of the vulnerability and its potential impact.
- Steps to reproduce (a minimal workflow file or repro repo helps a lot).
- The ctrlyoke version and platform (OS, VS Code version) you tested against.

We'll acknowledge your report as promptly as we can and keep you updated as we investigate and fix the issue. Once a fix ships, we'll credit you in the release notes if you'd like (just let us know your preference in the report).

## Scope

ctrlyoke executes AI coding harnesses (Copilot CLI, Claude Code, Codex, OpenCode, Qwen Code, Antigravity CLI) against your local workspace and, optionally, exposes a dashboard over your local network. Reports about workspace-scoping, process isolation, remote-access authentication, or secret-handling/redaction are especially relevant to this project's threat model.
