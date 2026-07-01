---
layout: home

hero:
  name: ctrlyoke
  text: AI workflow automation for VS Code and the command line
  tagline: Run structured multi-step AI workflows, validate the result with scripts, and keep working across harnesses without rewriting your prompts.
  actions:
    - theme: brand
      text: Quick start
      link: /guide/quick-start
    - theme: alt
      text: Workflow schema
      link: /reference/workflow-schema
    - theme: alt
      text: GitHub
      link: https://github.com/nhickster/ctrlyoke

features:
  - title: One workflow format
    details: Write workflows in YAML, JSON, or simple Markdown prompts. The same schema works across the extension and the standalone CLI.
  - title: Seven harnesses
    details: Switch between Copilot CLI, Claude CLI, Codex CLI, OpenCode CLI, Qwen CLI, Gemini CLI, and Copilot Chat.
  - title: Validation and retries
    details: Gate prompts with end conditions, pre-conditions, and script steps so workflows can stop, continue, or retry based on real project output.
  - title: Stateful execution
    details: Resume sessions across steps, inject prior context, and let final steps extend the queue through the built-in ctrlyoke MCP server.
---

## What ctrlyoke is for

ctrlyoke turns AI assistants into a repeatable workflow runner. Instead of pasting one prompt at a time, you define a sequence of steps, choose a harness, and let ctrlyoke execute the work while keeping outputs, session history, and validation results together.

It ships in two forms:

| Surface           | What it is                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| VS Code extension | Dashboard UI, prompt editor, embedded terminal, schema validation, and harness orchestration inside VS Code |
| `ctrlyoke` CLI    | Headless or interactive workflow execution from a terminal or CI job                                        |
| `ctrlyoke-mcp`    | Standalone MCP server used for queue inspection and queue extension                                         |

## Where to start

- New here: [Installation](/guide/installation) and [Quick start](/guide/quick-start)
- Writing workflows: [Workflow overview](/workflows/) and [YAML format](/workflows/yaml-format)
- Choosing a harness: [Harness overview](/harnesses/)
- Looking up fields: [Workflow schema reference](/reference/workflow-schema)

## Current documentation scope

This first docs pass focuses on the public surface that is most useful during setup and authoring: installation, workflow syntax, harness selection, key settings, CLI usage, and troubleshooting. Deeper per-harness and per-command coverage can expand without changing the site structure.
