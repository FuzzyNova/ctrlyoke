---
layout: home

hero:
  name: ctrlyoke
  text: One workflow engine for every CLI coding agent
  tagline: Prompt, steer, automate, and revisit every AI coding session — one prompt or a whole workflow.
  actions:
    - theme: brand
      text: Quick start
      link: /guide/quick-start
    - theme: alt
      text: Workflow schema
      link: /reference/workflow-schema
    - theme: alt
      text: GitHub
      link: https://github.com/FuzzyNova/ctrlyoke

features:
  - title: One workflow format
    details: Write workflows in YAML, JSON, or simple Markdown prompts. The same schema works across the extension and the standalone CLI.
  - title: Six harnesses
    details: Each CLI coding agent you run through ctrlyoke is a harness. Switch between Antigravity CLI, Claude Code, Codex CLI, Copilot CLI, OpenCode, and Qwen Code.
  - title: Validation and retries
    details: Gate prompts with end conditions, pre-conditions, and script steps so workflows can stop, continue, or retry based on real project output.
  - title: Stateful execution
    details: Resume sessions across steps, inject prior context, and let final steps extend the queue through the built-in ctrlyoke MCP server.
---

## What ctrlyoke is for

ctrlyoke gives you a better way to write prompts for any harness and to run them. You type a prompt in the dashboard's editor, and completions help you [reference the context it needs](/workflows/context-files): files, folders, symbols, editor selections, Git changes and earlier steps' output. ctrlyoke expands those references, sends the prompt to the harness you pick, and keeps the output, file changes and session history together.

ctrlyoke is not an AI agent and doesn't include one. It calls the harness CLIs you've installed and signed in to, and those keep talking to their own providers under your account. See [How ctrlyoke talks to a harness](/harnesses/#how-ctrlyoke-talks-to-a-harness).

It works the same way however much you send:

- **A single prompt**, the way you would use the harness on its own.
- **A workflow**: prompt and script steps run in order, each on any harness, with [end conditions](/workflows/end-conditions) that check the result before moving on.
- **A dynamic workflow**: a final step reviews the run and [queues more steps](/workflows/dynamic-queue) until the work is done, for example a plan–implement–review loop or a bug hunt that keeps going.

Save any of them as a YAML, JSON or Markdown file to run again, share, or run in CI.

It ships in two forms:

| Form              | What it is                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VS Code extension | Dashboard UI, prompt editor, embedded terminal, schema validation, and harness orchestration inside VS Code                                                             |
| `ctrlyoke` CLI    | Headless or interactive workflow execution from a terminal or CI job, and [`ctrlyoke server`](/cli/server), which opens the same dashboard in a browser without VS Code |

Both include a built-in MCP server, [`ctrlyoke-mcp`](/cli/ctrlyoke-mcp), and a set of built-in skills. A step that enables `ctrlyoke-mcp` can work on its own run: it can read earlier steps' output, [queue more steps](/workflows/dynamic-queue) (this is how a final step keeps a review or bug-hunt loop going), and coordinate with the other steps in its [parallel group](/workflows/parallel-steps).

## Where to start

- New here: [Installation](/guide/installation) and [Quick start](/guide/quick-start)
- Writing workflows: [Workflow overview](/workflows/) and [YAML format](/workflows/yaml-format)
- Choosing a harness: [Harness overview](/harnesses/)
- Looking up fields: [Workflow schema reference](/reference/workflow-schema)
